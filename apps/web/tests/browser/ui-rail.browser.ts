import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

async function withApp(browser: Browser, width: number, run: (page: Page) => Promise<void>) {
  const context: BrowserContext = await browser.newContext({ viewport: { width, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.app')).toBeVisible();
    if (width <= 640) await page.getByRole('button', { name: '展开左栏' }).click();
    await page.locator('.left-rail').getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.locator('.chat-surface:not(.empty)')).toBeVisible();
    await run(page);
  } finally {
    await context.close();
  }
}

async function railState(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.left-rail');
    const panel = document.querySelector<HTMLElement>('.runtime-drawer');
    const shown = (node: HTMLElement | null) =>
      !!node &&
      getComputedStyle(node).display !== 'none' &&
      getComputedStyle(node).visibility === 'visible' &&
      node.getBoundingClientRect().right > 0 &&
      node.getBoundingClientRect().left < innerWidth;
    return { rail: shown(rail), panel: shown(panel), panelDisplay: panel ? getComputedStyle(panel).display : null };
  });
}

test('A11 mobile rail switches right → left → right with one visible drawer', async ({ browser }) => {
  await withApp(browser, 390, async (page) => {
    await expect(page.getByRole('button', { name: '面板' })).toBeEnabled();
    await page.getByRole('button', { name: '面板' }).click();
    await expect.poll(() => railState(page)).toMatchObject({ rail: false, panel: true });
    // Exercise the real App controls directly while the translated top bar is covered by the drawer.
    await page.getByRole('button', { name: '展开左栏' }).dispatchEvent('click');
    await expect.poll(() => railState(page)).toMatchObject({ rail: true, panel: false });
    await page.getByRole('button', { name: '面板' }).dispatchEvent('click');
    await expect.poll(() => railState(page)).toMatchObject({ rail: false, panel: true });
    // The open drawer covers the top bar; the backdrop closes it before the rail control is used.
    await page.getByRole('button', { name: '收起侧栏' }).click({ position: { x: 4, y: 400 } });
    await page.getByRole('button', { name: '展开左栏' }).click();
    await expect.poll(() => railState(page)).toMatchObject({ rail: true, panel: false });
    await page.getByRole('button', { name: '收起侧栏' }).click({ position: { x: 380, y: 400 } });
    await page.getByRole('button', { name: '面板' }).click();
    await expect.poll(() => railState(page)).toMatchObject({ rail: false, panel: true });
  });
});

test('A11 desktop keeps independent drawers, then narrowing preserves left rail', async ({ browser }) => {
  await withApp(browser, 1100, async (page) => {
    await expect.poll(() => railState(page)).toMatchObject({ rail: true, panel: false });
    await page.locator('.main-header').getByRole('button', { name: '面板' }).click();
    await expect.poll(() => railState(page)).toMatchObject({ rail: true, panel: true });
    await page.setViewportSize({ width: 390, height: 800 });
    await expect.poll(() => railState(page)).toMatchObject({ rail: true, panel: false });
  });
});
