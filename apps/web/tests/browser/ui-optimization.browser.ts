import { expect, test } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  // Fixtures never contact a model, existing bridge service or another origin.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === 'http://127.0.0.1:6287' ? route.continue() : route.abort(),
  );
  await context.routeWebSocket(/.*/, (socket) => {
    socket.close();
  });
});
const fixture = '/tests/ui/optimization.html';

test('scene explicit save blocks repeat actions and retains rejected input', async ({ page }) => {
  await page.goto(`${fixture}?fixture=scene`);
  await page.getByTestId('open-scene').click();
  const dialog = page.getByRole('dialog', { name: '场景', exact: true });
  await dialog.getByRole('textbox', { name: '场景名', exact: true }).fill('修改后场景');
  await page.evaluate(() => {
    window.optimization.mode = 'defer';
  });
  await dialog.getByRole('button', { name: '保存当前场景' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect
    .poll(() => page.evaluate(() => window.optimization.calls.filter((call) => call.operation === 'save').length))
    .toBe(1);
  await expect(dialog.getByRole('button', { name: '正在保存…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    window.optimization.settle(false);
  });
  await expect(dialog.getByRole('alert')).toContainText('已保留输入');
  await expect(dialog.getByRole('textbox', { name: '场景名', exact: true })).toHaveValue('修改后场景');
  await page.evaluate(() => {
    window.optimization.mode = 'immediate';
  });
  await dialog.getByRole('button', { name: '保存当前场景' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.optimization.calls.filter((call) => call.operation === 'close').length))
    .toBe(1);
});

test('travel selections remain dirty after saving current fields, cancel preserves them', async ({ page }) => {
  await page.goto(`${fixture}?fixture=scene`);
  await page.getByTestId('open-scene').click();
  const dialog = page.getByRole('dialog', { name: '场景', exact: true });
  await dialog.getByRole('checkbox', { name: '阿青' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alertdialog')).toContainText('同行勾选');
  await dialog.getByRole('button', { name: '继续编辑' }).click();
  await expect(dialog.getByRole('checkbox', { name: '阿青' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '保存当前场景' }).click();
  await expect(dialog.getByRole('alertdialog')).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '阿青' })).not.toBeChecked();
  await dialog.locator('.modal-head').getByRole('button', { name: '关闭' }).click();
  await dialog.getByRole('button', { name: '放弃更改并继续' }).click();
  await expect(dialog).toHaveCount(0);
});

test('summary commits in order and close waits for all accepted writes', async ({ page }) => {
  await page.goto(`${fixture}?fixture=scene`);
  await page.getByTestId('open-scene').click();
  await page.evaluate(() => {
    window.optimization.mode = 'defer';
  });
  const dialog = page.getByRole('dialog', { name: '场景', exact: true });
  const summary = dialog.getByRole('textbox', { name: '场景设定', exact: true });
  await summary.fill('设定 A');
  await expect.poll(() => page.evaluate(() => window.optimization.calls.length)).toBe(1);
  await summary.fill('设定 B');
  // Wait beyond the actual debounce to admit a second queued write behind A.
  await page.waitForTimeout(350);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.optimization.calls.length)).toBe(1);
  await page.evaluate(() => {
    window.optimization.settle(true);
  });
  await expect.poll(() => page.evaluate(() => window.optimization.calls.length)).toBe(2);
  await page.evaluate(() => {
    window.optimization.settle(true);
  });
  await expect(dialog.getByText('正在自动保存场景设定…')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.optimization.calls)).toEqual([
    { operation: 'save', value: { summary: '设定 A' } },
    { operation: 'save', value: { summary: '设定 B' } },
    { operation: 'close', value: null },
  ]);
});

test('summary failure and composition keep input; retry completes before close', async ({ page }) => {
  await page.goto(`${fixture}?fixture=scene`);
  await page.getByTestId('open-scene').click();
  const dialog = page.getByRole('dialog', { name: '场景', exact: true });
  const summary = dialog.getByRole('textbox', { name: '场景设定', exact: true });
  await page.evaluate(() => {
    window.optimization.mode = 'fail';
  });
  await summary.dispatchEvent('compositionstart');
  await summary.fill('组合输入草稿');
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.optimization.calls.length)).toBe(0);
  await expect(dialog.getByRole('button', { name: '保存当前场景' })).toBeDisabled();
  await summary.dispatchEvent('compositionend');
  await expect(dialog.getByRole('alert')).toContainText('草稿已保留');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(summary).toHaveValue('组合输入草稿');
  await page.evaluate(() => {
    window.optimization.mode = 'immediate';
  });
  await dialog.getByRole('button', { name: '重试保存场景设定' }).click();
  await expect(dialog.getByText('草稿已保留', { exact: false })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('partial scene switch remains visible and cannot create another scene', async ({ page }) => {
  await page.goto(`${fixture}?fixture=scene`);
  await page.getByTestId('open-scene').click();
  await page.evaluate(() => {
    window.optimization.switchResult = { status: 'partial', message: '旁白写入失败' };
  });
  const dialog = page.getByRole('dialog', { name: '场景', exact: true });
  await dialog.getByRole('textbox', { name: '场景名', exact: true }).fill('  ');
  await dialog.getByRole('button', { name: '从这里切换场景' }).click();
  await expect(dialog.getByRole('status')).toContainText('场景已切换');
  await expect(dialog.getByRole('button', { name: '从这里切换场景' })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: '场景名', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: '场景名', exact: true })).toHaveValue('新场景');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => window.optimization.calls.filter((call) => call.operation === 'switch').length),
  ).toBe(1);
});

test('external scene replacement keeps the old draft and refuses to write to the new target', async ({ page }) => {
  await page.goto(`${fixture}?fixture=scene`);
  await page.getByTestId('open-scene').click();
  const dialog = page.getByRole('dialog', { name: '场景', exact: true });
  await dialog.getByRole('textbox', { name: '场景名', exact: true }).fill('旧目标未保存标题');
  const summary = dialog.getByRole('textbox', { name: '场景设定', exact: true });
  await summary.dispatchEvent('compositionstart');
  await summary.fill('旧目标未提交摘要');
  await page.evaluate(() => {
    window.optimization.replaceScene();
  });
  await expect(dialog.getByText('当前场景已变化', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '场景名', exact: true })).toHaveValue('旧目标未保存标题');
  await expect(summary).toHaveValue('旧目标未提交摘要');
  await expect(dialog.getByRole('button', { name: '保存当前场景' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '从这里切换场景' })).toBeDisabled();
  await dialog.locator('.modal-head').getByRole('button', { name: '关闭' }).click();
  await expect(dialog.getByRole('alertdialog')).toContainText('场景设定');
  await dialog.getByRole('button', { name: '继续编辑' }).click();
  await expect(summary).toHaveValue('旧目标未提交摘要');
  await dialog.locator('.modal-head').getByRole('button', { name: '关闭' }).click();
  await dialog.getByRole('button', { name: '放弃更改并继续' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.optimization.calls)).toEqual([{ operation: 'close', value: null }]);
});

test('material operation is card-local, prevents repeat and uses saved status', async ({ page }) => {
  await page.goto(`${fixture}?fixture=artifact`);
  const first = page.locator('.artifact').filter({ hasText: '阿青的角色卡' });
  const other = page.locator('.artifact').filter({ hasText: '酒馆老板' });
  await page.evaluate(() => {
    window.optimization.mode = 'defer';
  });
  await first.getByRole('button', { name: '采纳', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(first).toHaveAttribute('aria-busy', 'true');
  await expect(first.getByRole('button', { name: '丢弃', exact: true })).toBeDisabled();
  await expect(other.getByRole('button', { name: '采纳', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.optimization.calls.length)).toBe(1);
  await page.evaluate(() => {
    window.optimization.settle(false);
  });
  await expect(first.getByRole('alert')).toContainText('写入被拒');
  await expect(first).toContainText('待你决定');
  await page.evaluate(() => {
    window.optimization.mode = 'noop';
  });
  await first.getByRole('button', { name: '采纳', exact: true }).click();
  await expect(first).toHaveAttribute('aria-busy', 'false');
  await expect(first).toContainText('待你决定');
  await page.evaluate(() => {
    window.optimization.mode = 'immediate';
  });
  await first.getByRole('button', { name: '采纳', exact: true }).click();
  await expect(first).toContainText('已采纳');
  await first.getByRole('button', { name: '撤回这次采纳' }).click();
  await expect(first).toContainText('待你决定');
  await other.getByRole('button', { name: '丢弃', exact: true }).click();
  await expect(other).toContainText('已丢弃');
  const modified = page.locator('.artifact').filter({ hasText: '世界书修订' });
  await modified.getByRole('button', { name: '起草反向修改' }).click();
  await expect(modified).toContainText('已采纳');
  await expect(
    page.locator('.artifact').filter({ hasText: '过期草稿' }).getByRole('button', { name: '采纳', exact: true }),
  ).toBeDisabled();
});

test('bridge copy failure opens manual fallback and rejects stale completion', async ({ page }) => {
  await page.addInitScript(() => {
    const queue: Array<() => void> = [];
    Object.defineProperty(window, 'clipboardFixture', { value: { queue, fail: true, writes: [] as string[] } });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          const fixture = (window as unknown as { clipboardFixture: { fail: boolean; writes: string[] } })
            .clipboardFixture;
          fixture.writes.push(text);
          if (fixture.fail) return Promise.reject(new Error('Permission denied'));
          return new Promise<void>((resolve) => {
            queue.push(resolve);
          });
        },
        readText: () => Promise.resolve(''),
      },
    });
  });
  await page.goto(`${fixture}?fixture=bridge`);
  await page.getByRole('button', { name: '1. 复制提示词' }).click();
  await expect(page.getByRole('status')).toContainText('自动复制失败');
  await expect(page.locator('.bridge-prompt')).toHaveAttribute('open', '');
  await expect(page.locator('.bridge-prompt pre')).toHaveText('固定提示词：旧城酒馆');
  await page.evaluate(() => {
    (window as unknown as { clipboardFixture: { fail: boolean } }).clipboardFixture.fail = false;
  });
  await page.getByRole('button', { name: '1. 复制提示词' }).click();
  await expect(page.getByRole('button', { name: '正在复制…' })).toBeDisabled();
  await page.evaluate(() => {
    window.optimization.setPrompt('下一份提示词');
  });
  await expect(page.getByRole('button', { name: '1. 复制提示词' })).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { clipboardFixture: { queue: Array<() => void> } }).clipboardFixture.queue.shift()?.();
  });
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toHaveCount(0);
  await expect(page.getByText('自动复制失败', { exact: false })).toHaveCount(0);
  await expect(page.locator('.bridge-head')).toContainText('场景修改会立即应用');
});

test('helper blocks manual double submit and ignores previous prompt response', async ({ page }) => {
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('http://127.0.0.1:8791/**', async (route) => {
    if (route.request().url().endsWith('/health')) await route.fulfill({ json: { attached: true } });
    else {
      await response;
      await route.fulfill({ json: { text: '旧请求返回' } });
    }
  });
  await page.goto(`${fixture}?fixture=bridge`);
  await page.getByRole('textbox').fill('手动回复');
  await page.getByRole('button', { name: '一键用本地助手（免复制粘贴）' }).click();
  await expect(page.getByRole('button', { name: '收下这次起草' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '放弃这次起草' })).toBeDisabled();
  await page.evaluate(() => {
    window.optimization.setPrompt('新的请求目标');
  });
  release();
  await expect(page.getByRole('button', { name: '放弃这次起草' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.optimization.calls.length)).toBe(0);
  await expect(page.getByRole('textbox')).toHaveValue('手动回复');
});

test('world book counts entries once and keeps readable and raw add/delete data', async ({ page }) => {
  await page.goto(`${fixture}?fixture=diff`);
  await expect(page.locator('.world-book-diff > .hint')).toHaveText(
    '新增 1 条 · 修改 1 条 · 删除 1 条 · 书级变化 1 项',
  );
  await expect(page.getByText('修改 · 世界书 · 书名', { exact: true })).toBeVisible();
  const added = page.locator('.world-book-diff > details').filter({ hasText: '新增条目「酒馆」' });
  await added.locator('> summary').click();
  await expect(added.locator('.world-book-entry-preview')).toContainText('新增正文\n第二行设定');
  await added.getByText('查看完整条目 JSON', { exact: true }).click();
  await expect(added.locator('pre')).toContainText('完整扩展');
  const deleted = page.locator('.world-book-diff > details').filter({ hasText: '明确删除条目「旧告示」' });
  await deleted.locator('> summary').click();
  await expect(deleted.locator('.world-book-entry-preview')).toContainText('删除正文');
  await deleted.getByText('查看完整条目 JSON', { exact: true }).click();
  await expect(deleted.locator('pre')).toContainText('"unknownFlag": true');
  await expect(deleted).toContainText('条目 ID：entry-delete');
});

test('changed interfaces fit mobile and desktop across all three themes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => Promise.reject(new Error('Permission denied')),
        readText: () => Promise.resolve(''),
      },
    });
  });
  for (const [width, theme, surface] of [
    [360, 'tavern', 'scene'],
    [390, 'light', 'bridge'],
    [640, 'dark', 'diff'],
    [1280, 'tavern', 'artifact'],
    [1280, 'light', 'scene'],
    [1280, 'dark', 'bridge'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fixture}?fixture=${surface}&theme=${theme}`);
    if (surface === 'scene') {
      await page.getByTestId('open-scene').click();
      await expect(page.getByRole('dialog', { name: '场景', exact: true })).toBeVisible();
    }
    if (surface === 'diff')
      await page.locator('.world-book-diff > details').evaluateAll((nodes) => {
        for (const node of nodes) (node as HTMLDetailsElement).open = true;
      });
    if (surface === 'bridge') {
      await page.getByRole('button', { name: '1. 复制提示词' }).click();
      await expect(page.getByRole('status')).toContainText('自动复制失败');
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-${width}-${theme}.png`), fullPage: true });
    if (surface === 'bridge') {
      await page.getByRole('button', { name: '放弃这次起草' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: '放弃这次起草' })).toBeInViewport();
    }
  }
});
