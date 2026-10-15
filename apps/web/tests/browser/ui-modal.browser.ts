import { expect, type Page, test } from '@playwright/test';

async function newFixturePage(browser: import('@playwright/test').Browser, fixture: 'modal' | 'scene-dialog') {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.goto(`/tests/ui/index.html?fixture=${fixture}`);
  return { context, page };
}

async function closeBy(page: Page, route: 'Escape' | 'scrim' | 'button') {
  if (route === 'Escape') await page.keyboard.press('Escape');
  else if (route === 'scrim') await page.locator('.dialog-scrim').click({ position: { x: 4, y: 4 } });
  else await page.locator('.modal-head').getByRole('button', { name: '收起' }).click();
}

test('D03 actual Modal has one portal dialog and traps both Tab directions while background is inert', async ({
  browser,
}) => {
  const { context, page } = await newFixturePage(browser, 'modal');
  try {
    const trigger = page.getByTestId('modal-trigger');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '测试弹窗' });
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.locator('.modal-head')).toHaveCount(1);
    await expect(dialog.locator('.modal-head strong')).toHaveText('独立标题');
    await expect(dialog.locator('.modal-head button')).toHaveCount(1);
    await expect(dialog.getByRole('textbox', { name: '标题内名字' })).toHaveValue('角色名');
    expect(await page.evaluate(() => document.querySelector('.dialog-backdrop')?.parentElement === document.body)).toBe(
      true,
    );
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await expect(dialog.locator('.modal-head button')).toBeFocused();
    await dialog.getByRole('textbox', { name: '标题内名字' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '页脚末按钮' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('textbox', { name: '标题内名字' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  } finally {
    await context.close();
  }
});

test('D03 Escape, scrim and header button use one onClose and restore trigger focus', async ({ browser }) => {
  const { context, page } = await newFixturePage(browser, 'modal');
  try {
    const trigger = page.getByTestId('modal-trigger');
    for (const [index, route] of (['Escape', 'scrim', 'button'] as const).entries()) {
      await trigger.click();
      await expect(page.getByRole('dialog', { name: '测试弹窗' })).toHaveCount(1);
      await closeBy(page, route);
      await expect(page.getByRole('dialog', { name: '测试弹窗' })).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.uiBridge.modalCloseCount)).toBe(index + 1);
    }
  } finally {
    await context.close();
  }
});

test('D03 actual SceneDialog flushes edited summary through every close path before onClose', async ({ browser }) => {
  const { context, page } = await newFixturePage(browser, 'scene-dialog');
  try {
    const trigger = page.getByTestId('scene-trigger');
    for (const route of ['Escape', 'scrim', 'button', 'save', 'switch'] as const) {
      await page.evaluate(() => {
        window.uiBridge.sceneEvents.length = 0;
        window.uiBridge.scenePatches.length = 0;
      });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '场景' });
      await expect(dialog).toHaveCount(1);
      await dialog.getByRole('textbox', { name: '场景设定' }).fill(`临时设定 ${route}`);
      expect(
        await page.evaluate(() => window.uiBridge.scenePatches.filter((patch) => patch.summary !== undefined)),
      ).toHaveLength(0);
      if (route === 'save') await dialog.getByRole('button', { name: '保存当前场景' }).click();
      else if (route === 'switch') await dialog.getByRole('button', { name: '从这里切换场景' }).click();
      else if (route === 'button') await dialog.locator('.modal-head').getByRole('button', { name: '关闭' }).click();
      else if (route === 'scrim') await page.locator('.dialog-scrim').click({ position: { x: 4, y: 4 } });
      else await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      const result = await page.evaluate(() => ({
        events: window.uiBridge.sceneEvents,
        patches: window.uiBridge.scenePatches,
      }));
      expect(result.patches.filter((patch) => patch.summary === `临时设定 ${route}`)).toHaveLength(1);
      expect(result.events.filter((event) => event === 'close')).toHaveLength(1);
      expect(result.events.at(-1)).toBe('close');
      expect(result.events.filter((event) => event === 'start')).toHaveLength(route === 'switch' ? 1 : 0);
    }
  } finally {
    await context.close();
  }
});
