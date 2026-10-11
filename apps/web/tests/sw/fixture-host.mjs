import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const workerPath = new URL('../../public/sw.js', import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function image(version, kind) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><title>${kind} ${version}</title><rect width="16" height="16" fill="${version === 'A' ? 'red' : version === 'B' ? 'blue' : 'green'}"/></svg>`;
}

// Fixed, self-contained module graphs. No build, application state, account,
// production deployment or upstream service participates in this fixture.
function resources(version, modules) {
  return new Map([
    [
      '/index.html',
      [
        'text/html',
        `<!doctype html><html><head><title>${version}</title><link rel="stylesheet" href="/assets/main-${modules}.css"><link rel="manifest" href="/manifest.webmanifest"></head><body><h1 id="version">${version}</h1><script type="module" crossorigin src="/assets/main-${modules}.js"></script></body></html>`,
      ],
    ],
    [
      '/assets/shell-assets.json',
      [
        'application/json',
        JSON.stringify({
          files: [
            `/assets/main-${modules}.js`,
            `/assets/eager-${modules}.js`,
            `/assets/main-${modules}.css`,
            `/assets/lazy-${modules}.js`,
            `/assets/lazy-dependency-${modules}.js`,
          ],
        }),
      ],
    ],
    [
      '/manifest.webmanifest',
      [
        'application/manifest+json',
        JSON.stringify({
          name: version,
          start_url: '/',
          icons: [{ src: '/icon-192.png', sizes: '16x16', type: 'image/svg+xml' }],
        }),
      ],
    ],
    [
      `/assets/main-${modules}.js`,
      [
        'text/javascript',
        `import { eager } from './eager-${modules}.js'; window.fixture = { main: '${modules}', eager, loadLazy: async () => (await import('./lazy-${modules}.js')).lazy };`,
      ],
    ],
    [`/assets/eager-${modules}.js`, ['text/javascript', `export const eager = 'eager ${modules}';`]],
    [`/assets/main-${modules}.css`, ['text/css', `/* style ${modules} */ body { font-family: sans-serif; }`]],
    [
      `/assets/lazy-${modules}.js`,
      [
        'text/javascript',
        `import { dependency } from './lazy-dependency-${modules}.js'; export const lazy = 'lazy ${modules}: ' + dependency;`,
      ],
    ],
    [
      `/assets/lazy-dependency-${modules}.js`,
      ['text/javascript', `export const dependency = 'dependency ${modules}';`],
    ],
    ['/icon-192.png', ['image/svg+xml', image(version, 'icon')]],
    ['/portraits/01.webp', ['image/svg+xml', image(version, 'portrait')]],
    ['/brand/logo.png', ['image/svg+xml', image(version, 'brand')]],
  ]);
}

export async function createFixtureHost() {
  // Snapshot the actual shipped source once per test: deployments A/B/C and
  // query-only registration updates always serve these identical bytes.
  const workerSource = await readFile(workerPath);
  let deployment = { version: 'A', modules: 'A' };
  let failures = new Map();
  const requests = [];
  const barriers = new Set();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const captured = { ...deployment };
    const entry = {
      path,
      version: captured.version,
      destination: request.headers['sec-fetch-dest'] ?? '',
      cacheControl: request.headers['cache-control'] ?? '',
    };
    requests.push(entry);
    // Take the response snapshot before entering a barrier to model a response
    // from a deployment which changed while the real request was in flight.
    const resource = resources(captured.version, captured.modules).get(path === '/' ? '/index.html' : path);
    const status = failures.get(path) ?? (resource || path === '/sw.js' || path === '/__fixture/bootstrap' ? 200 : 404);
    const barrier = [...barriers].find((item) => !item.hit && item.match(entry));
    if (barrier) {
      barrier.hit = true;
      barrier.entered.resolve(entry);
      await barrier.released.promise;
    }
    if (response.destroyed) return;
    const [mime, body] =
      path === '/sw.js'
        ? ['text/javascript', workerSource]
        : path === '/__fixture/bootstrap'
          ? ['text/html', '<!doctype html><title>Fixture bootstrap</title>']
          : (resource ?? ['text/plain', 'fixture missing']);
    response.writeHead(status, {
      'content-type': mime,
      'cache-control': 'no-store',
      vary: 'Origin',
      'service-worker-allowed': '/',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'",
    });
    response.end(status === 200 ? body : 'fixture failure');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    workerHash: createHash('sha256').update(workerSource).digest('hex'),
    requests,
    deploy(version, modules = version) {
      deployment = { version, modules };
    },
    fail(path, status = 503) {
      failures.set(path, status);
    },
    clearFailures() {
      failures = new Map();
    },
    barrier(match) {
      const item = { match, hit: false, entered: deferred(), released: deferred() };
      barriers.add(item);
      return {
        entered: item.entered.promise,
        release() {
          item.released.resolve();
          barriers.delete(item);
        },
      };
    },
    async close() {
      for (const item of barriers) item.released.resolve();
      barriers.clear();
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
          server.closeAllConnections();
        }, 1_000);
        const bound = setTimeout(() => reject(new Error('Owned SW fixture server did not close')), 3_000);
        server.close((error) => {
          clearTimeout(deadline);
          clearTimeout(bound);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}
