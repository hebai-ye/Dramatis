import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { appendAudit } from '../dist/audit.js';
import { backupBeforeChange } from '../dist/backup.js';
import { syncParentDirectory } from '../dist/durability.js';
import { createAdminHandler } from '../dist/http.js';
import { AdminOperationError } from '../dist/operations.js';
import {
  assertLedger,
  commit,
  diskError,
  events,
  fixture,
  HANDLE,
  openOperations,
  prepare,
  withFs,
  withSql,
} from './durability-fixtures.mjs';

test('B15：备份校验→partial刷盘→发布→成品刷盘→可用目录屏障之后才写意图与开事务', () => {
  const f = fixture(),
    order = [],
    fds = new Map();
  const nativeFsync = fs.fsyncSync;
  let ops;
  try {
    withFs(
      {
        openSync:
          (original) =>
          (...args) => {
            const fd = original(...args);
            fds.set(fd, String(args[0]));
            return fd;
          },
        fsyncSync: () => (fd) => {
          order.push(`fsync:${fds.get(fd)}`);
          nativeFsync(fd);
        },
        renameSync: (original) => (a, b) => {
          order.push('publish');
          return original(a, b);
        },
      },
      () =>
        withSql(
          {
            exec: (original) =>
              function (sql) {
                if (sql === 'BEGIN IMMEDIATE') order.push('begin');
                return original.call(this, sql);
              },
          },
          () => {
            ops = openOperations(f, {
              audit: (event) => {
                appendAudit(f.auditPath, event);
                order.push(event.action);
              },
            });
            commit(ops, prepare(ops));
          },
        ),
    );
    const partial = order.findIndex((x) => x.endsWith('.bak.partial'));
    const published = order.indexOf('publish');
    const full = order.findIndex((x) => x.endsWith('.bak'));
    const intent = order.indexOf('membership-purchase-intent'),
      begin = order.indexOf('begin');
    assert.ok(partial >= 0 && partial < published && published < full && full < intent && intent < begin);
    if (process.platform !== 'win32') assert.ok(order.indexOf(`fsync:${f.backupPath}`) < intent);
    else assert.equal(syncParentDirectory(f.auditPath), 'unsupported');
    assertLedger(f.db, 1);
  } finally {
    ops?.close();
    f.close();
  }
});

for (const [phase, code] of [
  ['partial', 'ENOSPC'],
  ['partial', 'EIO'],
  ['published', 'EIO'],
  ['rename', 'EACCES'],
]) {
  test(`B15：备份${phase}/${code}失败不提交，原库与残留快照保留`, () => {
    const f = fixture(),
      fds = new Map();
    const ops = openOperations(f);
    const p = prepare(ops);
    try {
      withFs(
        {
          openSync:
            (original) =>
            (...args) => {
              const fd = original(...args);
              fds.set(fd, String(args[0]));
              return fd;
            },
          fsyncSync: (original) => (fd) => {
            const path = fds.get(fd) ?? '';
            if ((phase === 'partial' && path.endsWith('.partial')) || (phase === 'published' && path.endsWith('.bak')))
              throw diskError(code);
            return original(fd);
          },
          renameSync:
            (original) =>
            (...args) => {
              if (phase === 'rename') throw diskError(code);
              return original(...args);
            },
        },
        () => assert.throws(() => commit(ops, p), { code: 'backup-failed', operationId: p.operationId }),
      );
      assertLedger(f.db, 0);
      assert.ok(fs.readdirSync(f.backupPath).length > 0);
      assert.deepEqual(events(f.auditPath), []);
    } finally {
      ops.close();
      f.close();
    }
  });
}

for (const phase of ['vacuum', 'quick-check']) {
  test(`B15：${phase}故障保留失败快照、不追加意图、不写业务表`, () => {
    const f = fixture(),
      ops = openOperations(f),
      p = prepare(ops);
    try {
      withSql(
        {
          exec: (original) =>
            function (sql) {
              if (phase === 'vacuum' && sql.startsWith('VACUUM INTO ')) {
                const path = sql.slice(13, -1).replaceAll("''", "'");
                fs.writeFileSync(path, 'fixture-partial');
                throw diskError('ENOSPC');
              }
              return original.call(this, sql);
            },
          prepare: (original) =>
            function (sql) {
              const statement = original.call(this, sql);
              if (phase === 'quick-check' && sql === 'PRAGMA quick_check')
                return { all: () => [{ quick_check: 'fixture-corrupt' }] };
              return statement;
            },
        },
        () => assert.throws(() => commit(ops, p), { code: 'backup-failed' }),
      );
      assertLedger(f.db, 0);
      assert.equal(fs.readdirSync(f.backupPath).length, 1);
      assert.deepEqual(events(f.auditPath), []);
    } finally {
      ops.close();
      f.close();
    }
  });
}

test('B15：目录刷盘故障在支持平台失败关闭；Windows明确返回不支持且文件刷盘仍强制', () => {
  const f = fixture();
  try {
    if (process.platform === 'win32') {
      assert.equal(syncParentDirectory(f.auditPath), 'unsupported');
      return;
    }
    const fds = new Map();
    withFs(
      {
        openSync:
          (fn) =>
          (...args) => {
            const fd = fn(...args);
            fds.set(fd, args[0]);
            return fd;
          },
        fsyncSync: (fn) => (fd) => {
          if (fds.get(fd) === f.backupPath) throw diskError('EIO');
          return fn(fd);
        },
      },
      () => assert.throws(() => backupBeforeChange(f.db, f.dataPath, f.backupPath), { code: 'EIO' }),
    );
    assertLedger(f.db, 0);
  } finally {
    f.close();
  }
});

test('B15：意图审计fsync真实故障不写业务数据，并保留备份', () => {
  const f = fixture(),
    ops = openOperations(f),
    p = prepare(ops),
    fds = new Map();
  try {
    withFs(
      {
        openSync:
          (fn) =>
          (...args) => {
            const fd = fn(...args);
            fds.set(fd, args[0]);
            return fd;
          },
        fsyncSync: (fn) => (fd) => {
          if (fds.get(fd) === f.auditPath) throw diskError('EIO');
          return fn(fd);
        },
      },
      () => assert.throws(() => commit(ops, p), { code: 'audit-failed', operationId: p.operationId }),
    );
    assertLedger(f.db, 0);
    assert.equal(fs.readdirSync(f.backupPath).length, 1);
  } finally {
    ops.close();
    f.close();
  }
});

test('B15：审计短写/ENOSPC保留破损尾部，后续追加拒绝而非截断或拼坏新事件', () => {
  const f = fixture(),
    ops = openOperations(f),
    p = prepare(ops);
  const nativeWrite = fs.writeFileSync;
  try {
    withFs(
      {
        writeFileSync: () => (fd, data, options) => {
          nativeWrite(fd, data.slice(0, 12), options);
          throw diskError('ENOSPC');
        },
      },
      () => assert.throws(() => commit(ops, p), { code: 'audit-failed' }),
    );
    const broken = fs.readFileSync(f.auditPath);
    assert.throws(() => appendAudit(f.auditPath, { action: 'fixture', status: 200, durationMs: 0 }), /末尾不完整/);
    assert.deepEqual(fs.readFileSync(f.auditPath), broken);
    assertLedger(f.db, 0);
  } finally {
    ops.close();
    f.close();
  }
});

test('B15：BEGIN被真实SQLite写锁拒绝，也生成关联的rejected审计且不伪称已回滚', () => {
  const f = fixture();
  const locker = new DatabaseSync(f.dataPath);
  let locked = false,
    ops;
  try {
    withSql(
      {
        exec: (original) =>
          function (sql) {
            return original.call(this, sql.replace('busy_timeout=5000', 'busy_timeout=20'));
          },
      },
      () => {
        ops = openOperations(f, {
          audit: (event) => {
            appendAudit(f.auditPath, event);
            if (event.action.endsWith('-intent')) {
              locker.exec('BEGIN IMMEDIATE');
              locked = true;
            }
          },
        });
        const p = prepare(ops);
        assert.throws(
          () => commit(ops, p),
          (error) =>
            error.code === 'change-failed' && error.operationId === p.operationId && error.message.includes('未能开启'),
        );
        const log = events(f.auditPath);
        assert.deepEqual(
          log.map((e) => e.action),
          ['membership-purchase-intent', 'membership-purchase-rejected'],
        );
        assert.equal(log[0].operationId, log[1].operationId);
        assert.equal(log[0].confirmationHash, log[1].confirmationHash);
      },
    );
    locker.exec('ROLLBACK');
    locked = false;
    assertLedger(f.db, 0);
  } finally {
    if (locked) locker.exec('ROLLBACK');
    locker.close();
    ops?.close();
    f.close();
  }
});

test('B15：真实SQLite页容量耗尽不得只保存会员而丢失购买/额度', () => {
  const f = fixture(),
    ops = openOperations(f);
  let full = false;
  try {
    f.db.exec(
      `CREATE TABLE fixture_pad(data BLOB); CREATE TRIGGER fixture_full BEFORE INSERT ON membership_purchases BEGIN INSERT INTO fixture_pad VALUES(zeroblob(1048576)); END;`,
    );
    const pages = f.db.prepare('PRAGMA page_count').get().page_count;
    withSql(
      {
        exec: (original) =>
          function (sql) {
            if (sql === 'BEGIN IMMEDIATE') original.call(this, `PRAGMA max_page_count=${pages}`);
            try {
              return original.call(this, sql);
            } catch (e) {
              if (/full/i.test(e.message)) full = true;
              throw e;
            }
          },
        prepare: (original) =>
          function (sql) {
            const statement = original.call(this, sql);
            return {
              all: (...a) => statement.all(...a),
              get: (...a) => statement.get(...a),
              run: (...a) => {
                try {
                  return statement.run(...a);
                } catch (e) {
                  if (/full/i.test(e.message)) full = true;
                  throw e;
                }
              },
            };
          },
      },
      () =>
        assert.throws(
          () => commit(ops, prepare(ops)),
          (e) => ['change-failed', 'change-uncertain'].includes(e.code),
        ),
    );
    assert.equal(full, true);
    assertLedger(f.db, 0);
  } finally {
    ops.close();
    f.close();
  }
});

test('B15：COMMIT已生效但返回异常且无法回滚，返回unknown并关闭写连接，不谎报未提交', () => {
  const f = fixture(),
    ops = openOperations(f),
    p = prepare(ops);
  let failure;
  try {
    withSql(
      {
        exec: (original) =>
          function (sql) {
            const result = original.call(this, sql);
            if (sql === 'COMMIT') throw diskError('EIO');
            return result;
          },
      },
      () => {
        try {
          commit(ops, p);
        } catch (e) {
          failure = e;
        }
      },
    );
    assert.equal(failure.code, 'change-uncertain');
    assert.equal(failure.operationId, p.operationId);
    assertLedger(f.db, 1);
    assert.throws(() => prepare(ops), { code: 'operations-closed' });
    assert.equal(events(f.auditPath).at(-1).action, 'membership-purchase-uncertain');
  } finally {
    ops.close();
    f.close();
  }
});

test('B15：预览、意图、购买账本、结果与重开后的原票据通过操作号/哈希关联，无原始票据泄露', () => {
  const f = fixture();
  let ops = openOperations(f);
  try {
    const p = prepare(ops),
      result = commit(ops, p),
      hash = createHash('sha256').update(p.confirmationId).digest('hex');
    assert.equal(result.operationId, p.operationId);
    assert.equal(result.confirmationHash, hash);
    ops.close();
    ops = openOperations(f);
    assert.throws(() => commit(ops, p), { code: 'confirmation-invalid', confirmationHash: hash });
    const log = events(f.auditPath);
    assert.deepEqual(
      log.map((e) => e.action),
      ['membership-purchase-intent', 'membership-purchase-applied', 'confirmation-rejected'],
    );
    assert.ok(log.every((e) => e.confirmationHash === hash));
    assert.equal(log[0].operationId, p.operationId);
    assert.equal(log[1].operationId, p.operationId);
    assert.equal(f.db.prepare('SELECT operation_id FROM membership_purchases').get().operation_id, p.operationId);
    assert.equal(
      f.db.prepare('SELECT source_operation_id FROM api_balance_events').get().source_operation_id,
      p.operationId,
    );
    assert.ok(!fs.readFileSync(f.auditPath, 'utf8').includes(p.confirmationId));
    assertLedger(f.db, 1);
  } finally {
    ops.close();
    f.close();
  }
});

test('B15：HTTP不确定结果保留安全关联字段，不泄漏票据、SQL或文件路径', async () => {
  const token = 'fixture-admin-proof-012345678901234567890123456789';
  const error = new AdminOperationError(503, 'change-uncertain', 'fixture unknown');
  error.operationId = 'fixture-operation';
  error.confirmationHash = 'a'.repeat(64);
  const handler = createAdminHandler({
    token,
    port: 8788,
    store: {},
    assets: { html: '', js: '', css: '' },
    audit() {},
    backupStatus: () => ({ available: false, files: [] }),
    syncHealth: async () => ({ ok: true }),
    operations: {
      commit() {
        throw error;
      },
    },
  });
  const response = await handler(
    new Request('http://127.0.0.1:8788/api/changes/commit', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8788',
        origin: 'http://127.0.0.1:8788',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmationId: 'private-fixture-ticket', confirmSpaceHandle: HANDLE }),
    }),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.operationId, error.operationId);
  assert.equal(body.confirmationHash, error.confirmationHash);
  assert.ok(!JSON.stringify(body).includes('private-fixture-ticket'));
});
