import { randomUUID } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';

declare global {
  interface Window {
    q7: {
      events: string[];
      open(name: string): Promise<{ version: number; indexes: string[] }>;
      nativeOpen(name: string, version: number, oldSchema?: boolean): Promise<number>;
      closeNative(name: string): void;
      closeProduction(name: string): void;
      put(
        name: string,
        collection: string,
        value: { id: string; roomId?: string; updatedAt?: string; text?: string },
      ): Promise<void>;
      get(
        name: string,
        collection: string,
        id: string,
      ): Promise<{ id: string; roomId?: string; text?: string } | null | undefined>;
      list(name: string, collection: string, roomId: string): Promise<Array<{ id: string }>>;
      transaction(name: string, rollback: boolean): Promise<string>;
      autoCommitAfterNativeComplete(name: string): Promise<{
        captured: boolean;
        nestedTransactionAvailable: boolean | null;
        completedBeforeSecond: boolean;
        secondAttempted: boolean;
        secondPutRejectionName: string | null;
        rejectionName: string | null;
      }>;
      deleteBlocked(name: string): Promise<void>;
      waitNativeDelete(name: string): Promise<'success' | 'error'>;
      nativeDeleteStatus(name: string): 'pending' | 'success' | 'error' | null;
      cleanup(name: string): Promise<void>;
    };
  }
}

async function withPages(browser: Browser, run: (a: Page, b: Page, name: string) => Promise<void>): Promise<void> {
  const name = `q7-test-${randomUUID()}`;
  const context = await browser.newContext();
  let a: Page | undefined;
  let b: Page | undefined;
  try {
    a = await context.newPage();
    b = await context.newPage();
    await Promise.all([a.goto('/tests/browser/idb-harness.html'), b.goto('/tests/browser/idb-harness.html')]);
    await Promise.all([a.waitForFunction(() => !!window.q7), b.waitForFunction(() => !!window.q7)]);
    await run(a, b, name);
  } finally {
    try {
      for (const page of [a, b]) {
        if (page && !page.isClosed()) {
          await page
            .evaluate((dbName) => {
              window.q7.closeProduction(dbName);
              window.q7.closeNative(dbName);
            }, name)
            .catch(() => undefined);
        }
      }
      let cleaner = [b, a].find((page) => page && !page.isClosed());
      if (!cleaner) {
        cleaner = await context.newPage();
        await cleaner.goto('/tests/browser/idb-harness.html');
        await cleaner.waitForFunction(() => !!window.q7);
      }
      await cleaner.evaluate((dbName) => window.q7.cleanup(dbName), name);
    } finally {
      await context.close();
    }
  }
}

test('real Chromium commits/rolls back across collections and preserves clone/index semantics', async ({ browser }) => {
  await withPages(browser, async (a, b, name) => {
    const schema = await a.evaluate((dbName) => window.q7.open(dbName), name);
    expect(schema).toEqual({ version: 2, indexes: ['byCollection', 'byCollectionRoom', 'byCollectionUpdated'] });
    expect(await a.evaluate((dbName) => window.q7.transaction(dbName, false), name)).toBe('committed');
    expect(await a.evaluate((dbName) => window.q7.transaction(dbName, true), name)).toBe('rolled-back');
    expect(
      await b.evaluate(async (dbName) => {
        await window.q7.open(dbName);
        return Promise.all([
          window.q7.get(dbName, 'messages', 'commit-m'),
          window.q7.get(dbName, 'memories', 'commit-a'),
          window.q7.get(dbName, 'messages', 'rollback-m'),
          window.q7.get(dbName, 'memories', 'rollback-a'),
        ]);
      }, name),
    ).toEqual([{ id: 'commit-m', roomId: 'room' }, { id: 'commit-a', roomId: 'room' }, null, null]);
    const values = await a.evaluate(async (dbName) => {
      const input = { id: 'same', roomId: 'r1', updatedAt: '2026-01-01T00:00:00Z', text: 'first' };
      await window.q7.put(dbName, 'messages', input);
      input.text = 'changed after put';
      const first = await window.q7.get(dbName, 'messages', 'same');
      await window.q7.put(dbName, 'messages', { id: 'same', roomId: 'r2', text: 'replacement' });
      return {
        first,
        inR1: await window.q7.list(dbName, 'messages', 'r1'),
        inR2: await window.q7.list(dbName, 'messages', 'r2'),
      };
    }, name);
    expect(values.first?.text).toBe('first');
    expect(values.inR1).toEqual([]);
    expect(values.inR2).toEqual([{ id: 'same', roomId: 'r2', text: 'replacement' }]);
  });
});

test('a non-IDB await lets the native transaction commit before a later put', async ({ browser }) => {
  await withPages(browser, async (a, b, name) => {
    await a.evaluate((dbName) => window.q7.open(dbName), name);
    const outcome = await a.evaluate((dbName) => window.q7.autoCommitAfterNativeComplete(dbName), name);
    expect(outcome).toMatchObject({
      captured: true,
      nestedTransactionAvailable: false,
      completedBeforeSecond: true,
      secondAttempted: true,
    });
    expect(outcome.secondPutRejectionName).not.toBeNull();
    expect(outcome.rejectionName).not.toBeNull();
    expect(
      await b.evaluate(async (dbName) => {
        await window.q7.open(dbName);
        return [
          await window.q7.get(dbName, 'messages', 'auto-first'),
          await window.q7.get(dbName, 'messages', 'auto-second'),
        ];
      }, name),
    ).toEqual([{ id: 'auto-first', text: 'persisted before callback returned' }, null]);
  });
});

test('a v1 connection in one page blocks production upgrade in another until closed', async ({ browser }) => {
  await withPages(browser, async (a, b, name) => {
    expect(await a.evaluate((dbName) => window.q7.nativeOpen(dbName, 1, true), name)).toBe(1);
    const opening = b.evaluate((dbName) => window.q7.open(dbName), name);
    await b.waitForFunction(() => window.q7.events.includes('blocked'));
    await a.evaluate((dbName) => window.q7.closeNative(dbName), name);
    expect(await opening).toMatchObject({ version: 2 });
  });
});

test('production connection closes on versionchange and lets another page open v3', async ({ browser }) => {
  await withPages(browser, async (a, b, name) => {
    await a.evaluate((dbName) => window.q7.open(dbName), name);
    const upgrading = b.evaluate((dbName) => window.q7.nativeOpen(dbName, 3), name);
    await a.waitForFunction(() => window.q7.events.includes('blocking'));
    expect(await upgrading).toBe(3);
  });
});

test('delete reports blocking while another page holds a connection', async ({ browser }) => {
  await withPages(browser, async (a, b, name) => {
    await a.evaluate((dbName) => window.q7.nativeOpen(dbName, 1, true), name);
    await expect(b.evaluate((dbName) => window.q7.deleteBlocked(dbName), name)).rejects.toThrow('delete blocked');
    expect(await b.evaluate((dbName) => window.q7.nativeDeleteStatus(dbName), name)).toBe('pending');
    await a.evaluate((dbName) => window.q7.closeNative(dbName), name);
    expect(await b.evaluate((dbName) => window.q7.waitNativeDelete(dbName), name)).toBe('success');
  });
});

test('a reopened page reads the previous page’s durable write', async ({ browser }) => {
  await withPages(browser, async (a, b, name) => {
    await a.evaluate(async (dbName) => {
      await window.q7.open(dbName);
      await window.q7.put(dbName, 'messages', { id: 'durable', text: 'from-first-page' });
      window.q7.closeProduction(dbName);
    }, name);
    await a.close();
    expect(
      await b.evaluate(async (dbName) => {
        await window.q7.open(dbName);
        return window.q7.get(dbName, 'messages', 'durable');
      }, name),
    ).toEqual({ id: 'durable', text: 'from-first-page' });
  });
});
