import { expect, type Page, test } from '@playwright/test';
import { configureDummyProvider, DUMMY_KEY, HTTPS_CHAT, isolatedApp, makeWorldWithCard, ORIGIN } from '../csp/fake';
import { BACKGROUND_PNG, JSON_CARD, pngCard } from '../csp/fixtures';

const status = async (page: Page) =>
  (await (await page.request.get(`${ORIGIN}/validation-api/status`)).json()) as {
    real: { requests: number };
    fake: { requests: number };
    violations: Array<{ directive: string; disposition: string }>;
  };

const send = async (page: Page, text: string) => {
  const composer = page.locator('.chat-surface .composer');
  await composer.locator('textarea').fill(text);
  await composer.getByRole('button', { name: '发送' }).click();
};

test('actual App receives fake SSE over narrowly allowed HTTPS and persists a main reply', async ({ browser }) => {
  const { context, page, traffic } = await isolatedApp(browser, 'stream');
  try {
    const before = await status(page);
    await configureDummyProvider(page);
    await makeWorldWithCard(page);
    await send(page, 'CSP SSE 验收');
    await expect(
      page.locator('.message-row.character[data-message-id]').filter({ hasText: 'CSP_FAKE_COMPLETE' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.locator('.message-row.character[data-message-id]').filter({ hasText: 'CSP_FAKE_COMPLETE' }),
    ).toBeVisible();
    expect(traffic.requests.length).toBeGreaterThanOrEqual(1); // intent/background calls also count as fake requests.
    expect(traffic.requests.every((item) => item.url === HTTPS_CHAT && item.stream && item.messageCount > 0)).toBe(
      true,
    );
    const after = await status(page);
    expect(after.real.requests).toBe(0);
    expect(after.violations.slice(before.violations.length)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('actual App accepts JSON fallback from the fake HTTPS provider', async ({ browser }) => {
  const { context, page, traffic } = await isolatedApp(browser, 'json');
  try {
    await configureDummyProvider(page);
    await makeWorldWithCard(page);
    await send(page, 'CSP JSON 验收');
    await expect(
      page.locator('.message-row.character[data-message-id]').filter({ hasText: 'CSP_FAKE_COMPLETE' }),
    ).toBeVisible();
    expect(traffic.requests.length).toBeGreaterThanOrEqual(1);
    expect((await status(page)).real.requests).toBe(0);
  } finally {
    await context.close();
  }
});

test('actual App side chat sends a fake reply with a selected main scene target', async ({ browser }) => {
  const { context, page, traffic } = await isolatedApp(browser, 'stream');
  try {
    await configureDummyProvider(page);
    await makeWorldWithCard(page);
    await page.getByRole('button', { name: '副对话', exact: true }).click();
    await expect(page.locator('.chat-surface.side')).toBeVisible();
    await expect(page.getByLabel('场景目标')).toHaveValue(/.+/);
    await send(page, '请描述当前场景');
    await expect(page.locator('.admin-row.admin').filter({ hasText: 'CSP_FAKE_COMPLETE' })).toBeVisible();
    expect(traffic.requests.length).toBeGreaterThanOrEqual(1);
    expect((await status(page)).real.requests).toBe(0);
  } finally {
    await context.close();
  }
});

test('actual App shows a safe provider error without persisting a fake reply or exposing the dummy key', async ({
  browser,
}) => {
  const { context, page, traffic } = await isolatedApp(browser, 'error');
  try {
    await configureDummyProvider(page);
    await makeWorldWithCard(page);
    await send(page, 'CSP 错误验收');
    await expect(page.locator('.notice.error').filter({ hasText: /模型服务返回|429|出错了/ })).toBeVisible();
    expect((await page.locator('.notice.error').allTextContents()).join('\n')).not.toContain(DUMMY_KEY);
    // Existing failure handling stores a transparent action, never a fabricated provider reply.
    const failure = page.locator('.message-row.character[data-message-id]');
    const assertTransparentFailure = async () => {
      await expect(failure).toHaveCount(1);
      await expect(failure.locator('.action-line')).toHaveCount(1);
      await expect(failure.locator('.action-line')).toHaveText('CSP 测试角色看向你，暂时没有开口。');
      await expect(failure.locator('.bubble.character')).toHaveCount(0);
      for (const forbidden of ['CSP_FAKE_COMPLETE', 'fake rate limit', DUMMY_KEY]) {
        await expect(failure).not.toContainText(forbidden);
      }
    };
    await assertTransparentFailure();
    const failureId = (await failure.getAttribute('data-message-id')) ?? '';
    expect(failureId).not.toBe('');
    await page.reload();
    await assertTransparentFailure();
    await expect(failure).toHaveAttribute('data-message-id', failureId);
    expect(traffic.requests.length).toBeGreaterThanOrEqual(1);
    expect(traffic.requests.every((item) => item.url === HTTPS_CHAT && item.stream && item.messageCount > 0)).toBe(
      true,
    );
    expect((await status(page)).real.requests).toBe(0);
  } finally {
    await context.close();
  }
});

test('actual App aborts a slow loopback fake stream without storing a complete character reply', async ({
  browser,
}) => {
  const { context, page } = await isolatedApp(browser);
  try {
    await configureDummyProvider(page, `${ORIGIN}/validation-api/v1`);
    await makeWorldWithCard(page);
    const armed = await page.request.post(`${ORIGIN}/validation-api/arm`, {
      headers: { origin: ORIGIN },
      data: { mode: 'fake', fakeScenario: 'slow', resetFake: true },
    });
    expect(armed.status()).toBe(200);
    await send(page, 'CSP 停止验收');
    await expect.poll(async () => (await status(page)).fake.requests).toBeGreaterThanOrEqual(1);
    await page.locator('.chat-surface .composer').getByRole('button', { name: '停止' }).click();
    await expect(page.locator('.chat-surface .composer').getByRole('button', { name: '发送' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.message-row.character[data-message-id]')).toHaveCount(0);
    expect((await status(page)).real.requests).toBe(0);
  } finally {
    await context.close();
  }
});

test('actual App imports fixed PNG/JSON cards and renders a data background; CSP allows a same-origin Worker and blob image', async ({
  browser,
}) => {
  const { context, page } = await isolatedApp(browser);
  try {
    await makeWorldWithCard(page);
    const upload = page.locator('.left-rail input[type=file]');
    await upload.setInputFiles({ name: 'csp-card.json', mimeType: 'application/json', buffer: JSON_CARD });
    await upload.setInputFiles({ name: 'csp-card.png', mimeType: 'image/png', buffer: pngCard() });
    await page.locator('.left-rail').getByRole('button', { name: '查看已有角色卡' }).click();
    await expect(page.locator('.left-rail select')).toContainText('CSP JSON 素材');
    await expect(page.locator('.left-rail select')).toContainText('CSP PNG 素材');
    await page.locator('.left-rail').getByRole('button', { name: '返回列表' }).click();
    await page.locator('.left-rail').getByRole('button', { name: '设置' }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    await dialog.getByRole('button', { name: /外观与显示/ }).click();
    await expect(dialog.getByRole('heading', { name: '对话区背景' })).toBeVisible();
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'csp-bg.png', mimeType: 'image/png', buffer: BACKGROUND_PNG });
    await expect(dialog.locator('.bg-preview')).toBeVisible();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(page.locator('.app.has-bg')).toBeVisible();
    expect(
      await page.locator('.app').evaluate((node) => getComputedStyle(node).getPropertyValue('--chat-bg')),
    ).toContain('data:image/png;base64,');
    const dataImageWidth = await page.locator('.app').evaluate(async (node) => {
      const background = getComputedStyle(node).getPropertyValue('--chat-bg');
      const source = /^url\("?(data:image\/png;base64,[^"]+)"?\)$/.exec(background.trim())?.[1];
      if (!source) return 0;
      const image = new Image();
      image.src = source;
      await image.decode();
      return image.naturalWidth;
    });
    expect(dataImageWidth).toBe(1);

    // Policy probes run in the real App document. They do not claim that App uses a dedicated Worker or blob background.
    await context.route(`${ORIGIN}/csp-fixture-worker.js`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'self.postMessage("worker-ready")' }),
    );
    const policy = await page.evaluate(async () => {
      const workerReady = await new Promise<string>((resolve, reject) => {
        const worker = new Worker('/csp-fixture-worker.js');
        worker.onmessage = (event) => {
          worker.terminate();
          resolve(String(event.data));
        };
        worker.onerror = () => {
          worker.terminate();
          reject(new Error('worker initialization blocked'));
        };
      });
      const blobUrl = URL.createObjectURL(
        new Blob(
          [
            Uint8Array.from(
              atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='),
              (letter) => letter.charCodeAt(0),
            ),
          ],
          { type: 'image/png' },
        ),
      );
      const image = new Image();
      image.src = blobUrl;
      await image.decode();
      URL.revokeObjectURL(blobUrl);
      return { workerReady, blobWidth: image.naturalWidth };
    });
    expect(policy).toEqual({ workerReady: 'worker-ready', blobWidth: 1 });
    expect((await status(page)).real.requests).toBe(0);
  } finally {
    await context.close();
  }
});

test('enforced host reports an expected inline violation while the exact dummy HTTPS exception blocks other URLs and keys', async ({
  browser,
}) => {
  const { context, page, traffic } = await isolatedApp(browser);
  try {
    const before = await status(page);
    const rejected = await page.evaluate(
      async ({ url }) => {
        const wrongKey = await fetch(url, { headers: { authorization: 'Bearer wrong-dummy-key' } }).then(
          () => false,
          () => true,
        );
        const otherUrl = await fetch('https://another-csp-validation.invalid/v1/chat/completions').then(
          () => false,
          () => true,
        );
        return { wrongKey, otherUrl };
      },
      { url: HTTPS_CHAT },
    );
    expect(rejected).toEqual({ wrongKey: true, otherUrl: true });
    expect(traffic.requests).toHaveLength(0);
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.cspForbiddenInlineRan = true';
      document.head.append(script);
    });
    expect(await page.evaluate(() => 'cspForbiddenInlineRan' in window)).toBe(false);
    await expect.poll(async () => (await status(page)).violations.length).toBeGreaterThan(before.violations.length);
    const actual = (await status(page)).violations.slice(before.violations.length);
    expect(actual).toEqual([{ directive: 'script-src-elem', disposition: 'enforce' }]);
    expect((await status(page)).real.requests).toBe(0);
  } finally {
    await context.close();
  }
});

test.skip('strict Low tool continuation carries reasoning_content in the actual App provider wire', async ({
  browser,
}) => {
  // Enable after the App's provider/admin turn forwards reasoning_content on the assistant tool message.
  const { context, page, traffic } = await isolatedApp(browser, 'strict-tool');
  try {
    await configureDummyProvider(page);
    await makeWorldWithCard(page);
    await page.getByRole('button', { name: '副对话', exact: true }).click();
    await send(page, '把场景设为旧城北门');
    await expect.poll(() => traffic.requests.length).toBeGreaterThanOrEqual(2);
    expect(traffic.protocolErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
