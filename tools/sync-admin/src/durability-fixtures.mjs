import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SYNC_SCHEMA_SQL } from '../../sync-server/dist/packages/core/src/index.js';
import { createSpaceQuotaResolver } from '../../sync-server/dist/tools/sync-server/src/storage-policy.js';
import { appendAudit } from '../dist/audit.js';
import { createAdminOperations } from '../dist/operations.js';

export const HANDLE = 'fixture-durability';
export const CLOCK = Date.parse('2026-10-04T00:00:00Z');
export function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dramatis-b15-'));
  const dataPath = join(dir, 'fixture.db'),
    backupPath = join(dir, 'backups'),
    auditPath = join(dir, 'audit.jsonl');
  fs.mkdirSync(backupPath);
  const db = new DatabaseSync(dataPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(SYNC_SCHEMA_SQL);
  db.exec(`INSERT INTO spaces VALUES ('${HANDLE}','fixture-hash','fixture-recovery','fixture-wrap','2026-01-01','fixture-epoch');
    CREATE TABLE account_profiles(space_handle TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,claimed_at TEXT,space_epoch TEXT);
    INSERT INTO account_profiles VALUES ('${HANDLE}','fixture-account','fixture-name','2026-01-01','fixture-epoch');`);
  createSpaceQuotaResolver(db);
  const f = { dir, dataPath, backupPath, auditPath, db };
  return {
    ...f,
    options: (extra = {}) => ({
      dataPath,
      backupPath,
      defaultMaxBytes: 96 * 1024 ** 2,
      now: () => CLOCK,
      audit: (event) => appendAudit(auditPath, event),
      ...extra,
    }),
    close() {
      db.close();
      cleanFixture(dir);
    },
  };
}
export function openOperations(f, extra = {}) {
  return createAdminOperations(f.options(extra));
}
export function prepare(ops) {
  return ops.prepare({ spaceHandle: HANDLE, membership: { action: 'purchase', planId: 'vip-month-256' } });
}
export function commit(ops, preview) {
  return ops.commit({ confirmationId: preview.confirmationId, confirmSpaceHandle: HANDLE });
}
export function events(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
export function assertLedger(db, count) {
  for (const table of [
    'space_memberships',
    'membership_events',
    'membership_purchases',
    'api_balance_events',
    'api_accounts',
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count, table);
  }
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
}
export function cleanFixture(dir) {
  const target = resolve(dir),
    parent = resolve(tmpdir());
  assert.ok(target.startsWith(parent + sep));
  assert.match(target.slice(parent.length), /dramatis-b15-/);
  fs.rmSync(target, { recursive: true, force: true });
}
/** Patch actual Node builtins for fault injection; production code has no test-only bypass. */
export function withFs(overrides, run) {
  const before = {};
  for (const [name, wrapper] of Object.entries(overrides)) {
    before[name] = fs[name];
    fs[name] = wrapper(fs[name]);
  }
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    for (const [name, fn] of Object.entries(before)) fs[name] = fn;
    syncBuiltinESMExports();
  }
}
export function withSql(overrides, run) {
  const before = {};
  for (const [name, wrapper] of Object.entries(overrides)) {
    before[name] = DatabaseSync.prototype[name];
    DatabaseSync.prototype[name] = wrapper(before[name]);
  }
  try {
    return run();
  } finally {
    Object.assign(DatabaseSync.prototype, before);
  }
}
export const diskError = (code) => Object.assign(new Error(`fixture-${code}`), { code });
