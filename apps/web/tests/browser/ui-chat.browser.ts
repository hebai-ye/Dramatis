import { expect, type Page, test } from '@playwright/test';

interface AppendScrollProbe {
  observed91: boolean;
  observedGap: number | null;
  callsAtObservation: number;
  injections: number;
  containerCalls: number;
  ancestorCalls: number;
  events: string[];
  cleanup: () => void;
}

declare global {
  interface Window {
    uiAppendScrollProbe?: AppendScrollProbe;
  }
}

async function afterPaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }),
  );
}

async function position(page: Page, id: string) {
  return page.evaluate((messageId) => {
    const body = document.querySelector<HTMLElement>('.chat-body');
    if (!body) throw new Error('Missing chat body');
    const target = Array.from(body.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.dataset.messageId === messageId,
    );
    const bodyRect = body.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    return {
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      maxScroll: body.scrollHeight - body.clientHeight,
      targetVisible: !!targetRect && targetRect.top < bodyRect.bottom && targetRect.bottom > bodyRect.top,
      targetExists: !!target,
    };
  }, id);
}

test('B05 real chat scroll preserves old focus, marks new messages, and resumes follow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto('/tests/ui/index.html?fixture=chat');
    const body = page.locator('.chat-body');
    await expect(page.locator('[data-message-id]')).toHaveCount(90);
    const height = await body.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(height).toBeGreaterThan(1000);
    await page.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 1));
    await expect(page.getByRole('button', { name: /回到底部/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.uiBridge.consumed.length)).toBe(1);
    await expect.poll(() => position(page, 'fixture-message-10').then((state) => state.targetVisible)).toBe(true);
    const beforeAppend = await position(page, 'fixture-message-10');
    expect(beforeAppend.scrollTop).toBeLessThan(height / 2);
    await page.evaluate(() => window.uiBridge.appendMessage());
    await expect(page.getByRole('button', { name: /有新消息/ })).toBeVisible();
    await expect(page.locator('[data-message-id]')).toHaveCount(91);
    await afterPaint(page);
    const afterAppend = await position(page, 'fixture-message-10');
    expect(afterAppend.scrollHeight).toBeGreaterThan(beforeAppend.scrollHeight);
    expect(afterAppend.targetVisible).toBe(true);
    expect(Math.abs(afterAppend.scrollTop - beforeAppend.scrollTop)).toBeLessThan(2);
    await page.getByRole('button', { name: /有新消息/ }).click();
    await expect
      .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(80);
    await expect(page.locator('.jump-to-latest')).toHaveCount(0);
    const beforeFollow = await position(page, 'fixture-message-10');
    await page.evaluate(() => window.uiBridge.appendMessage());
    await expect(page.locator('[data-message-id]')).toHaveCount(92);
    await expect
      .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(80);
    expect((await position(page, 'fixture-message-10')).scrollHeight).toBeGreaterThan(beforeFollow.scrollHeight);
    await body.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(page.getByRole('button', { name: /回到底部/ })).toBeVisible();
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(page.locator('.jump-to-latest')).toHaveCount(0);
    const beforeManualFollow = await position(page, 'fixture-message-10');
    await page.evaluate(() => window.uiBridge.appendMessage());
    await expect(page.locator('[data-message-id]')).toHaveCount(93);
    await expect
      .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(80);
    expect((await position(page, 'fixture-message-10')).scrollHeight).toBeGreaterThan(beforeManualFollow.scrollHeight);
  } finally {
    await context.close();
  }
});

test('B05 repeated seq, delayed target, and cross conversation focus consumption', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto('/tests/ui/index.html?fixture=chat');
    await expect(page.locator('[data-message-id]')).toHaveCount(90);
    await page.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 1, 'second'));
    await expect(page.getByTestId('chat-fixture')).toHaveAttribute('data-focus-seq', '1');
    await afterPaint(page);
    expect(await page.evaluate(() => window.uiBridge.consumed.length)).toBe(0);
    await page.evaluate(() => window.uiBridge.includeTarget(false));
    await expect(page.locator('[data-message-id]')).toHaveCount(89);
    expect((await position(page, 'fixture-message-10')).targetExists).toBe(false);
    await page.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 2));
    await expect(page.getByTestId('chat-fixture')).toHaveAttribute('data-focus-seq', '2');
    await afterPaint(page);
    expect(await page.evaluate(() => window.uiBridge.consumed.length)).toBe(0);
    await page.evaluate(() => window.uiBridge.includeTarget(true));
    await expect.poll(() => page.evaluate(() => window.uiBridge.consumed.map((item) => item.seq))).toEqual([2]);
    await expect.poll(() => position(page, 'fixture-message-10').then((state) => state.targetVisible)).toBe(true);
    await bodyScrollToBottom(page);
    await expect.poll(() => position(page, 'fixture-message-10').then((state) => state.targetVisible)).toBe(false);
    await page.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 3));
    await expect.poll(() => page.evaluate(() => window.uiBridge.consumed.map((item) => item.seq))).toEqual([2, 3]);
    await expect.poll(() => position(page, 'fixture-message-10').then((state) => state.targetVisible)).toBe(true);
    await page.evaluate(() => window.uiBridge.setConversation('second'));
    await expect(page.getByTestId('chat-fixture')).toHaveAttribute('data-conversation', 'second');
    await expect(page.locator('[data-message-id]')).toHaveCount(90);
    await page.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 4, 'first'));
    await expect(page.getByTestId('chat-fixture')).toHaveAttribute('data-focus-seq', '4');
    await afterPaint(page);
    expect(await page.evaluate(() => window.uiBridge.consumed.map((item) => item.seq))).toEqual([2, 3]);
  } finally {
    await context.close();
  }
});

async function bodyScrollToBottom(page: Page) {
  await page.locator('.chat-body').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await afterPaint(page);
}

test('B05 switching conversations clears old away state and follows independent history', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto('/tests/ui/index.html?fixture=chat');
    await expect(page.locator('[data-message-id]')).toHaveCount(90);
    await page.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 1));
    await expect(page.getByRole('button', { name: /回到底部/ })).toBeVisible();
    await page.evaluate(() => window.uiBridge.setConversation('second'));
    await expect(page.getByTestId('chat-fixture')).toHaveAttribute('data-conversation', 'second');
    await expect(page.locator('[data-message-id]')).toHaveCount(90);
    await expect(page.locator('[data-message-id="other-message-10"]')).toBeVisible();
    await expect(page.locator('.jump-to-latest')).toHaveCount(0);
    await expect
      .poll(() => position(page, 'other-message-10').then((state) => state.maxScroll - state.scrollTop))
      .toBeLessThan(80);
    const before = await position(page, 'other-message-10');
    await page.evaluate(() => window.uiBridge.appendMessage());
    await expect(page.locator('[data-message-id]')).toHaveCount(91);
    await expect
      .poll(() => position(page, 'other-message-10').then((state) => state.maxScroll - state.scrollTop))
      .toBeLessThan(80);
    expect((await position(page, 'other-message-10')).scrollHeight).toBeGreaterThan(before.scrollHeight);
    await page.evaluate(() => window.uiBridge.setConversation('first'));
    await expect(page.getByTestId('chat-fixture')).toHaveAttribute('data-conversation', 'first');
    await expect(page.locator('[data-message-id]')).toHaveCount(90);
    await expect(page.locator('[data-message-id="new-message-second-90"]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('B05 append follows after an early post-commit scroll event', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  let page: Page | undefined;
  try {
    page = await context.newPage();
    const fixturePage = page;
    await fixturePage.goto('/tests/ui/index.html?fixture=chat');
    await expect(fixturePage.locator('[data-message-id]')).toHaveCount(90);
    await fixturePage.evaluate(() => window.uiBridge.setFocus('fixture-message-10', 1));
    await expect(fixturePage.getByRole('button', { name: /回到底部/ })).toBeVisible();
    await fixturePage.evaluate(() => window.uiBridge.setConversation('second'));
    await expect(fixturePage.getByTestId('chat-fixture')).toHaveAttribute('data-conversation', 'second');
    await expect(fixturePage.locator('[data-message-id]')).toHaveCount(90);
    await expect(fixturePage.locator('.jump-to-latest')).toHaveCount(0);
    await expect
      .poll(() => position(fixturePage, 'other-message-10').then((state) => state.maxScroll - state.scrollTop))
      .toBeLessThan(80);
    const before = await position(fixturePage, 'other-message-10');

    await fixturePage.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.chat-body');
      if (!body) throw new Error('Missing chat body');
      const original = body.scrollTo;
      const originalIntoView = Element.prototype.scrollIntoView;
      const probe: AppendScrollProbe = {
        observed91: false,
        observedGap: null,
        callsAtObservation: 0,
        injections: 0,
        containerCalls: 0,
        ancestorCalls: 0,
        events: [],
        cleanup: () => {},
      };
      window.uiAppendScrollProbe = probe;
      // MainChat follows inside its own viewport; ancestor scrolling would move the app shell.
      body.scrollTo = ((...args: [number, number] | [ScrollToOptions]) => {
        probe.containerCalls += 1;
        probe.events.push('container');
        Reflect.apply(original, body, args);
      }) as HTMLElement['scrollTo'];
      Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
        probe.ancestorCalls += 1;
        originalIntoView.call(this, options);
      };
      const observer = new MutationObserver(() => {
        if (probe.observed91 || body.querySelectorAll('[data-message-id]').length !== 91) return;
        observer.disconnect();
        probe.observed91 = true;
        probe.observedGap = body.scrollHeight - body.clientHeight - body.scrollTop;
        probe.callsAtObservation = probe.containerCalls;
        probe.events.push('observed-91');
        // Deliberately exercise a scroll between DOM commit and passive follow effects.
        // This tests the timing vulnerability; it does not claim to reproduce the earlier flaky failure.
        // A layout effect may already have followed before this observer gets its turn.
        if (probe.observedGap > 80 && probe.containerCalls === 0) {
          probe.injections += 1;
          probe.events.push('injected-scroll');
          body.dispatchEvent(new Event('scroll'));
        }
      });
      probe.cleanup = () => {
        observer.disconnect();
        body.scrollTo = original;
        Element.prototype.scrollIntoView = originalIntoView;
        delete window.uiAppendScrollProbe;
      };
      observer.observe(body, { childList: true, subtree: true });
      window.uiBridge.appendMessage();
    });

    await expect(fixturePage.locator('[data-message-id]')).toHaveCount(91);
    const observed = await fixturePage.evaluate(() => {
      const probe = window.uiAppendScrollProbe;
      if (!probe) throw new Error('Missing append scroll probe');
      return {
        observed91: probe.observed91,
        gap: probe.observedGap,
        calls: probe.callsAtObservation,
        injections: probe.injections,
      };
    });
    expect(observed.observed91).toBe(true);
    expect((observed.gap !== null && observed.gap > 80) || observed.calls > 0).toBe(true);
    if (observed.calls === 0) {
      expect(observed.injections).toBe(1);
    } else {
      expect(observed.injections).toBe(0);
    }
    await expect
      .poll(() => position(fixturePage, 'other-message-10').then((state) => state.maxScroll - state.scrollTop))
      .toBeLessThan(80);
    expect((await position(fixturePage, 'other-message-10')).scrollHeight).toBeGreaterThan(before.scrollHeight);
    const followed = await fixturePage.evaluate(() => {
      const probe = window.uiAppendScrollProbe;
      if (!probe) throw new Error('Missing append scroll probe');
      return { containerCalls: probe.containerCalls, ancestorCalls: probe.ancestorCalls, events: probe.events };
    });
    expect(followed.containerCalls).toBeGreaterThan(0);
    expect(followed.ancestorCalls).toBe(0);
    if (observed.injections === 1) {
      expect(followed.events.indexOf('injected-scroll')).toBeLessThan(followed.events.indexOf('container'));
    }
  } finally {
    if (page && !page.isClosed()) {
      await page.evaluate(() => window.uiAppendScrollProbe?.cleanup()).catch(() => {});
    }
    await context.close();
  }
});
