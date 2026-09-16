#!/usr/bin/env node
/**
 * Dramatis 桌面启动器。
 *
 * 做三件事：起本地服务 → 等它真的能连上 → 用一个没有浏览器边框的窗口打开。
 *
 * 为什么不用 Tauri：那需要 Rust 工具链，而当前的需求只是「方便测试」。
 * Chromium 的 --app 模式已经能给出独立窗口与任务栏图标，成本为零。
 * 等真的需要常驻后台任务或 OS 级密钥存储时，再上 P2-9 的壳也不迟。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const WEB_APP_DIR = resolve(REPO_ROOT, 'apps', 'web');

/**
 * 直接调用 Vite 的 CLI，而不是 `pnpm --filter ... dev -- --port`。
 *
 * pnpm 会把 `--` 原样当成参数传给 Vite，导致端口与 host 全被忽略，
 * Vite 于是悄悄用了默认的 5173 —— 而换个端口就等于换了一个空数据库。
 */
function resolveViteBin() {
  // 不能走 require.resolve('vite/bin/vite.js')：Vite 的 exports 字段不允许解析包内路径
  const candidates = [
    resolve(WEB_APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
    resolve(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Vite 的 CLI 入口，请先运行 pnpm install');
}

function spawnVite(extraArgs, options = {}) {
  return spawn(process.execPath, [resolveViteBin(), ...extraArgs], {
    cwd: WEB_APP_DIR,
    stdio: 'inherit',
    ...options,
  });
}

const HOST = '127.0.0.1';
/**
 * 端口是固定的，且不允许 Vite 自动换端口。
 *
 * 原因：IndexedDB 按「源」隔离，端口变了就是另一个源，用户会以为数据丢了。
 * 所以宁可启动失败，也不要静默换到别的端口上开一个空数据库。
 */
const PORT = Number(process.env.DRAMATIS_PORT ?? 5273);
const ORIGIN = `http://${HOST}:${PORT}`;

const args = new Set(process.argv.slice(2));
const shouldOpen = !args.has('--no-open') && process.env.DRAMATIS_NO_OPEN !== '1';
const useProductionBuild = args.has('--prod');

const WINDOWS_BROWSERS = [
  process.env['ProgramFiles'] && `${process.env['ProgramFiles']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env['ProgramFiles'] && `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env['LOCALAPPDATA'] && `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
];

function findBrowser() {
  if (process.platform !== 'win32') return null;
  for (const candidate of WINDOWS_BROWSERS) {
    if (typeof candidate === 'string' && existsSync(candidate)) return candidate;
  }
  return null;
}

async function isServing(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServing(url)) return true;
    await delay(400);
  }
  return false;
}

function openWindow(url) {
  const browser = findBrowser();

  if (browser !== null) {
    // --app 会开一个没有地址栏与标签页的独立窗口，外观与桌面应用一致
    const child = spawn(browser, [`--app=${url}`, '--window-size=1360,900'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return `已在 ${browser.split('\\').pop()} 的应用窗口中打开`;
  }

  const opener =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
  child.unref();
  return '已用系统默认浏览器打开（没找到 Edge 或 Chrome，无法使用应用窗口模式）';
}

async function main() {
  console.log('Dramatis · 登场');
  console.log(`地址：${ORIGIN}`);
  console.log(`数据保存在这个地址下（换端口等于换一个空数据库，所以端口是固定的）\n`);

  if (await isServing(ORIGIN)) {
    console.log('这个地址上已经有一个实例在跑了，直接打开它。');
    if (shouldOpen) console.log(openWindow(ORIGIN));
    return;
  }

  if (useProductionBuild) {
    console.log('先构建生产版本……');
    const build = spawnVite(['build']);
    const code = await new Promise((done) => build.on('exit', done));
    if (code !== 0) {
      console.error('构建失败，先把上面的错误解决掉。');
      process.exitCode = 1;
      return;
    }
  }

  const serverArgs = useProductionBuild
    ? ['preview', '--host', HOST, '--port', String(PORT), '--strictPort']
    : ['--host', HOST, '--port', String(PORT), '--strictPort'];

  console.log(`启动 ${useProductionBuild ? 'preview' : 'dev'} 服务……`);
  const server = spawnVite(serverArgs);

  const stop = () => {
    if (!server.killed) server.kill();
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });

  server.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });

  if (!(await waitForServer(ORIGIN))) {
    console.error(`\n等了 90 秒还是连不上 ${ORIGIN}。`);
    console.error('常见原因：端口被别的程序占了（Vite 会直接报错），或者依赖还没装（先跑 pnpm install）。');
    stop();
    process.exitCode = 1;
    return;
  }

  console.log(`\n服务已就绪：${ORIGIN}`);
  if (shouldOpen) {
    console.log(openWindow(ORIGIN));
    console.log('\n关掉应用窗口不会停止服务；在这个终端按 Ctrl+C 才是关闭。');
  } else {
    console.log('（--no-open：只起服务，不打开窗口）');
  }
}

await main();
