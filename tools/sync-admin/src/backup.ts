import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 唯一文件名、独立目标目录；只返回文件名，没有网页下载能力。 */
export function backupBeforeChange(db: DatabaseSync, dataPath: string, directory: string) {
  const targetDirectory = resolve(directory);
  const stat = lstatSync(targetDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份目录无效。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${basename(dataPath)}.${stamp}.${randomUUID()}.bak`;
  const target = join(targetDirectory, file);
  const partial = `${target}.partial`;
  if (target.toLowerCase() === resolve(dataPath).toLowerCase() || existsSync(target) || existsSync(partial)) {
    throw new Error('备份目标无效。');
  }
  db.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
  const snapshot = new DatabaseSync(partial, { readOnly: true });
  try {
    const checks = snapshot.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
    if (checks.length !== 1 || Object.values(checks[0] ?? {})[0] !== 'ok') throw new Error('备份校验失败。');
  } finally {
    snapshot.close();
  }
  renameSync(partial, target);
  return file;
}
