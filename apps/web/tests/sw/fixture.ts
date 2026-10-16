import { createHash } from 'node:crypto';
import { type BrowserContext, test as base, type CDPSession, expect, type Page, type Worker } from '@playwright/test';
import { createFixtureHost, type FixtureHost } from './fixture-host.mjs';

// Public CacheStorage contract, to be reviewed against final shipped sw.js.
export const shellContract = {
  control: 'dramatis-shell-control-v1',
  pointer: '/__dramatis/active-shell',
  images: 'dramatis-images-v1',
  lock: 'dramatis-shell-publish-v1',
};
export interface ShellPointer {
  active: string;
  previous: string | null;
}
interface Version {
  versionId: string;
  scriptURL: string;
  status: string;
  runningStatus: string;
}
declare global {
  interface Window {
    fixture: { main: string; eager: string; loadLazy(): Promise<string> };
  }
}

export class SwFixture {
  readonly workers: Worker[] = [];
  readonly versions = new Map<string, Version>();
  private session?: CDPSession;
  readonly externalRequests: string[] = [];

  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly host: FixtureHost,
  ) {}

  async prepare() {
    // Fresh Playwright test context, never a persistent browser profile. Routes
    // include SW-owned fetches where supported; CSP and fixed resources also
    // prevent the fixture from creating off-origin requests.
    await this.context.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === this.host.origin) await route.continue();
      else {
        this.externalRequests.push(route.request().url());
        await route.abort('blockedbyclient');
      }
    });
    this.context.on('serviceworker', (worker) => {
      if (new URL(worker.url()).origin === this.host.origin) this.workers.push(worker);
    });
    await this.page.goto(`${this.host.origin}/__fixture/bootstrap`);
    this.session = await this.context.newCDPSession(this.page);
    this.session.on('ServiceWorker.workerVersionUpdated', ({ versions }: { versions: Version[] }) => {
      for (const version of versions) {
        if (version.scriptURL.startsWith(`${this.host.origin}/`)) this.versions.set(version.versionId, version);
      }
    });
    await this.session.send('ServiceWorker.enable');
  }

  async register(query = '') {
    await this.page.evaluate(async (suffix) => {
      const registration = await navigator.serviceWorker.register(`/sw.js${suffix}`, {
        scope: '/',
        updateViaCache: 'none',
      });
      if (registration.active?.scriptURL.endsWith(`/sw.js${suffix}`) && registration.active.state === 'activated')
        return;
      const candidate = registration.installing ?? registration.waiting;
      if (!candidate) throw new Error('Registration did not expose the expected new worker');
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (candidate.state === 'activated') {
            candidate.removeEventListener('statechange', changed);
            resolve();
          }
          if (candidate.state === 'redundant') {
            candidate.removeEventListener('statechange', changed);
            reject(new Error('Fixture worker became redundant before activation'));
          }
        };
        candidate.addEventListener('statechange', changed);
        changed();
      });
    }, query);
  }

  async install() {
    await this.register();
    await this.waitShell('A');
    await this.idle();
    await this.navigate(this.page);
    await expect
      .poll(() => this.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
      .toBe(`${this.host.origin}/sw.js`);
    await expect.poll(() => this.workers.length).toBeGreaterThan(0);
    const worker = this.workers.find((item) => item.url() === `${this.host.origin}/sw.js`);
    if (!worker) throw new Error('Actual Chromium ServiceWorker target was not observed');
    const capabilities = await worker.evaluate(() => ({
      workerNavigator: Object.prototype.toString.call(navigator),
      locks: typeof navigator.locks?.request === 'function',
      cacheStorage: typeof caches.open === 'function',
    }));
    console.log(`SW capabilities ${JSON.stringify(capabilities)}`);
    expect(capabilities.workerNavigator).toBe('[object WorkerNavigator]');
    expect(
      capabilities.locks,
      'Actual service-worker Web Locks support is required; do not fake or silently skip it',
    ).toBe(true);
    expect(capabilities.cacheStorage).toBe(true);
  }

  async navigate(page: Page, path = '/') {
    const response = await page.goto(`${this.host.origin}${path}`);
    expect(response?.ok()).toBe(true);
    await page.waitForFunction(() => !!window.fixture);
    return response;
  }

  async pointer(): Promise<ShellPointer | null> {
    return this.page.evaluate(async ({ control, pointer }) => {
      const response = await (await caches.open(control)).match(pointer, { ignoreVary: true });
      return response ? response.json() : null;
    }, shellContract);
  }

  async cached(cache: string, path: string): Promise<string | null> {
    return this.page.evaluate(
      async ({ cacheName, resource }) => {
        const response = await (await caches.open(cacheName)).match(resource, { ignoreVary: true });
        return response ? response.text() : null;
      },
      { cacheName: cache, resource: path },
    );
  }

  async waitShell(version: string) {
    await expect
      .poll(async () => {
        const pointer = await this.pointer();
        return pointer ? this.cached(pointer.active, '/index.html') : null;
      })
      .toContain(`<title>${version}</title>`);
    const pointer = await this.pointer();
    if (!pointer) throw new Error('Published shell pointer is missing');
    expect(pointer?.active).toMatch(/^dramatis-shell-generation-v1-/);
    if (pointer?.previous !== null) expect(pointer?.previous).toMatch(/^dramatis-shell-generation-v1-/);
    return pointer;
  }

  async idle() {
    await expect
      .poll(() =>
        this.page.evaluate(async (lockName) => {
          const state = await navigator.locks.query();
          return [...(state.held ?? []), ...(state.pending ?? [])].filter((lock) => lock.name === lockName).length;
        }, shellContract.lock),
      )
      .toBe(0);
  }

  async stopCurrentWorker() {
    // A real, owned Chromium lifecycle transition resets the worker's in-memory
    // throttle; no fake clock, global stopAllWorkers or production hook is used.
    const url = await this.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    let current: Version | undefined;
    await expect
      .poll(() => {
        current = [...this.versions.values()].find(
          (version) =>
            version.scriptURL === url && version.status === 'activated' && version.runningStatus === 'running',
        );
        return !!current;
      })
      .toBe(true);
    if (!this.session || !current) throw new Error('Owned active ServiceWorker was not observed');
    const versionId = current.versionId;
    await this.session.send('ServiceWorker.stopWorker', { versionId });
    await expect.poll(() => this.versions.get(versionId)?.runningStatus).toBe('stopped');
    expect(await this.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(url);
  }

  async sourceHash() {
    // Node fetch is loopback only and is not served from ServiceWorker caches.
    const response = await fetch(`${this.host.origin}/sw.js`);
    expect(response.ok).toBe(true);
    return createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex');
  }

  async close() {
    await this.session?.detach().catch(() => undefined);
    // Close this fresh test context before its loopback server; Playwright's
    // built-in teardown may safely close it again. No persistent profile exists.
    await this.context.close({ reason: 'Owned SW fixture finished' });
    expect(this.externalRequests, 'No off-origin fixture request is permitted').toEqual([]);
  }
}

export const test = base.extend<{ sw: SwFixture }>({
  sw: async ({ context, page }, use) => {
    const host = await createFixtureHost();
    const fixture = new SwFixture(context, page, host);
    try {
      await fixture.prepare();
      await use(fixture);
    } finally {
      try {
        await fixture.close();
      } finally {
        await host.close();
      }
    }
  },
});
export { expect };
