import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
let runner;
let interrupted;
let interrupt;
let deadline;
const interruption = new Promise((_, reject) => {
  interrupt = reject;
});
interruption.catch(() => undefined);
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

function waitForExit(child, duration) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, duration);
    function onExit() {
      clearTimeout(timer);
      resolveExit(true);
    }
    child.once('exit', onExit);
  });
}

async function stopOwnedRunner() {
  if (!runner?.pid || exited(runner)) return true;
  runner.kill('SIGTERM');
  if (await waitForExit(runner, 3_000)) return true;
  runner.kill('SIGKILL');
  if (await waitForExit(runner, 2_000)) return true;
  console.error(`Owned SW Playwright process ${runner.pid} did not exit within its cleanup bound`);
  return false;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = signal;
    interrupt(new Error(`Interrupted by ${signal}`));
  });
}

try {
  if (process.env.SW_BROWSER_CANDIDATE !== '1') {
    throw new Error('SW_BROWSER_CANDIDATE=1 is required after root reviews the final worker and CacheStorage contract');
  }
  // Keep diagnostic capture disabled even when selecting individual cases.
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (['-g', '--grep', '--grep-invert'].includes(args[i])) {
      if (!args[++i]) throw new Error('A grep expression is required');
    } else if (!['--headed', '--list'].includes(args[i])) {
      throw new Error(`Unsupported SW runner argument: ${args[i]}`);
    }
  }
  const completion = new Promise((resolveExit, reject) => {
    runner = spawn(
      process.execPath,
      [resolve(testsDir, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'sw-playwright.config.ts', ...args],
      {
        cwd: testsDir,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    runner.once('error', reject);
    runner.once('exit', (code) => resolveExit(code ?? 1));
  });
  deadline = setTimeout(
    () => interrupt(new Error('SW browser suite exceeded its six-minute owned-runner deadline')),
    360_000,
  );
  process.exitCode = await Promise.race([completion, interruption]);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try {
    if (!(await stopOwnedRunner())) process.exitCode = 1;
    else if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
