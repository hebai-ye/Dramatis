import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/web/tests/node_modules/@playwright/test/index.mjs';
import { hash } from './validation-common.mjs';
import { createValidationHost } from './validation-host.mjs';
import { planRemainingSamples } from './validation-live-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fake = process.argv.includes('--fake');
const stopRehearsal = process.argv.includes('--fake-stop-after-dispatch');
const commandFault = process.argv.includes('--fake-command-fault');
const setupFault = process.argv.includes('--fake-setup-fault');
assert.ok(
  process.argv
    .slice(2)
    .every((arg) =>
      ['--fake', '--fake-stop-after-dispatch', '--fake-command-fault', '--fake-setup-fault'].includes(arg),
    ),
  'Unknown live validation option',
);
assert.ok(fake || !(stopRehearsal || commandFault || setupFault), 'Fault injection is fake-only');
const runId = randomUUID();
const local = path.join(root, 'apps/web/tests/quality/.local');
await mkdir(local, { recursive: true });
const directory = await mkdtemp(path.join(local, 'live-run-'));
const commandPath = path.join(directory, 'command.json');
let host, browser, context, page;
// A failed fake startup must never have a cleanup path to the real host.
let origin = fake ? undefined : 'http://127.0.0.1:6285';
let targetVerified = false;
let completed = 0;
let stopped = false;
let failed = false;
let finalRows = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function status() {
  assert.ok(origin, 'No validation host selected');
  const response = await fetch(`${origin}/validation-api/status`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function lock() {
  assert.equal(targetVerified, true, 'Cannot clean up an unverified target');
  const response = await fetch(`${origin}/validation-api/arm`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'locked' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
}
async function command() {
  try {
    const value = JSON.parse(await readFile(commandPath, 'utf8'));
    if (value.runId !== runId || !['start', 'stop'].includes(value.action)) throw Error('Invalid run command');
    return value.action;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function safeFields(value) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(authorization|api[-_]?key|reasoning_content)$/i.test(key), 'Evidence contains a forbidden field');
    safeFields(child);
  }
}
async function download(button, name) {
  // Observe both promises immediately: an event timeout must not become an
  // unhandled rejection while a blocked click is still waiting.
  const [artifact] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator(button).click(),
  ]);
  const destination = path.join(directory, name);
  await artifact.saveAs(destination);
  const text = (await readFile(destination, 'utf8')).trim();
  const rows = text ? text.split('\n').map((line) => JSON.parse(line)) : [];
  for (const row of rows) safeFields(row);
  return rows;
}
async function saveEvidence() {
  const rows = await download('#downloadRaw', 'quality-raw.jsonl');
  for (const row of rows) {
    assert.equal(row.mode, fake ? 'fake' : 'real');
    for (const round of row.rounds) {
      assert.equal(hash(round.wire), round.exportedWireHash);
      assert.equal(round.executionProfile?.maxOutputTokens, 4096);
      if (!round.error) assert.match(round.upstreamWireHash, /^[a-f0-9]{64}$/);
    }
  }
  await download('#downloadLedger', 'validation-ledger.jsonl');
  return rows;
}

async function settled(timeoutMs = 130000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await status();
    const uiIdle = !page || page.isClosed() || (await page.locator('#sample').evaluate((node) => !node.disabled));
    if (!current.busy && uiIdle) return current;
    await pause(250);
  } while (Date.now() < deadline);
  return undefined;
}

async function finalize() {
  const report = {
    runId,
    fake,
    completed,
    stopped,
    failed,
    targetVerified,
    settled: false,
    locked: false,
    evidenceSaved: false,
    keyCleared: false,
    browserClosed: false,
    needsAttention: false,
  };
  if (targetVerified) {
    try {
      // Abort through the page before attempting arm: a busy host rejects arm.
      if (page && !page.isClosed()) await page.locator('#stop').click();
      const current = await settled();
      report.settled = Boolean(current);
      if (current) {
        await lock();
        const locked = await status();
        report.locked = locked.mode === 'locked' && locked.busy === false;
        report.requests = locked.real.requests;
        report.spentCny = locked.real.spentCny;
        report.halted = locked.real.halted;
        if (fake) assert.equal(locked.real.requests, 0);
      }
    } catch {
      report.needsAttention = true;
    }
  }
  if (page && !page.isClosed()) {
    try {
      // Download while the page still has its credential for exact-value scrubbing.
      finalRows = await saveEvidence();
      report.evidenceSaved = true;
      report.evidenceRows = finalRows.length;
    } catch {
      report.needsAttention = true;
    }
    try {
      await page.locator('#clear').click(); // Never read, copy or export the credential field.
      await page.locator('#result').filter({ hasText: 'Key 已清除；预算不重置。' }).waitFor();
      report.keyCleared = true;
    } catch {
      report.needsAttention = true;
    }
  }
  try {
    await context?.close();
    await browser?.close();
    report.browserClosed = true;
  } catch {
    report.needsAttention = true;
  }
  if (host) {
    try {
      report.hostShutdownClean = (await host.shutdown()).clean;
      if (!report.hostShutdownClean) report.needsAttention = true;
    } catch {
      report.needsAttention = true;
    }
  }
  if (targetVerified && (!report.settled || !report.locked || (page && (!report.evidenceSaved || !report.keyCleared))))
    report.needsAttention = true;
  await writeFile(path.join(directory, 'finalization.json'), JSON.stringify(report, null, 2));
  return report;
}

try {
  if (fake) {
    host = await createValidationHost({
      port: 0,
      ledgerPath: path.join(directory, 'fake-ledger.json'),
      initialize: true,
      maxOutputTokens: 4096,
      upstreamFetch: async () => {
        throw Error('Real upstream is forbidden in rehearsal');
      },
      ...(setupFault
        ? {
            journalIo: {
              sync() {
                throw Error('fake-startup-fault');
              },
            },
          }
        : {}),
    });
    origin = `http://127.0.0.1:${host.address().port}`;
  }
  const before = await status();
  assert.equal(before.executionProfile?.maxOutputTokens, 4096);
  assert.equal(before.busy, false);
  if (!fake) {
    assert.equal(before.real.requests, 1, 'This plan resumes only the verified first attempt');
    assert.equal(before.real.spentCny, 0.01213);
    assert.equal(before.real.halted, false);
    assert.ok(before.real.recoveryAudit);
  }
  targetVerified = true;
  browser = await chromium.launch({ channel: 'msedge', headless: fake });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  // Only this fresh page and loopback proxy are accessible; credentials are entered solely by the user.
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
  );
  page = await context.newPage();
  await page.goto(`${origin}/validation/`);
  await page.getByText('准备完成 · 默认不发送 · 真实 Key 只由用户输入').waitFor();
  const mapping = await download('#downloadMap', 'quality-unblind.jsonl');
  const options = await page
    .locator('#sample option')
    .evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, label: node.textContent })));
  const allSamples = planRemainingSamples(mapping, options);
  assert.equal(mapping.length, 30);
  assert.equal(allSamples.length, 29);
  const samples = fake ? allSamples.filter((item) => item.family === 'roleplay').slice(0, 1) : allSamples;
  assert.ok(samples.length > 0);
  const ready = { runId, commandPath, directory, origin, fake, plannedSamples: samples.length, skippedPrevious: 1 };
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify(ready, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ event: 'READY', ...ready }));
  if (!fake) {
    while ((await command()) !== 'start') {
      if ((await command()) === 'stop') {
        stopped = true;
        break;
      }
      await pause(500);
    }
  }
  if (!stopped) {
    if (stopRehearsal || commandFault) await page.locator('#fakeScenario').selectOption('slow');
    await page.locator(fake ? '#fake' : '#arm').click();
    await page
      .locator('#budget')
      .filter({ hasText: `模式：${fake ? 'fake' : 'real'}` })
      .waitFor();
    for (const sample of samples) {
      if ((await command()) === 'stop') {
        stopped = true;
        break;
      }
      const budget = await status();
      assert.equal(budget.real.halted, false);
      if (fake) assert.equal(budget.real.requests, 0);
      console.log(JSON.stringify({ event: 'RUN_START', blindId: sample.blindId, family: sample.family }));
      await page.locator('#sample').selectOption(sample.value);
      await page.locator('#run').click();
      const result = page.waitForFunction(
        (blindId) => {
          try {
            return JSON.parse(document.querySelector('#result').textContent).blindId === blindId;
          } catch {
            return false;
          }
        },
        sample.blindId,
        { timeout: 300000 },
      );
      let waiting = true;
      const stopMonitor = (async () => {
        while (waiting) {
          if (fake && (stopRehearsal || commandFault)) {
            const current = await status();
            if (current.busy && current.fake.requests > 0) {
              await writeFile(commandPath, commandFault ? '{' : JSON.stringify({ runId, action: 'stop' }));
            }
          }
          if ((await command()) === 'stop') {
            stopped = true;
            await page.locator('#stop').click();
            break;
          }
          await pause(500);
        }
      })();
      // Observe monitor rejection immediately. Its normal completion cannot win
      // the race before the page has actually recorded the result.
      const monitorFailure = stopMonitor.then(() => new Promise(() => {}));
      try {
        await Promise.race([result, monitorFailure]);
      } finally {
        waiting = false;
        await stopMonitor.catch(() => {});
      }
      await page.waitForFunction(() => !document.querySelector('#sample').disabled);
      const rows = await saveEvidence();
      assert.equal(rows.length, completed + 1, 'Every selection must produce exactly one new evidence row');
      const row = rows.at(-1);
      assert.equal(row.blindId, sample.blindId);
      completed += 1;
      const after = await status();
      console.log(
        JSON.stringify({
          event: 'RUN_DONE',
          blindId: sample.blindId,
          family: sample.family,
          completed,
          requests: after.real.requests,
          spentCny: after.real.spentCny,
          halted: after.real.halted,
          resultError: row.error ?? null,
        }),
      );
      if (row.error || after.real.halted || stopped) {
        stopped = true;
        break;
      }
    }
  }
} catch {
  failed = true;
} finally {
  const final = await finalize();
  const success = !failed && !stopped && !final.needsAttention && final.locked && final.evidenceSaved;
  await writeFile(
    path.join(directory, 'run-summary.json'),
    JSON.stringify(
      {
        ...final,
        skippedPrevious: 1,
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
  console.log(
    JSON.stringify({
      event: final.needsAttention ? 'NEEDS_ATTENTION' : success ? 'COMPLETE' : 'STOPPED',
      fake,
      completed,
      evidenceRows: finalRows.length,
      stopped,
      directory,
      requests: final.requests,
      spentCny: final.spentCny,
      halted: final.halted,
      locked: final.locked,
      keyCleared: final.keyCleared,
    }),
  );
}
