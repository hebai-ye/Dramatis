import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '../../apps/web/tests/node_modules/@playwright/test/index.mjs';
import { hash } from './validation-common.mjs';
import { createValidationHost } from './validation-host.mjs';

const temporaryRoot = await realpath(tmpdir());
const dir = await mkdtemp(path.join(temporaryRoot, 'validation-browser-'));
const host = await createValidationHost({ port: 0, ledgerPath: path.join(dir, 'ledger.json'), initialize: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
// Fresh ephemeral profile. No storageState, HAR, trace, credentials, or existing browser profile.
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const base = `http://127.0.0.1:${host.address().port}`;
const page = await context.newPage();
try {
  // Synthetic differences exercise both blind sides without changing frozen files or making model calls.
  await page.route('**/validation-api/manifest', async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest.comparison.find((item) => item.caseId === 'admin-3').identical = false;
    const candidate = manifest.candidate.find((item) => item.caseId === 'admin-3');
    candidate.request.messages = [{ role: 'system', content: 'CANDIDATE-PRIVATE-PROMPT' }];
    candidate.input.cards[0].name = 'CANDIDATE-PRIVATE-NAME';
    await route.fulfill({ response, json: manifest });
  });
  await page.goto(`${base}/validation/`);
  await page.getByText('准备完成 · 默认不发送 · 真实 Key 只由用户输入').waitFor();
  assert.equal(await page.locator('#key').getAttribute('type'), 'password');
  await page.locator('#fake').click();
  await page.locator('#budget').filter({ hasText: '模式：fake' }).waitFor();
  async function downloaded(button, name) {
    const event = page.waitForEvent('download');
    await page.locator(button).click();
    const download = await event;
    const destination = path.join(dir, name);
    await download.saveAs(destination);
    return (await readFile(destination, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
  const mapping = await downloaded('#downloadMap', 'map.jsonl');
  const sides = mapping.filter((item) => item.caseId === 'admin-3' && item.repeat === 1);
  assert.equal(sides.length, 2);
  const backgrounds = [];
  for (const item of sides) {
    await page.locator('#sample').selectOption({ label: `${item.blindId} · admin` });
    const background = await page.locator('#background').innerText();
    backgrounds.push(background);
    assert.match(background, /话少/);
    assert.match(background, /把当前场景地点改为旧城北门/);
    assert.doesNotMatch(background, /PRIVATE|git-blob|working-tree/);
    await page.locator('#run').click();
    await page.locator('#result').filter({ hasText: '隔离 fake 回复' }).waitFor();
    await page.locator('#assessor').fill('fake-smoke');
    await page.locator('#scoreEvidence').fill('共同背景可见；只验证功能。');
    await page.locator('#saveScore').click();
  }
  assert.equal(backgrounds[0], backgrounds[1]);
  const raw = await downloaded('#downloadRaw', 'raw.jsonl');
  const scores = await downloaded('#downloadScores', 'scores.jsonl');
  assert.equal(raw.length, 2);
  assert.equal(scores.length, 2);
  for (const entry of raw) {
    assert.equal(entry.side, undefined);
    assert.ok(entry.background.characters.length > 0);
    for (const round of entry.rounds) {
      assert.equal(hash(round.wire), round.wireHash);
      assert.equal(hash(round.wire), round.exportedWireHash);
    }
  }
  assert.equal(scores[0].side, undefined);
  assert.match(scores[0].background.task, /北门/);
  await page.reload();
  await page.getByText('准备完成 · 默认不发送 · 真实 Key 只由用户输入').waitFor();
  assert.equal(await page.locator('#key').inputValue(), '');
  assert.match(await page.locator('#budget').innerText(), /Fake 2 次/);
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.forbiddenInlineExecuted = true';
    document.head.append(script);
  });
  await page.waitForFunction(() => !('forbiddenInlineExecuted' in window));
  await page.waitForTimeout(100);
  const status = await (await page.request.get(`${base}/validation-api/status`)).json();
  assert.equal(status.real.requests, 0);
  assert.ok(status.violations.some((v) => v.directive === 'script-src-elem' && v.disposition === 'enforce'));
  await mkdir('apps/web/tests/quality/.local', { recursive: true });
  await page.screenshot({ path: 'apps/web/tests/quality/.local/quality-fake.png', fullPage: true });
  const app = await context.newPage();
  const response = await app.goto(`${base}/`);
  assert.equal(response.status(), 200);
  assert.ok(response.headers()['content-security-policy']);
  assert.equal(
    await app.evaluate(() =>
      fetch('https://api.deepseek.com/v1/chat/completions').then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  console.log(
    JSON.stringify({
      result: 'PASS',
      qualityPage:
        'ready; masked key; both blind sides share neutral background; raw/scoring downloads; reproducible full wire hashes; reload retains ledger',
      csp: 'enforced inline script blocked; App direct external fetch blocked',
      realRequests: 0,
      realCny: 0,
      screenshot: 'apps/web/tests/quality/.local/quality-fake.png',
      appScope: 'production dist load only; not real BYOK acceptance',
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => host.close(resolve));
  const cleanupTarget = await realpath(dir);
  assert.equal(cleanupTarget, dir, 'Temporary validation directory must not be redirected');
  assert.equal(path.dirname(cleanupTarget), temporaryRoot);
  assert.ok(path.basename(cleanupTarget).startsWith('validation-browser-'));
  await rm(cleanupTarget, { recursive: true, force: true });
}
