import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidationHost } from '../../../tools/desktop/validation-host.mjs';

const testsDir = dirname(fileURLToPath(import.meta.url));
const local = resolve(testsDir, 'csp/.local');
let host;
let runner;
let temp;
let verifiedLocal;
let interrupted;
let interrupt;
const interruption = new Promise((_, reject) => {
  interrupt = reject;
});
interruption.catch(() => {});

function isChildOf(parent, target) {
  const suffix = relative(parent, target);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function removeOwnedTemp() {
  try {
    const currentLocal = await realpath(local);
    if (currentLocal !== verifiedLocal) throw new Error('Refusing CSP temp cleanup: local directory was redirected');
    const currentTemp = await realpath(temp).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!currentTemp) return true;
    const suffix = relative(verifiedLocal, currentTemp);
    if (
      !isChildOf(verifiedLocal, currentTemp) ||
      dirname(suffix) !== '.' ||
      !basename(suffix).startsWith('fake-run-') ||
      currentTemp !== temp
    )
      throw new Error('Refusing CSP temp cleanup: target left its verified owned directory');
    await rm(currentTemp, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

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
async function stopOwnedRunner() {
  if (!runner?.pid || exited(runner)) return true;
  try {
    runner.kill('SIGTERM');
  } catch (error) {
    console.error(error);
  }
  if (await waitForExit(runner, 3_000)) return true;
  try {
    runner.kill('SIGKILL');
  } catch (error) {
    console.error(error);
  }
  if (await waitForExit(runner, 2_000)) return true;
  console.error(`Owned Playwright process ${runner.pid} did not exit after termination signals`);
  return false;
}
function closeOwnedHost(server) {
  return new Promise((resolveClose) => {
    let forcedTimeout;
    const timeout = setTimeout(() => {
      forcedTimeout = setTimeout(() => {
        console.error('Owned CSP host did not close after its connections were terminated');
        resolveClose(false);
      }, 2_000);
      try {
        server.closeAllConnections();
      } catch (error) {
        console.error(error);
      }
    }, 3_000);
    server.close((error) => {
      clearTimeout(timeout);
      clearTimeout(forcedTimeout);
      if (error) console.error(error);
      resolveClose(!error);
    });
  });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = signal;
    interrupt(new Error(`Interrupted by ${signal}`));
  });

try {
  if (process.env.CSP_FRESH_CANDIDATE !== '1')
    throw new Error('CSP_FRESH_CANDIDATE=1 is required after root refreshes the final production dist');
  const workspace = await realpath(resolve(testsDir, '../../..'));
  const cspDirectory = await realpath(resolve(testsDir, 'csp'));
  if (!isChildOf(workspace, cspDirectory)) throw new Error('CSP fixture directory left the workspace');
  await mkdir(local, { recursive: true });
  verifiedLocal = await realpath(local);
  if (!isChildOf(cspDirectory, verifiedLocal)) throw new Error('CSP local directory left its fixture directory');
  temp = await mkdtemp(join(verifiedLocal, 'fake-run-'));
  // This initialized journal exists only inside our ignored temp directory. No real upstream is callable.
  host = await createValidationHost({
    port: 6289,
    ledgerPath: join(temp, 'ledger.json'),
    initialize: true,
    upstreamFetch: async () => {
      throw new Error('C05 fake runner refuses real upstream');
    },
  });
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  const exitCode = await Promise.race([
    new Promise((resolveExit, reject) => {
      runner = spawn(
        process.execPath,
        [
          resolve(testsDir, 'node_modules/@playwright/test/cli.js'),
          'test',
          '-c',
          'csp-playwright.config.ts',
          ...process.argv.slice(2),
        ],
        { cwd: testsDir, stdio: 'inherit' },
      );
      runner.on('error', reject);
      runner.once('exit', (code) => resolveExit(code ?? 1));
    }),
    interruption,
  ]);
  process.exitCode = exitCode;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const runnerStopped = await stopOwnedRunner();
  const hostClosed = host ? await closeOwnedHost(host) : true;
  let tempRemoved = true;
  if (temp && runnerStopped && hostClosed) {
    tempRemoved = await removeOwnedTemp();
  } else if (temp) {
    console.error(`Preserving owned temp directory because cleanup did not complete: ${temp}`);
  }
  if (!runnerStopped || !hostClosed || !tempRemoved) process.exitCode = 1;
  else if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
}
