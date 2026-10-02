#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'dist',
  'tools',
  'sync-server',
  'src',
  'gateway-main.js',
);
if (!existsSync(entry)) {
  process.stderr.write('Compile first: pnpm build:sync-server\n');
  process.exit(1);
}
const { runGateway } = await import(pathToFileURL(entry).href);
await runGateway();
