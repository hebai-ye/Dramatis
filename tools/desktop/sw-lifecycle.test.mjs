import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the shipped worker. Only network, CacheStorage, Web Locks and event
// lifetimes are modeled here; this is not a Chromium ServiceWorker integration test.
const source = readFileSync(new URL('../../apps/web/public/sw.js', import.meta.url), 'utf8');
const origin = 'https://app.test';
const legacy = 'dramatis-shell-v5';
const control = 'dramatis-shell-control-v1';
const pointerPath = '/__dramatis/active-shell';
const runtime = 'dramatis-images-v1';
const generationPrefix = 'dramatis-shell-generation-v1-';
const absolute = (input) => new URL(typeof input === 'string' ? input : input.url, origin).href;
const pathname = (input) => new URL(absolute(input)).pathname;

class BasicResponse extends Response {
  get type() {
    return 'basic';
  }
  clone() {
    const result = super.clone();
    Object.setPrototypeOf(result, this.constructor.prototype);
    return result;
  }
}

class OpaqueResponse extends BasicResponse {
  get type() {
    return 'opaque';
  }
}

class ForeignResponse extends BasicResponse {
  get url() {
    return 'https://other.test/index.html';
  }
}

function response(body, type = 'text/plain', status = 200) {
  return new BasicResponse(body, { status, headers: { 'content-type': type, vary: 'Origin' } });
}

function deployment(name, modules = name) {
  return new Map([
    [
      '/index.html',
      response(
        `<title>${name}</title><script type="module" src="/assets/main-${modules}.js"></script><link rel="stylesheet" href="/assets/main-${modules}.css">`,
        'text/html',
      ),
    ],
    [
      '/assets/shell-assets.json',
      response(
        JSON.stringify({
          files: [`/assets/main-${modules}.js`, `/assets/main-${modules}.css`, `/assets/lazy-${modules}.js`],
        }),
        'application/json',
      ),
    ],
    [
      '/manifest.webmanifest',
      response(JSON.stringify({ name, icons: [{ src: '/icon-192.png' }] }), 'application/manifest+json'),
    ],
    [`/assets/main-${modules}.js`, response(`main ${modules}`, 'text/javascript')],
    [`/assets/main-${modules}.css`, response(`/* css ${modules} */`, 'text/css')],
    [`/assets/lazy-${modules}.js`, response(`lazy ${modules}`, 'text/javascript')],
    ['/icon-192.png', response(`icon ${name}`, 'image/png')],
    ['/portraits/01.webp', response(`portrait ${name}`, 'image/webp')],
    ['/brand/logo.png', response(`brand ${name}`, 'image/png')],
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function environment() {
  const stores = new Map();
  const env = {
    version: deployment('A'),
    offline: false,
    now: 100_000,
    requests: [],
    operations: [],
    lockRequests: [],
    fault: null,
    beforeFetch: null,
  };
  let serial = 0;
  const lockTails = new Map();
  const step = async (operation) => {
    env.operations.push(operation);
    await env.fault?.(operation);
  };
  const caches = {
    async open(name) {
      await step({ kind: 'open', name });
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(input, options = {}) {
          await step({ kind: 'match', name, path: pathname(input) });
          const entry = entries.get(absolute(input));
          if (!entry) return undefined;
          const headers = typeof input === 'string' ? new Headers() : (input.headers ?? new Headers());
          const vary = entry.body.headers.get('vary');
          if (
            !options.ignoreVary &&
            vary &&
            vary.split(',').some((field) => entry.headers.get(field.trim()) !== headers.get(field.trim()))
          )
            return undefined;
          return entry.body.clone();
        },
        async put(input, body) {
          const path = pathname(input);
          await step({ kind: 'put', name, path });
          entries.set(absolute(input), {
            body: body.clone(),
            headers: new Headers(typeof input === 'string' ? undefined : input.headers),
          });
        },
        async keys() {
          await step({ kind: 'keys', name });
          return [...entries.keys()].map((url) => new Request(url));
        },
        async delete(input) {
          await step({ kind: 'delete-entry', name, path: pathname(input) });
          return entries.delete(absolute(input));
        },
      };
    },
    async keys() {
      await step({ kind: 'cache-keys' });
      return [...stores.keys()];
    },
    async delete(name) {
      await step({ kind: 'delete-cache', name });
      return stores.delete(name);
    },
  };
  const locks = {
    request(_name, _options, callback) {
      env.lockRequests.push({ name: _name, mode: _options.mode });
      env.onLockRequest?.(_name);
      const pending = (lockTails.get(_name) ?? Promise.resolve()).then(() => callback({ name: _name }));
      lockTails.set(
        _name,
        pending.catch(() => {}),
      );
      return pending;
    },
  };
  env.caches = caches;
  env.worker = (name = 'worker', useLocks = true) => {
    const handlers = new Map();
    const self = {
      location: { origin },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type, handler) => handlers.set(type, handler),
    };
    runInNewContext(source, {
      self,
      URL,
      Set,
      Map,
      Response,
      Request,
      Headers,
      console,
      caches,
      navigator: useLocks ? { locks } : {},
      crypto: { randomUUID: () => String(++serial) },
      Date: class extends Date {
        static now() {
          return env.now;
        }
      },
      fetch: async (input, options = {}) => {
        const path = pathname(input);
        const request = { worker: name, path, options, navigation: input?.mode === 'navigate' };
        env.requests.push(request);
        if (env.offline) throw new TypeError('offline');
        // Capture a real response BEFORE the pause to model a request already in flight.
        const result =
          env.version.get(path === '/' ? '/index.html' : path)?.clone() ?? response('missing', 'text/plain', 404);
        await env.beforeFetch?.(request);
        return result;
      },
    });
    function dispatch(type, fields = {}) {
      let dispatching = true;
      let answer;
      const lifetime = [];
      handlers.get(type)({
        ...fields,
        waitUntil(promise) {
          assert.equal(dispatching, true, 'waitUntil must be registered synchronously during dispatch');
          lifetime.push(Promise.resolve(promise));
        },
        respondWith(promise) {
          answer = Promise.resolve(promise);
        },
      });
      dispatching = false;
      // Attach handlers immediately, even when a test first awaits the response.
      const settled = Promise.allSettled(lifetime);
      return { response: answer, settled, lifetimeCount: lifetime.length };
    }
    return {
      dispatch,
      async install() {
        const result = await dispatch('install').settled;
        const rejected = result.find((item) => item.status === 'rejected');
        if (rejected) throw rejected.reason;
      },
      async activate() {
        const result = await dispatch('activate').settled;
        const rejected = result.find((item) => item.status === 'rejected');
        if (rejected) throw rejected.reason;
      },
      fetch(path = '/', mode = 'navigate', method = 'GET', clientId = 'controlled-client') {
        return dispatch('fetch', {
          clientId,
          request: { url: absolute(path), method, mode, headers: new Headers({ Origin: origin }) },
        });
      },
    };
  };
  env.pointer = async () => {
    const item = await (await caches.open(control)).match(pointerPath);
    return item ? item.json() : undefined;
  };
  env.read = async (name, path) => (await (await caches.open(name)).match(path, { ignoreVary: true }))?.text();
  env.seedLegacy = async () => {
    const cache = await caches.open(legacy);
    for (const [path, body] of deployment('A')) await cache.put(path, body);
  };
  env.navigate = async (worker, path = '/') => {
    const event = worker.fetch(path);
    assert.equal(event.lifetimeCount, 1);
    const result = await event.response;
    await event.settled;
    return result;
  };
  return env;
}

test('same worker bytes: successful navigation updates offline HTML, all lazy modules and stable public files', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  const first = await env.pointer();
  env.now += 31_000;
  env.version = deployment('B');
  assert.match(await (await env.navigate(worker)).text(), /<title>B<\/title>/);
  const next = await env.pointer();
  assert.notEqual(next.active, first.active);
  env.offline = true;
  assert.match(await (await env.navigate(worker)).text(), /<title>B<\/title>/);
  for (const [path, expected] of [
    ['/assets/lazy-B.js', 'lazy B'],
    ['/assets/lazy-A.js', 'lazy A'],
    ['/icon-192.png', 'icon B'],
  ]) {
    assert.equal(await (await worker.fetch(path, 'cors').response).text(), expected);
  }
});

test('unchanged module list still refreshes HTML/icons and retains preceding lazy module generation across repeated installs', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  env.version = deployment('B');
  await worker.install();
  env.version = deployment('C', 'B');
  await worker.install();
  await worker.install();
  const pointer = await env.pointer();
  assert.match(await env.read(pointer.active, '/index.html'), /<title>C<\/title>/);
  assert.equal(await env.read(pointer.active, '/icon-192.png'), 'icon C');
  assert.equal(await env.read(pointer.active, '/assets/lazy-A.js'), 'lazy A');
});

test('v5 images and lazy modules migrate before publication; offline fallback works before migration', async () => {
  const env = environment();
  await env.seedLegacy();
  const worker = env.worker();
  env.offline = true;
  assert.match(await (await env.navigate(worker)).text(), /<title>A<\/title>/);
  env.offline = false;
  env.version = deployment('B');
  await worker.install();
  const pointer = await env.pointer();
  assert.equal(await env.read(pointer.active, '/assets/lazy-A.js'), 'lazy A');
  assert.equal(await env.read(runtime, '/portraits/01.webp'), 'portrait A');
  assert.equal(await env.read(runtime, '/brand/logo.png'), 'brand A');
});

// Removing any stage check or moving the pointer write earlier must break these.
for (const failure of [
  'index',
  'module-list',
  'manifest',
  'module',
  'static',
  'generation-put',
  'previous-module-put',
  'previous-list-put',
  'pointer-put',
]) {
  test(`failure at ${failure} preserves current A and permits a later navigation retry`, async () => {
    const env = environment();
    const worker = env.worker();
    await worker.install();
    const original = await env.pointer();
    env.version = deployment('B');
    env.now += 31_000;
    const paths = {
      index: '/index.html',
      'module-list': '/assets/shell-assets.json',
      manifest: '/manifest.webmanifest',
      module: '/assets/lazy-B.js',
      static: '/icon-192.png',
    };
    env.beforeFetch = ({ path, navigation }) => {
      if (!navigation && path === paths[failure]) throw new Error(`download ${failure}`);
    };
    env.fault = ({ kind, name, path }) => {
      if (kind !== 'put') return;
      if (
        (failure === 'generation-put' && name.startsWith(generationPrefix) && path === '/index.html') ||
        (failure === 'previous-module-put' && path === '/assets/lazy-A.js') ||
        (failure === 'previous-list-put' && path === '/assets/shell-previous.json') ||
        (failure === 'pointer-put' && name === control)
      )
        throw new Error('quota exceeded');
    };
    await env.navigate(worker);
    assert.deepEqual(await env.pointer(), original);
    env.offline = true;
    assert.match(await (await env.navigate(worker)).text(), /<title>A<\/title>/);
    env.offline = false;
    env.fault = null;
    env.beforeFetch = null;
    // No time advance: a failed refresh must not arm the successful-refresh throttle.
    await env.navigate(worker);
    assert.notEqual((await env.pointer()).active, original.active);
  });
}

test('runtime migration quota failure leaves the legacy shell and images usable', async () => {
  const env = environment();
  await env.seedLegacy();
  env.version = deployment('B');
  env.fault = ({ kind, name }) => {
    if (kind === 'put' && name === runtime) throw new Error('quota');
  };
  const worker = env.worker();
  await assert.rejects(worker.install(), /quota/);
  assert.equal(await env.pointer(), undefined);
  assert.equal(await env.read(legacy, '/portraits/01.webp'), 'portrait A');
  env.offline = true;
  assert.match(await (await env.navigate(worker)).text(), /<title>A<\/title>/);
});

for (const invalid of ['mixed-deployment', 'html-as-module', 'bad-manifest', 'bad-module-path']) {
  test(`invalid ${invalid} cannot publish a partially usable generation`, async () => {
    const env = environment();
    const worker = env.worker();
    await worker.install();
    const before = await env.pointer();
    env.version = deployment('B');
    if (invalid === 'mixed-deployment') env.version.set('/index.html', deployment('A').get('/index.html'));
    if (invalid === 'html-as-module')
      env.version.set('/assets/lazy-B.js', response('<html>fallback</html>', 'text/html'));
    if (invalid === 'bad-manifest') env.version.set('/manifest.webmanifest', response('not json', 'application/json'));
    if (invalid === 'bad-module-path')
      env.version.set('/assets/shell-assets.json', response('{"files":["/api/private"]}', 'application/json'));
    await assert.rejects(worker.install());
    assert.deepEqual(await env.pointer(), before);
  });
}

test('successful publication tolerates cleanup failure and never removes foreign caches or image cache', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  await (await env.caches.open('another-app')).put('/index.html', response('foreign'));
  await (await env.caches.open(runtime)).put('/portraits/01.webp', response('portrait saved', 'image/webp'));
  env.version = deployment('B');
  await worker.install();
  env.version = deployment('C');
  env.fault = ({ kind }) => {
    if (kind === 'delete-cache') throw new Error('cleanup denied');
  };
  await worker.install();
  assert.match(await env.read((await env.pointer()).active, '/index.html'), /<title>C<\/title>/);
  assert.equal(await env.read('another-app', '/index.html'), 'foreign');
  assert.equal(await env.read(runtime, '/portraits/01.webp'), 'portrait saved');
});

test('stable images revalidate with no-store: errors, non-images and opaque responses preserve the old image', async () => {
  const env = environment();
  const worker = env.worker();
  const load = async () => {
    const event = worker.fetch('/portraits/01.webp', 'cors');
    const result = await event.response;
    await event.settled;
    return result.text();
  };
  assert.equal(await load(), 'portrait A');
  env.offline = true;
  assert.equal(await load(), 'portrait A');
  env.offline = false;
  for (const invalid of [
    response('error', 'text/plain', 500),
    response('fallback', 'text/html'),
    new OpaqueResponse('opaque', { headers: { 'content-type': 'image/webp' } }),
    Response.error(),
  ]) {
    env.version.set('/portraits/01.webp', invalid);
    assert.equal(await load(), 'portrait A');
    assert.equal(await env.read(runtime, '/portraits/01.webp'), 'portrait A');
  }
  env.version = deployment('B');
  assert.equal(await load(), 'portrait A');
  assert.equal(await env.read(runtime, '/portraits/01.webp'), 'portrait B');
  assert.ok(
    env.requests
      .filter((item) => item.path === '/portraits/01.webp')
      .every((item) => item.options.cache === 'no-store'),
  );
});

const backgroundPaths = ['/backgrounds/v1/quiet-library.webp', '/backgrounds/v1/thumbs/quiet-library.webp'];

for (const path of backgroundPaths) {
  // Removing the whitelist entry or sending backgrounds to the shell cache must
  // break these first-load/offline cases. Installation must not fetch the gallery.
  test(`background is stored on first use and survives offline: ${path}`, async () => {
    const env = environment();
    for (const available of backgroundPaths) env.version.set(available, response('background A', 'image/webp'));
    const worker = env.worker();
    await worker.install();
    await worker.activate();
    assert.equal(
      env.requests.some((item) => item.path.startsWith('/backgrounds/')),
      false,
    );

    const first = worker.fetch(path, 'cors');
    assert.ok(first.response, 'background requests must be handled by the worker');
    assert.equal(await (await first.response).text(), 'background A');
    await first.settled;
    assert.equal(await env.read(runtime, path), 'background A');
    assert.equal(await env.read('dramatis-static-runtime-v1', path), undefined);
    const unused = backgroundPaths.find((available) => available !== path);
    assert.equal(await env.read(runtime, unused), undefined);

    env.offline = true;
    const offline = env.worker('restarted-offline').fetch(path, 'cors');
    assert.equal(await (await offline.response).text(), 'background A');
    await offline.settled;
    assert.equal(await env.read(runtime, path), 'background A');
  });

  // Returning only the cached static response would miss the new background.
  test(`background cache hit returns the old image while refreshing it: ${path}`, { timeout: 5_000 }, async () => {
    const env = environment();
    env.version.set(path, response('background A', 'image/webp'));
    const worker = env.worker();
    const first = worker.fetch(path, 'cors');
    assert.ok(first.response, 'background requests must be handled by the worker');
    assert.equal(await (await first.response).text(), 'background A');
    await first.settled;

    env.version.set(path, response('background B', 'image/webp'));
    const gate = deferred();
    const fetched = deferred();
    env.beforeFetch = async ({ path: requested }) => {
      if (requested !== path) return;
      fetched.resolve();
      await gate.promise;
    };
    const update = worker.fetch(path, 'cors');
    try {
      await fetched.promise;
      assert.equal(await (await update.response).text(), 'background A');
      assert.equal(await env.read(runtime, path), 'background A');
    } finally {
      gate.resolve();
      await update.settled;
    }
    assert.equal(await env.read(runtime, path), 'background B');
    assert.equal(
      env.requests.filter((item) => item.path === path).every((item) => item.options.cache === 'no-store'),
      true,
    );
  });

  // Accepting an error, HTML fallback or opaque response must not replace A.
  test(`failed background refresh preserves the cached image: ${path}`, async () => {
    const env = environment();
    env.version.set(path, response('background A', 'image/webp'));
    const worker = env.worker();
    const first = worker.fetch(path, 'cors');
    assert.ok(first.response, 'background requests must be handled by the worker');
    assert.equal(await (await first.response).text(), 'background A');
    await first.settled;

    for (const invalid of [
      response('unavailable', 'image/webp', 503),
      response('<html>fallback</html>', 'text/html'),
      new OpaqueResponse('opaque', { headers: { 'content-type': 'image/webp' } }),
    ]) {
      env.version.set(path, invalid);
      const update = worker.fetch(path, 'cors');
      assert.equal(await (await update.response).text(), 'background A');
      await update.settled;
      assert.equal(await env.read(runtime, path), 'background A');
    }
    env.offline = true;
    const failed = worker.fetch(path, 'cors');
    assert.equal(await (await failed.response).text(), 'background A');
    await failed.settled;
    assert.equal(await env.read(runtime, path), 'background A');
  });

  // A bad first response must not become an offline image merely because its URL
  // has a .webp extension.
  test(`invalid first background response leaves no cached image: ${path}`, async () => {
    for (const invalid of [
      response('unavailable', 'image/webp', 503),
      response('<html>fallback</html>', 'text/html'),
    ]) {
      const env = environment();
      env.version.set(path, invalid);
      const event = env.worker().fetch(path, 'cors');
      assert.ok(event.response, 'background requests must be handled by the worker');
      const result = await event.response;
      assert.equal(result.status, invalid.status);
      assert.equal(await result.text(), await invalid.clone().text());
      await event.settled;
      assert.equal(await env.read(runtime, path), undefined);
      assert.equal(await env.read('dramatis-static-runtime-v1', path), undefined);
    }
  });
}

test('two simultaneous controlled navigations share refresh; successful refresh is throttled', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  env.now += 31_000;
  env.version = deployment('B');
  const gate = deferred();
  const entered = deferred();
  env.beforeFetch = async ({ path }) => {
    if (path === '/assets/lazy-B.js') {
      entered.resolve();
      await gate.promise;
    }
  };
  const one = worker.fetch();
  const two = worker.fetch();
  await entered.promise;
  assert.equal(await (await one.response).text(), await (await two.response).text());
  gate.resolve();
  await Promise.all([one.settled, two.settled]);
  await env.navigate(worker);
  assert.equal(env.requests.filter((item) => item.path === '/assets/lazy-B.js').length, 1);
});

test('HTTP errors and offline navigation never trigger refresh', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  const original = await env.pointer();
  env.now += 31_000;
  env.requests.length = 0;
  env.version.set('/index.html', response('unavailable', 'text/html', 503));
  assert.equal((await env.navigate(worker)).status, 503);
  env.offline = true;
  assert.match(await (await env.navigate(worker)).text(), /<title>A<\/title>/);
  assert.deepEqual(await env.pointer(), original);
  assert.equal(
    env.requests.some((item) => item.path === '/assets/shell-assets.json'),
    false,
  );
});

test('lock covers fresh fetch through failed old staging, so waiting installation publishes B', async () => {
  const env = environment();
  const old = env.worker('old');
  const newer = env.worker('new');
  const gate = deferred();
  const entered = deferred();
  env.beforeFetch = async ({ path, worker }) => {
    if (worker === 'old' && path === '/assets/lazy-A.js') {
      entered.resolve();
      await gate.promise;
    }
  };
  const pendingOld = old.install();
  await entered.promise;
  env.version = deployment('B');
  const pendingNew = newer.install();
  assert.equal(env.lockRequests.length, 2, 'both workers have reached the actual shared lock request');
  assert.equal(
    env.lockRequests.every((lock) => lock.mode === 'exclusive'),
    true,
  );
  assert.equal(
    env.requests.some((item) => item.worker === 'new'),
    false,
    'fresh fetch must wait for the cross-worker lock',
  );
  gate.resolve();
  const results = await Promise.allSettled([pendingOld, pendingNew]);
  assert.equal(results[0].status, 'rejected', 'deployment removed remaining A assets: old staging must fail closed');
  assert.match(String(results[0].reason), /离线资源下载失败/);
  assert.equal(results[1].status, 'fulfilled', 'B starts after old staging releases its lock');
  assert.match(await env.read((await env.pointer()).active, '/index.html'), /<title>B<\/title>/);
});

test('old A navigation captured outside lock cannot revert a newer B installation', async () => {
  const env = environment();
  const old = env.worker('old');
  await old.install();
  env.now += 31_000;
  const gate = deferred();
  const captured = deferred();
  env.beforeFetch = async ({ worker, navigation }) => {
    if (worker === 'old' && navigation) {
      captured.resolve();
      await gate.promise;
    }
  };
  const oldNavigation = old.fetch();
  await captured.promise;
  env.version = deployment('B');
  await env.worker('new').install();
  gate.resolve();
  assert.match(
    await (await oldNavigation.response).text(),
    /<title>A<\/title>/,
    'return the original network response',
  );
  await oldNavigation.settled;
  assert.match(
    await env.read((await env.pointer()).active, '/index.html'),
    /<title>B<\/title>/,
    'publication must refetch inside the lock',
  );
});

test('without Web Locks retain existing v5 or active shell; first install cannot establish a new offline shell', async () => {
  const env = environment();
  await env.seedLegacy();
  const unlocked = env.worker('unlocked', false);
  env.version = deployment('B');
  await unlocked.install();
  assert.equal(await env.pointer(), undefined);
  assert.equal(env.requests.length, 0);
  env.offline = true;
  assert.match(await (await env.navigate(unlocked)).text(), /<title>A<\/title>/);
  const empty = environment();
  const first = empty.worker('first', false);
  await first.install();
  empty.offline = true;
  assert.equal((await empty.navigate(first)).type, 'error');
});

test('non-GET, cross-origin, sync/api and unknown paths are passed through without cache writes', async () => {
  const env = environment();
  const worker = env.worker();
  for (const [path, mode, method] of [
    ['/assets/a.js', 'cors', 'POST'],
    ['https://model.test/api', 'cors', 'GET'],
    ['/sync/head', 'navigate', 'GET'],
    ['/api/data', 'cors', 'GET'],
    ['/unknown', 'cors', 'GET'],
  ]) {
    const event = worker.fetch(path, mode, method);
    assert.equal(event.response, undefined);
    assert.equal(event.lifetimeCount, 0);
  }
  assert.equal(env.requests.length, 0);
  assert.equal(env.operations.length, 0);
});

test('install then activate keeps preceding lazy modules and uses no-store for every staging fetch', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  env.version = deployment('B');
  await worker.install();
  await worker.activate();
  const pointer = await env.pointer();
  assert.equal(await env.read(pointer.active, '/assets/lazy-A.js'), 'lazy A');
  assert.equal(await env.read(pointer.active, '/assets/lazy-B.js'), 'lazy B');
  assert.ok(env.requests.every((item) => item.options.cache === 'no-store'));
});

for (const invalid of ['uncontrolled', 'opaque', 'foreign-response']) {
  test(`${invalid} navigation does not start a shell refresh`, async () => {
    const env = environment();
    const worker = env.worker();
    await worker.install();
    const before = await env.pointer();
    env.now += 31_000;
    env.version = deployment('B');
    if (invalid === 'opaque') env.version.set('/index.html', new OpaqueResponse('opaque B'));
    if (invalid === 'foreign-response') env.version.set('/index.html', new ForeignResponse('redirected B'));
    env.requests.length = 0;
    const event = worker.fetch('/', 'navigate', 'GET', invalid === 'uncontrolled' ? '' : 'controlled-client');
    const result = await event.response;
    await event.settled;
    assert.ok(result);
    assert.deepEqual(await env.pointer(), before);
    assert.equal(env.requests.length, 1);
  });
}

test('missing previous lazy module rejects staging instead of publishing a generation that loses it', async () => {
  const env = environment();
  const worker = env.worker();
  await worker.install();
  const before = await env.pointer();
  await (await env.caches.open(before.active)).delete('/assets/lazy-A.js');
  env.version = deployment('B');
  await assert.rejects(worker.install(), /上一代模块不可用/);
  assert.deepEqual(await env.pointer(), before);
  assert.match(await env.read(before.active, '/index.html'), /<title>A<\/title>/);
});

for (const failure of ['generation-open', 'prior-read', 'image-open', 'image-enumeration', 'control-open']) {
  test(`CacheStorage failure at ${failure} leaves A published`, async () => {
    const env = environment();
    const worker = env.worker();
    await worker.install();
    const before = await env.pointer();
    env.version = deployment('B');
    let pointerReached = false;
    env.fault = ({ kind, name, path }) => {
      if (kind === 'put' && path === '/assets/shell-previous.json') pointerReached = true;
      if (
        (failure === 'generation-open' &&
          kind === 'open' &&
          name.startsWith(generationPrefix) &&
          name !== before.active) ||
        (failure === 'prior-read' &&
          kind === 'match' &&
          name === before.active &&
          path === '/assets/shell-assets.json') ||
        (failure === 'image-open' && kind === 'open' && name === runtime) ||
        (failure === 'image-enumeration' && kind === 'keys' && name === legacy) ||
        (failure === 'control-open' && pointerReached && kind === 'open' && name === control)
      )
        throw new Error('cache unavailable');
    };
    await assert.rejects(worker.install(), /cache unavailable/);
    env.fault = null;
    assert.deepEqual(await env.pointer(), before);
    assert.match(await env.read(before.active, '/index.html'), /<title>A<\/title>/);
  });
}

for (const pauseAt of ['partial-stage', 'before-pointer']) {
  test(`interruption at ${pauseAt} keeps A reachable while abandoned writes remain isolated`, async () => {
    const env = environment();
    const worker = env.worker();
    await worker.install();
    const before = await env.pointer();
    env.version = deployment('B');
    const gate = deferred();
    const entered = deferred();
    env.fault = async ({ kind, name, path }) => {
      if (
        kind !== 'put' ||
        (pauseAt === 'partial-stage'
          ? !name.startsWith(generationPrefix) || path !== '/assets/main-B.css'
          : name !== control)
      )
        return;
      entered.resolve();
      await gate.promise;
      throw new Error('simulated worker interruption');
    };
    const failed = assert.rejects(worker.install(), /simulated worker interruption/);
    await entered.promise;
    assert.deepEqual(await env.pointer(), before);
    env.offline = true;
    assert.match(await (await env.navigate(worker)).text(), /<title>A<\/title>/);
    env.offline = false;
    gate.resolve();
    await failed;
    env.fault = null;
    assert.deepEqual(await env.pointer(), before);
    // A new worker retries; it cannot infer publication from the orphan stage.
    await env.worker('retry').install();
    const after = await env.pointer();
    assert.match(await env.read(after.active, '/index.html'), /<title>B<\/title>/);
    const names = await env.caches.keys();
    assert.deepEqual(
      names.filter((name) => name.startsWith(generationPrefix)).sort(),
      [after.active, after.previous].sort(),
    );
  });
}

test('without Web Locks a newer worker leaves an existing generation and pointer unchanged', async () => {
  const env = environment();
  await env.worker('locked').install();
  const before = await env.pointer();
  env.version = deployment('B');
  const unlocked = env.worker('unlocked', false);
  await unlocked.install();
  await unlocked.activate();
  assert.deepEqual(await env.pointer(), before);
  env.offline = true;
  assert.match(await (await env.navigate(unlocked)).text(), /<title>A<\/title>/);
});

test('image cache quota failure preserves old image and can retry on the next request', async () => {
  const env = environment();
  const worker = env.worker();
  const load = async () => {
    const event = worker.fetch('/brand/logo.png', 'cors');
    const result = await event.response;
    await event.settled;
    return result.text();
  };
  assert.equal(await load(), 'brand A');
  env.version = deployment('B');
  env.fault = ({ kind, name }) => {
    if (kind === 'put' && name === runtime) throw new Error('quota');
  };
  assert.equal(await load(), 'brand A');
  assert.equal(await env.read(runtime, '/brand/logo.png'), 'brand A');
  env.fault = null;
  assert.equal(await load(), 'brand A');
  assert.equal(await env.read(runtime, '/brand/logo.png'), 'brand B');
});

test('migration cannot replace B after an in-flight runtime update acquired the same image lock', async () => {
  const env = environment();
  await env.seedLegacy();
  env.version = deployment('B');
  const network = deferred();
  const fetched = deferred();
  env.beforeFetch = async ({ path }) => {
    if (path === '/portraits/01.webp') {
      fetched.resolve();
      await network.promise;
    }
  };
  const runtimeEvent = env.worker('runtime').fetch('/portraits/01.webp', 'cors');
  await fetched.promise;
  const legacyRead = deferred();
  const migrationWaiting = deferred();
  let paused = false;
  env.fault = async ({ kind, name, path }) => {
    if (!paused && kind === 'match' && name === legacy && path === '/portraits/01.webp') {
      paused = true;
      migrationWaiting.resolve();
      await legacyRead.promise;
    }
  };
  env.onLockRequest = (name) => {
    if (
      name.startsWith('dramatis-image-update-v1:') &&
      env.lockRequests.filter((lock) => lock.name === name).length === 2
    )
      migrationWaiting.resolve();
  };
  const migration = env.worker('migration').install();
  try {
    await migrationWaiting.promise; // real old-cache read or the shared image lock queue, never a timer
    network.resolve();
    await runtimeEvent.settled;
    assert.equal(await env.read(runtime, '/portraits/01.webp'), 'portrait B');
  } finally {
    network.resolve();
    legacyRead.resolve();
    await migration;
  }
  assert.equal(await env.read(runtime, '/portraits/01.webp'), 'portrait B');
});

for (const failingOperation of ['open', 'match']) {
  test(`online image still loads when runtime cache ${failingOperation} rejects`, async () => {
    const env = environment();
    env.version = deployment('B');
    env.fault = ({ kind, name }) => {
      if (kind === failingOperation && name === runtime) throw new Error('image cache unavailable');
    };
    const event = env.worker().fetch('/portraits/01.webp', 'cors');
    const result = await event.response;
    await event.settled;
    assert.equal(await result.text(), 'portrait B');
    assert.equal(env.requests.filter((request) => request.path === '/portraits/01.webp').length, 1);
  });
}

for (const failingOperation of ['open', 'match']) {
  test(`online static module still loads when runtime cache ${failingOperation} rejects`, async () => {
    const env = environment();
    env.version = deployment('B');
    env.fault = ({ kind, name }) => {
      if (kind === failingOperation && name === 'dramatis-static-runtime-v1')
        throw new Error('static cache unavailable');
    };
    const event = env.worker().fetch('/assets/main-B.js', 'cors');
    const result = await event.response;
    await event.settled;
    assert.equal(await result.text(), 'main B');
    assert.equal(env.requests.filter((request) => request.path === '/assets/main-B.js').length, 1);
  });
}
