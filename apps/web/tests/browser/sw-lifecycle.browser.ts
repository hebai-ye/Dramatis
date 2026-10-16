import { expect, shellContract, test } from '../sw/fixture';

test('same actual worker bytes: controlled B navigation publishes B; fresh offline launch and both lazy generations work', async ({
  sw,
  context,
}) => {
  await sw.install();
  const before = await sw.pointer();
  const hashA = await sw.sourceHash();
  expect(hashA).toBe(sw.host.workerHash);
  const oldTab = sw.page;
  expect(await oldTab.evaluate(() => window.fixture.main)).toBe('A');
  expect(
    sw.host.requests.filter((request) => request.path === '/assets/lazy-A.js' && request.destination === 'script'),
  ).toHaveLength(0);

  await sw.stopCurrentWorker();
  sw.host.deploy('B');
  const heldLazy = sw.host.barrier((request) => request.path === '/assets/lazy-B.js');
  const tabB = await context.newPage();
  const navigation = sw.navigate(tabB);
  navigation.catch(() => undefined);
  await heldLazy.entered;
  // Staging has begun, but the publication pointer is still A until every
  // module (including the unopened lazy graph) is successfully downloaded.
  expect(await sw.pointer()).toEqual(before);
  heldLazy.release();
  await navigation;
  const next = await sw.waitShell('B');
  await sw.idle();
  expect(next.active).not.toBe(before?.active);
  expect(next.previous).toBe(before?.active);
  expect(await sw.sourceHash()).toBe(hashA);
  expect(await tabB.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${sw.host.origin}/sw.js`);
  expect(
    sw.host.requests.filter((request) => request.path === '/assets/lazy-B.js' && request.destination === 'script'),
  ).toHaveLength(0);

  await context.setOffline(true);
  const offlineTab = await context.newPage();
  await sw.navigate(offlineTab);
  await expect(offlineTab.locator('#version')).toHaveText('B');
  expect(await offlineTab.evaluate(() => window.fixture.eager)).toBe('eager B');
  expect(await offlineTab.evaluate(() => window.fixture.loadLazy())).toBe('lazy B: dependency B');
  expect(await oldTab.evaluate(() => window.fixture.loadLazy())).toBe('lazy A: dependency A');
  expect(await offlineTab.evaluate(async () => (await fetch('/manifest.webmanifest')).json())).toMatchObject({
    name: 'B',
  });
  expect(await offlineTab.evaluate(async () => (await fetch('/icon-192.png')).text())).toContain('icon B');
});

test('unchanged module list refreshes HTML and stable public icon after a real worker restart', async ({
  sw,
  context,
}) => {
  await sw.install();
  const initial = await sw.pointer();
  const hashA = await sw.sourceHash();
  sw.host.deploy('C', 'A');
  await sw.stopCurrentWorker();
  const current = await context.newPage();
  await sw.navigate(current);
  const pointer = await sw.waitShell('C');
  await sw.idle();
  expect(pointer.active).not.toBe(initial?.active);
  expect(await sw.sourceHash()).toBe(hashA);
  const list = await sw.cached(pointer.active, '/assets/shell-assets.json');
  if (!list) throw new Error('Published asset manifest is missing');
  expect(JSON.parse(list).files).toContain('/assets/lazy-A.js');
  await context.setOffline(true);
  const offline = await context.newPage();
  await sw.navigate(offline);
  await expect(offline.locator('#version')).toHaveText('C');
  expect(await offline.evaluate(() => window.fixture.loadLazy())).toBe('lazy A: dependency A');
  expect(await offline.evaluate(async () => (await fetch('/icon-192.png')).text())).toContain('icon C');
});

test('failed real staging keeps A offline, and a later controlled navigation retries successfully', async ({
  sw,
  context,
}) => {
  await sw.install();
  const before = await sw.pointer();
  sw.host.deploy('B');
  sw.host.fail('/assets/lazy-B.js');
  const failure = sw.host.barrier((request) => request.path === '/assets/lazy-B.js');
  await sw.stopCurrentWorker();
  const online = await context.newPage();
  const navigation = sw.navigate(online);
  navigation.catch(() => undefined);
  await failure.entered;
  expect(await sw.pointer()).toEqual(before);
  failure.release();
  await navigation;
  await sw.idle();
  expect(await sw.pointer()).toEqual(before);
  await context.setOffline(true);
  const offline = await context.newPage();
  await sw.navigate(offline);
  await expect(offline.locator('#version')).toHaveText('A');
  expect(await offline.evaluate(() => window.fixture.loadLazy())).toBe('lazy A: dependency A');
  await context.setOffline(false);
  sw.host.clearFailures();
  await sw.stopCurrentWorker();
  await sw.navigate(online);
  await sw.waitShell('B');
  await sw.idle();
});

test('runtime portrait survives shell replacement; HTTP failure retains it and successful revalidation updates it', async ({
  sw,
  context,
}) => {
  await sw.install();
  expect(await sw.page.evaluate(async () => (await fetch('/portraits/01.webp')).text())).toContain('portrait A');
  await expect.poll(() => sw.cached(shellContract.images, '/portraits/01.webp')).toContain('portrait A');
  sw.host.deploy('B');
  sw.host.fail('/portraits/01.webp');
  const failedImage = sw.host.barrier((request) => request.path === '/portraits/01.webp');
  expect(await sw.page.evaluate(async () => (await fetch('/portraits/01.webp')).text())).toContain('portrait A');
  await failedImage.entered;
  failedImage.release();
  await expect
    .poll(() =>
      sw.page.evaluate(async (name) => {
        const locks = await navigator.locks.query();
        return [...(locks.held ?? []), ...(locks.pending ?? [])].filter((lock) => lock.name === name).length;
      }, `dramatis-image-update-v1:${sw.host.origin}/portraits/01.webp`),
    )
    .toBe(0);
  // Wait for the real network operation, then prove the retained image is
  // usable while offline. No injected CacheStorage values participate.
  await context.setOffline(true);
  expect(await sw.page.evaluate(async () => (await fetch('/portraits/01.webp')).text())).toContain('portrait A');
  await context.setOffline(false);
  await sw.stopCurrentWorker();
  await sw.navigate(sw.page);
  await sw.waitShell('B');
  await sw.idle();
  expect(await sw.cached(shellContract.images, '/portraits/01.webp')).toContain('portrait A');
  sw.host.clearFailures();
  const refreshed = sw.host.barrier((request) => request.path === '/portraits/01.webp');
  expect(await sw.page.evaluate(async () => (await fetch('/portraits/01.webp')).text())).toContain('portrait A');
  await refreshed.entered;
  refreshed.release();
  await expect.poll(() => sw.cached(shellContract.images, '/portraits/01.webp')).toContain('portrait B');
  await context.setOffline(true);
  expect(await sw.page.evaluate(async () => (await fetch('/portraits/01.webp')).text())).toContain('portrait B');
});

test('two actual worker versions serialize staging through WorkerNavigator Web Locks', async ({ sw, context }) => {
  await sw.install();
  const before = await sw.pointer();
  await sw.stopCurrentWorker();
  // Only the old worker staging /index.html fetch is paused, not navigation.
  const held = sw.host.barrier((request) => request.path === '/index.html' && request.destination === 'empty');
  const oldNavigation = sw.navigate(await context.newPage());
  oldNavigation.catch(() => undefined);
  await held.entered;
  sw.host.deploy('B');
  const installing = sw.register('?generation=two');
  installing.catch(() => undefined);
  await expect.poll(() => sw.workers.some((worker) => worker.url().endsWith('?generation=two'))).toBe(true);
  const candidate = sw.workers.find((worker) => worker.url().endsWith('?generation=two'));
  if (!candidate) throw new Error('Owned candidate worker was not observed');
  expect(await candidate.evaluate(() => typeof navigator.locks?.request === 'function')).toBe(true);
  await expect
    .poll(() =>
      sw.page.evaluate(async (name) => {
        const locks = await navigator.locks.query();
        return {
          held: (locks.held ?? []).filter((lock) => lock.name === name).length,
          pending: (locks.pending ?? []).filter((lock) => lock.name === name).length,
        };
      }, shellContract.lock),
    )
    .toMatchObject({ held: 1, pending: 1 });
  expect(await sw.pointer()).toEqual(before);
  held.release();
  // Captured A HTML with current B manifest must be rejected; the queued new
  // worker then obtains the native lock and publishes the complete B shell.
  await Promise.all([oldNavigation, installing]);
  await sw.waitShell('B');
  await sw.idle();
  expect(await sw.sourceHash()).toBe(sw.host.workerHash);
  await expect
    .poll(() => sw.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
    .toBe(`${sw.host.origin}/sw.js?generation=two`);
  await context.setOffline(true);
  const offline = await context.newPage();
  await sw.navigate(offline);
  await expect(offline.locator('#version')).toHaveText('B');
});

test('an old captured A navigation cannot publish A after a new worker has published B', async ({ sw, context }) => {
  await sw.install();
  await sw.stopCurrentWorker();
  const capturedA = sw.host.barrier((request) => request.path === '/' && request.destination === 'document');
  const staleTab = await context.newPage();
  const staleNavigation = sw.navigate(staleTab);
  staleNavigation.catch(() => undefined);
  await capturedA.entered;
  sw.host.deploy('B');
  const installing = sw.register('?generation=newer');
  installing.catch(() => undefined);
  await sw.waitShell('B');
  await sw.idle();
  capturedA.release();
  await Promise.all([staleNavigation, installing]);
  await expect(staleTab.locator('#version')).toHaveText('A');
  // Read-only observation of the real lock and cache ensures the old pending
  // fetch lifetime has completed before judging the final publication state.
  await expect
    .poll(() => sw.host.requests.filter((request) => request.path === '/index.html' && request.version === 'B').length)
    .toBeGreaterThanOrEqual(3);
  await sw.idle();
  await sw.waitShell('B');
  await context.setOffline(true);
  const offline = await context.newPage();
  await sw.navigate(offline);
  await expect(offline.locator('#version')).toHaveText('B');
  expect(await staleTab.evaluate(() => window.fixture.loadLazy())).toBe('lazy A: dependency A');
});
