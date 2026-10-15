import { type Browser, expect, type Page } from '@playwright/test';

export const ORIGIN = 'http://127.0.0.1:6289';
export const HTTPS_CHAT = 'https://csp-validation.invalid/v1/chat/completions';
export const DUMMY_KEY = 'csp-dummy-never-real-20261005';
const AUTH = `Bearer ${DUMMY_KEY}`;

type Scenario = 'stream' | 'json' | 'error' | 'strict-tool';
export interface FakeTraffic {
  scenario: Scenario;
  requests: Array<{ url: string; model: string; stream: boolean; messageCount: number }>;
  blocked: string[];
  protocolErrors: string[];
}

const complete = (text: string, scenario: Scenario) => {
  const data = {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 32, completion_tokens: 16 },
  };
  if (scenario === 'json') return { contentType: 'application/json', body: JSON.stringify(data) };
  return {
    contentType: 'text/event-stream',
    body: [
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: data.usage })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
  };
};

/** The browser context starts empty. No user profile, persisted key, HAR, trace, or external fetch is used. */
export async function isolatedApp(browser: Browser, scenario: Scenario = 'stream') {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    recordVideo: undefined,
  });
  const traffic: FakeTraffic = { scenario, requests: [], blocked: [], protocolErrors: [] };

  // Register the deny-all rule first; the narrowly scoped routes below take precedence.
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${ORIGIN}/`)) return route.continue();
    traffic.blocked.push(new URL(url).origin);
    return route.abort();
  });

  // The host's bootstrap still reports CSP violations and blocks every other external fetch.
  // Only the exact test URL with the exact dummy Authorization is exempted in this test response.
  await context.route(`${ORIGIN}/validation-bootstrap.js`, async (route) => {
    const response = await route.fetch();
    let script = await response.text();
    const marker = '    // Explicit BYOK profile must use this proxy. All direct external fetch is disabled.';
    const originGuard = 'url.origin !== location.origin ||';
    const completionGuard = "url.pathname !== '/validation-api/v1/chat/completions')";
    if (!script.includes(marker) || !script.includes(originGuard) || !script.includes(completionGuard))
      throw new Error('Validation bootstrap changed; review the fake exception');
    script = script.replace(
      marker,
      `    const testHeaders = new Headers(input instanceof Request ? input.headers : undefined);\n` +
        `    new Headers(init?.headers).forEach((value, key) => testHeaders.set(key, value));\n` +
        `    const cspFakeAllowed = url.href === ${JSON.stringify(HTTPS_CHAT)} && testHeaders.get('authorization') === ${JSON.stringify(AUTH)};\n` +
        marker,
    );
    script = script.replace(originGuard, '(url.origin !== location.origin && !cspFakeAllowed) ||');
    script = script.replace(
      completionGuard,
      "url.pathname !== '/validation-api/v1/chat/completions' && !cspFakeAllowed)",
    );
    if (!script.includes('cspFakeAllowed)') || !script.includes('testHeaders.get'))
      throw new Error('Validation bootstrap guard changed');
    await route.fulfill({ response, body: script });
  });

  await context.route(HTTPS_CHAT, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, accept',
      'cache-control': 'no-store',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() !== 'POST' || request.headers().authorization !== AUTH) {
      traffic.blocked.push('unauthorized fake HTTPS request');
      return route.abort();
    }
    const body = request.postDataJSON() as { model?: string; stream?: boolean; messages?: unknown[] };
    traffic.requests.push({
      url: request.url(),
      model: String(body.model ?? ''),
      stream: body.stream === true,
      messageCount: body.messages?.length ?? 0,
    });
    if (traffic.scenario === 'strict-tool') {
      if (traffic.requests.length === 1) {
        const first = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'fixture-reasoning', tool_calls: [{ index: 0, id: 'fixture-tool-1', type: 'function', function: { name: 'set_scene', arguments: '{"title":"测试场景","location":"旧城北门"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join('');
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: first });
      }
      const assistant = body.messages?.find((item) => (item as { role?: string }).role === 'assistant') as
        | { reasoning_content?: string; tool_calls?: unknown[] }
        | undefined;
      if (assistant?.reasoning_content !== 'fixture-reasoning' || assistant.tool_calls?.length !== 1) {
        traffic.protocolErrors.push('assistant reasoning_content or tool_calls missing on tool continuation');
        return route.fulfill({
          status: 400,
          headers: { ...cors, 'content-type': 'application/json' },
          body: '{"error":{"message":"strict fake: missing reasoning_content on assistant tool continuation"}}',
        });
      }
    }
    if (traffic.scenario === 'error')
      return route.fulfill({
        status: 429,
        headers: { ...cors, 'content-type': 'application/json' },
        body: '{"error":{"message":"fake rate limit"}}',
      });
    const reply = complete('CSP_FAKE_COMPLETE', traffic.scenario);
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': reply.contentType }, body: reply.body });
  });

  const page = await context.newPage();
  const response = await page.goto(`${ORIGIN}/`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('.app')).toBeVisible();
  return { context, page, traffic };
}

export async function configureDummyProvider(page: Page, baseUrl = 'https://csp-validation.invalid/v1') {
  await page.locator('.left-rail').getByRole('button', { name: '设置' }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog.getByRole('heading', { name: '模型配置' })).toBeVisible();
  await dialog.getByLabel('接口地址').fill(baseUrl);
  await dialog.getByLabel('模型名').fill('csp-fake-model');
  await dialog.getByLabel(/^API Key\b/).fill(DUMMY_KEY);
  await dialog.getByLabel('密钥保存方式').selectOption('session');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    dialog
      .locator('.provider-save-bar')
      .getByRole('status')
      .filter({ hasText: /^已保存/ }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();
}

export async function makeWorldWithCard(page: Page) {
  const rail = page.locator('.left-rail');
  await rail.getByRole('button', { name: '查看已有角色卡' }).click();
  await rail.getByRole('button', { name: '＋ 新建' }).click();
  await rail.getByLabel('名字', { exact: true }).fill('CSP 测试角色');
  await rail.getByRole('button', { name: '保存', exact: true }).click();
  await expect(rail.locator('select')).toContainText('CSP 测试角色');
  await rail.getByRole('button', { name: '返回列表' }).click();
  await rail.getByRole('button', { name: '新对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新对话与新世界' });
  await dialog.getByLabel('世界名').fill('CSP 测试世界');
  await dialog.getByLabel('地点').fill('旧城北门');
  await dialog.getByLabel('CSP 测试角色').check();
  await dialog.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.locator('.chat-surface:not(.empty)')).toBeVisible();
}
