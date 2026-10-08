import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLedger, commit, events, fixture, openOperations } from './durability-fixtures.mjs';

async function killAt(dir, phase) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./durability-worker.mjs', import.meta.url)), dir, phase],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let output = '';
  child.stderr.on('data', (part) => {
    output += part;
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`fixture timed out: ${output}`));
    }, 10000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.ok(result.code !== 0 || result.signal !== null, output);
  assert.equal(fs.readFileSync(join(dir, 'reached'), 'utf8'), phase, output);
}
for (const phase of [
  'before-backup-publish',
  'after-backup',
  'during-audit-write',
  'after-intent',
  'after-membership',
  'after-credit',
  'after-commit',
  'after-result-audit',
]) {
  test(`B15强杀进程：${phase}恢复后账本全有或全无、原票据重放不再发放`, async () => {
    const f = fixture();
    let ops;
    try {
      assert.equal(f.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      await killAt(f.dir, phase);
      const saved = ['after-commit', 'after-result-audit'].includes(phase) ? 1 : 0;
      const preview = JSON.parse(fs.readFileSync(join(f.dir, 'preview.json'), 'utf8'));
      const hash = createHash('sha256').update(preview.confirmationId).digest('hex');
      assertLedger(f.db, saved);
      const backupFiles = fs.readdirSync(f.backupPath);
      assert.equal(backupFiles.length, 1);
      const snapshot = new DatabaseSync(join(f.backupPath, backupFiles[0]), { readOnly: true });
      try {
        assertLedger(snapshot, 0);
      } finally {
        snapshot.close();
      }
      ops = openOperations(f);
      if (phase === 'during-audit-write') {
        const broken = fs.readFileSync(f.auditPath);
        assert.throws(() => commit(ops, preview), { code: 'audit-failed', confirmationHash: hash });
        assert.deepEqual(fs.readFileSync(f.auditPath), broken);
      } else {
        const before = events(f.auditPath);
        const intent = before.find((e) => e.action.endsWith('-intent'));
        if (!['before-backup-publish', 'after-backup'].includes(phase)) {
          assert.equal(intent.operationId, preview.operationId);
          assert.equal(intent.confirmationHash, hash);
          assert.equal(intent.backupFile, backupFiles[0]);
        }
        assert.equal(
          before.filter((e) => e.action.endsWith('-applied')).length,
          phase === 'after-result-audit' ? 1 : 0,
        );
        assert.throws(() => commit(ops, preview), { code: 'confirmation-invalid', confirmationHash: hash });
        const replay = events(f.auditPath).at(-1);
        assert.equal(replay.action, 'confirmation-rejected');
        assert.equal(replay.confirmationHash, hash);
      }
      assertLedger(f.db, saved);
      if (saved) {
        assert.equal(
          f.db.prepare('SELECT operation_id FROM membership_purchases').get().operation_id,
          preview.operationId,
        );
        assert.equal(f.db.prepare('SELECT amount_nanoyuan FROM api_balance_events').get().amount_nanoyuan, 5000000000);
      }
    } finally {
      ops?.close();
      f.close();
    }
  });
}
