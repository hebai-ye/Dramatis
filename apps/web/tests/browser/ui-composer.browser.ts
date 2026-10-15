import { type Browser, expect, test } from '@playwright/test';

async function withComposer(
  browser: Browser,
  mobile: boolean,
  run: (page: import('@playwright/test').Page) => Promise<void>,
) {
  const context = await browser.newContext({
    viewport: { width: mobile ? 390 : 1024, height: 800 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
    const page = await context.newPage();
    await page.goto('/tests/ui/index.html?fixture=composer');
    await expect(page.getByTestId('composer-fixture').locator('textarea')).toBeVisible();
    await run(page);
  } finally {
    await context.close();
  }
}

test('B04 desktop Enter sends only when allowed; disabled, busy and bridge retain draft', async ({ browser }) => {
  await withComposer(browser, false, async (page) => {
    const input = page.locator('textarea');
    for (const flags of [{ disabled: true }, { disabled: false, busy: true }, { busy: false, bridgeOpen: true }]) {
      if (await input.isEnabled()) await input.focus();
      await page.evaluate((patch) => window.uiBridge.setComposerFlags(patch), flags);
      await page.evaluate(() => window.uiBridge.setComposerValue('保留草稿'));
      await expect(input).toHaveValue('保留草稿');
      if (flags.disabled) {
        await expect(input).toBeDisabled();
        await page.keyboard.press('Enter');
      } else {
        await input.focus();
        await input.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
        await input.press('Enter');
      }
      expect(await page.evaluate(() => window.uiBridge.sent)).toEqual([]);
      expect(await input.inputValue()).toMatch(/^保留草稿\n?$/);
    }
    await page.evaluate(() => window.uiBridge.setComposerFlags({ bridgeOpen: false }));
    await page.evaluate(() => window.uiBridge.setComposerValue('保留草稿'));
    await expect(input).toHaveValue('保留草稿');
    await input.focus();
    await input.press('Shift+Enter');
    expect(await page.evaluate(() => window.uiBridge.sent)).toEqual([]);
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    expect(await page.evaluate(() => window.uiBridge.sent)).toEqual([]);
    await input.press('Enter');
    expect(await page.evaluate(() => window.uiBridge.sent)).toEqual(['保留草稿\n']);
  });
});

test('B04 coarse pointer Enter inserts newline and legal button click sends', async ({ browser }) => {
  await withComposer(browser, true, async (page) => {
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
    const input = page.locator('textarea');
    await input.fill('手机草稿');
    await input.press('Enter');
    await expect(input).toHaveValue('手机草稿\n');
    expect(await page.evaluate(() => window.uiBridge.sent)).toEqual([]);
    await page.getByRole('button', { name: '发送' }).click();
    expect(await page.evaluate(() => window.uiBridge.sent)).toEqual(['手机草稿\n']);
  });
});

test('B04 real MainChat and SideChat keep drafts while bridge is pending', async ({ browser }) => {
  for (const fixture of ['bridge-main', 'bridge-side']) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    try {
      await context.route('http://127.0.0.1:8791/**', (route) => route.abort());
      const page = await context.newPage();
      await page.goto(`/tests/ui/index.html?fixture=${fixture}`);
      const input = page.locator('.chat-surface .composer textarea');
      await input.fill('桥接期间的草稿');
      await input.press('Enter');
      expect(await input.inputValue()).toMatch(/^桥接期间的草稿\n?$/);
      await expect(page.getByRole('button', { name: '发送' })).toBeDisabled();
      expect(await page.evaluate(() => window.uiBridge.sent)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
