/** Test-only fault worker. Receives only a freshly created fixture directory and a named checkpoint. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendAudit } from '../dist/audit.js';
import { createAdminOperations } from '../dist/operations.js';
import { CLOCK, commit, prepare } from './durability-fixtures.mjs';

const [raw, phase] = process.argv.slice(2);
const dir = resolve(raw);
if (!dir.startsWith(resolve(tmpdir()) + sep) || !basename(dir).startsWith('dramatis-b15-'))
  throw new Error('invalid fixture root');
const phases = new Set([
  'before-backup-publish',
  'after-backup',
  'during-audit-write',
  'after-intent',
  'after-membership',
  'after-credit',
  'after-commit',
  'after-result-audit',
]);
if (!phases.has(phase)) throw new Error('invalid checkpoint');
const nativeWrite = fs.writeFileSync;
function crash() {
  nativeWrite(join(dir, 'reached'), phase);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('fixture SIGKILL did not terminate');
}
const ops = createAdminOperations({
  dataPath: join(dir, 'fixture.db'),
  backupPath: join(dir, 'backups'),
  defaultMaxBytes: 96 * 1024 ** 2,
  now: () => CLOCK,
  audit(event) {
    if (phase === 'after-backup' && event.action.endsWith('-intent')) crash();
    appendAudit(join(dir, 'audit.jsonl'), event);
    if (phase === 'after-intent' && event.action.endsWith('-intent')) crash();
    if (phase === 'after-result-audit' && event.action.endsWith('-applied')) crash();
  },
});
const preview = prepare(ops);
nativeWrite(join(dir, 'preview.json'), JSON.stringify(preview));
const nativeRename = fs.renameSync;
fs.renameSync = (...args) => {
  if (phase === 'before-backup-publish') crash();
  return nativeRename(...args);
};
fs.writeFileSync = (fd, text, options) => {
  if (phase === 'during-audit-write' && typeof fd === 'number') {
    nativeWrite(fd, text.slice(0, 12), options);
    crash();
  }
  return nativeWrite(fd, text, options);
};
syncBuiltinESMExports();
const nativeExec = DatabaseSync.prototype.exec,
  nativePrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.exec = function (sql) {
  const result = nativeExec.call(this, sql);
  if (phase === 'after-commit' && sql === 'COMMIT') crash();
  return result;
};
DatabaseSync.prototype.prepare = function (sql) {
  const statement = nativePrepare.call(this, sql);
  return {
    all: (...args) => statement.all(...args),
    get: (...args) => statement.get(...args),
    run: (...args) => {
      const result = statement.run(...args);
      if (phase === 'after-membership' && sql.startsWith('INSERT INTO membership_events')) crash();
      if (phase === 'after-credit' && sql.startsWith('INSERT INTO api_balance_events')) crash();
      return result;
    },
  };
};
commit(ops, preview);
throw new Error('fixture checkpoint not reached');
