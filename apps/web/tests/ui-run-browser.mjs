import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(testsDir, '..');
const vite = spawn(
  process.execPath,
  [resolve(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '6287', '--strictPort'],
  {
    cwd: webDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let runner;
let interrupted;
let interrupt;
let cancelStartup;
const interruption = new Promise((_, reject) => {
  interrupt = reject;
});
interruption.catch(() => {});
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
function waitForExit(child, duration) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, duration);
    function onExit() {
      clearTimeout(timeout);
      resolveExit(true);
    }
    child.once('exit', onExit);
  });
}
async function stopOwned(child, label) {
  if (!child?.pid || exited(child)) return true;
  try {
    child.kill('SIGTERM');
  } catch (error) {
    console.error(error);
  }
  if (await waitForExit(child, 3_000)) return true;
  try {
    child.kill('SIGKILL');
  } catch (error) {
    console.error(error);
  }
  if (await waitForExit(child, 2_000)) return true;
  console.error(`Owned ${label} process ${child.pid} did not exit after termination signals`);
  return false;
}
vite.stdout.pipe(process.stdout);
vite.stderr.pipe(process.stderr);
const viteFailure = new Promise((_, reject) => {
  vite.once('error', reject);
  vite.once('exit', (code, signal) => reject(new Error(`Owned Vite exited with ${code ?? signal}`)));
});
viteFailure.catch(() => {});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = signal;
    interrupt(new Error(`Interrupted by ${signal}`));
  });

try {
  await Promise.race([
    new Promise((resolveReady, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        cancelStartup();
        reject(new Error('Vite did not start on 127.0.0.1:6287'));
      }, 30_000);
      cancelStartup = () => {
        clearTimeout(timeout);
        vite.stdout.off('data', onData);
      };
      function onData(chunk) {
        output += chunk.toString();
        if (output.includes('http://127.0.0.1:6287/')) {
          cancelStartup();
          resolveReady();
        }
      }
      vite.stdout.on('data', onData);
    }),
    interruption,
    viteFailure,
  ]);
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  const code = await Promise.race([
    new Promise((resolveExit, reject) => {
      runner = spawn(
        process.execPath,
        [
          resolve(testsDir, 'node_modules/@playwright/test/cli.js'),
          'test',
          '-c',
          'ui-playwright.config.ts',
          ...process.argv.slice(2),
        ],
        {
          cwd: testsDir,
          stdio: 'inherit',
        },
      );
      runner.on('error', reject);
      runner.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
    }),
    interruption,
    viteFailure,
  ]);
  process.exitCode = code;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  cancelStartup?.();
  const runnerStopped = await stopOwned(runner, 'Playwright');
  const viteStopped = await stopOwned(vite, 'Vite');
  if (!runnerStopped || !viteStopped) process.exitCode = 1;
  else if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
}
