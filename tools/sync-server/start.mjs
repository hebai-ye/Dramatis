#!/usr/bin/env node
/**
 * 同步服务端的启动入口。
 *
 * 为什么不让 systemd 直接指向编译产物：tsc 是按仓库根目录的结构输出的
 * （`dist/tools/sync-server/src/main.js`，因为要一起编译 core 的源码），
 * 路径又长又依赖目录结构。这里包一层，运维侧只需要记 `node start.mjs`。
 *
 * 先跑 `pnpm build:sync-server` 生成 dist。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'dist', 'tools', 'sync-server', 'src', 'main.js');

if (!existsSync(entry)) {
  process.stderr.write('还没有编译产物，请先在仓库根目录运行：pnpm build:sync-server\n');
  process.exit(1);
}

// Windows 与 Linux 都必须用 file:// URL：ESM 的 import 不接受裸的绝对路径
await import(pathToFileURL(entry).href);
