#!/usr/bin/env node
/**
 * 备份脚本：把 SQLite 数据库快照成一个文件，并删掉太旧的备份。
 *
 * 用 `VACUUM INTO` 而不是直接复制文件：服务在跑的时候直接 copy 有可能拿到
 * 半写状态（SQLite 的 WAL 还没落盘），`VACUUM INTO` 是在线快照。
 *
 * 用法：node backup.mjs <数据库> <备份目录> [保留份数，默认 30]
 * （crontab 的具体写法见 tools/sync-server/README.md 第 6 节——这里不写 cron 表达式，
 *   因为 `星号斜杠` 在块注释里会提前把注释结束掉。）
 *
 * 备份出来的是密文：即使有人拿到备份，没有同步密码也解不开。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const [dbPathArg, outDirArg, keepArg] = process.argv.slice(2);
if (dbPathArg === undefined || outDirArg === undefined) {
  process.stderr.write('用法：node backup.mjs <数据库路径> <备份目录> [保留份数]\n');
  process.exit(1);
}

const dbPath = resolve(dbPathArg);
const outDir = resolve(outDirArg);
const keep = Number(keepArg ?? '30');
// 审计 C16：keep=0 / 负数 / 非整数会把刚做好的这一份也删掉，一律拒绝
if (!Number.isInteger(keep) || keep < 1) {
  process.stderr.write(`保留份数必须是 >= 1 的整数（收到：${String(keepArg)}）\n`);
  process.exit(1);
}

if (!existsSync(dbPath)) {
  process.stderr.write(`找不到数据库：${dbPath}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(outDir, `${basename(dbPath)}.${stamp}.bak`);

const db = new DatabaseSync(dbPath);
/*
 * 撞上锁时等 5 秒再放弃（顺序 61）。服务端现在开着 WAL，读写能并行；
 * `VACUUM INTO` 是读事务，但**别的写事务**仍可能正好占着排他锁，
 * 默认的 busy_timeout 是 0——那一刻备份会直接失败，而不是等一下。
 */
db.exec('PRAGMA busy_timeout = 5000;');
// VACUUM INTO 要求目标文件不存在
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

process.stdout.write(`已备份到 ${target}（${String(statSync(target).size)} 字节）\n`);

const backups = readdirSync(outDir)
  .filter((name) => name.startsWith(`${basename(dbPath)}.`) && name.endsWith('.bak'))
  .sort();
for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
  rmSync(join(outDir, stale), { force: true });
  process.stdout.write(`已删除旧备份 ${stale}\n`);
}
