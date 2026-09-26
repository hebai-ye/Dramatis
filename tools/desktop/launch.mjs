#!/usr/bin/env node
/**
 * Dramatis 桌面启动器。
 *
 * 做三件事：起本地服务 → 等它真的能连上 → 用一个没有浏览器边框的窗口打开。
 *
 * 为什么不用 Tauri：那需要 Rust 工具链，而当前的需求只是「方便测试」。
 * Chromium 的 --app 模式已经能给出独立窗口与任务栏图标，成本为零。
 * 等真的需要常驻后台任务或 OS 级密钥存储时，再上 P2-9 的壳也不迟。
 *
 * 这条判断在 2026-09-20 复核过一次，四份证据见 docs/DESKTOP.md：
 * 后台队列确实只在页面活着时推进（关掉 22 秒一动不动、开着 14 秒就跑完），
 * 但它本来就是可恢复的（重新打开后把 running 的任务捡回来接着做）——
 * 所以代价是「慢一点」，而不是「丢一轮」。剩下的三个触发条件也都没成立：
 * OS 级密钥存储没有浏览器入口（但可以用口令加密替代）、本地模型走 HTTP 就能连、
 * 文件夹监控这一代的 Chrome 有 FileSystemObserver。结论：Tauri 不触发，
 * 补强启动器 + 支持装成 PWA。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
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
const PORT = parseDramatisPort(process.env.DRAMATIS_PORT);

/** 校验 DRAMATIS_PORT（审计 C20）：必须是 1-65535 的整数，否则直接报错退出。 */
function parseDramatisPort(raw) {
  if (raw === undefined || raw.trim() === '') return 5273;
  const text = raw.trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < 1 || value > 65535) {
    process.stderr.write(`DRAMATIS_PORT 必须是 1-65535 的整数，收到的是「${raw}」。
`);
    process.exit(1);
  }
  return value;
}
const ORIGIN = `http://${HOST}:${PORT}`;

const args = new Set(process.argv.slice(2));
const shouldOpen = !args.has('--no-open') && process.env.DRAMATIS_NO_OPEN !== '1';
const useProductionBuild = args.has('--prod');
const forceBuild = args.has('--force-build');

const WINDOWS_BROWSERS = [
  process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env.ProgramFiles && `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
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

/**
 * 生产构建是不是已经是最新的。
 *
 * 每天用这个壳的人不希望每次双击都等一遍构建。判据是「构建产物的时间」比
 * 「所有源码里最新的那个文件」还新——够糙，但方向总是安全的：
 * 拿不准就重构建，绝不会拿旧产物当新的用。
 */
function productionBuildIsFresh() {
  const indexPath = resolve(WEB_APP_DIR, 'dist', 'index.html');
  if (!existsSync(indexPath)) return false;

  const builtAt = statSync(indexPath).mtimeMs;
  const watch = [resolve(WEB_APP_DIR, 'src'), resolve(REPO_ROOT, 'packages', 'core', 'src')];
  const extraFiles = [
    resolve(WEB_APP_DIR, 'index.html'),
    resolve(WEB_APP_DIR, 'vite.config.ts'),
    resolve(WEB_APP_DIR, 'package.json'),
    resolve(REPO_ROOT, 'packages', 'core', 'package.json'),
  ];

  const newest = (dir) => {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) latest = Math.max(latest, newest(full));
      else if (entry.isFile()) latest = Math.max(latest, statSync(full).mtimeMs);
    }
    return latest;
  };

  for (const dir of watch) {
    if (!existsSync(dir)) continue;
    if (newest(dir) > builtAt) return false;
  }
  for (const file of extraFiles) {
    if (!existsSync(file)) continue;
    if (statSync(file).mtimeMs > builtAt) return false;
  }
  return true;
}

async function main() {
  console.log('Dramatis · 登场');
  console.log(`地址：${ORIGIN}`);
  console.log(`数据保存在这个地址下（换端口等于换一个空数据库，所以端口是固定的）\n`);

  // 依赖没装时给出可执行的命令，而不是让 Vite 抛一堆解析错误
  if (!existsSync(resolve(WEB_APP_DIR, 'node_modules'))) {
    console.error('还没安装依赖。在项目目录里执行其中一条：');
    console.error('  npx --yes pnpm install');
    console.error('  corepack enable && pnpm install');
    process.exitCode = 1;
    return;
  }

  if (await isServing(ORIGIN)) {
    console.log('这个地址上已经有一个实例在跑了，直接打开它。');
    if (shouldOpen) console.log(openWindow(ORIGIN));
    return;
  }

  if (useProductionBuild) {
    if (!forceBuild && productionBuildIsFresh()) {
      console.log('构建产物是最新的，跳过构建（想看一遍构建过程就加 --force-build）。');
    } else {
      console.log('先构建生产版本……');
      const build = spawnVite(['build']);
      const code = await new Promise((done) => build.on('exit', done));
      if (code !== 0) {
        console.error('构建失败，先把上面的错误解决掉。');
        process.exitCode = 1;
        return;
      }
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
    const browser = findBrowser();
    console.log(
      browser !== null
        ? `检测到可用于应用窗口的浏览器：${browser}`
        : '没有找到 Edge 或 Chrome，正式启动时会退回系统默认浏览器（没有独立窗口效果）',
    );
  }
}

await main();
