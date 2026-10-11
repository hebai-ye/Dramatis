import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Classify = (method: string, href: string, mode: string, origin: string) => string;

interface SwExports {
  classifyRequest: Classify;
  CACHE: string;
  discoverShell: (html: string) => Promise<string[]>;
  refreshShell: () => Promise<string[]>;
}

function loadSw(overrides: Record<string, unknown> = {}): SwExports {
  const source = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
  const self = { addEventListener: () => {}, location: { origin: 'https://app.test' } };
  const context: Record<string, unknown> = { self, URL, Set, Response, caches: {}, fetch: () => {}, ...overrides };
  runInNewContext(
    `${source}\n;globalThis.__exports = { classifyRequest, CACHE, discoverShell, refreshShell };`,
    context,
  );
  return context.__exports as SwExports;
}

describe('sw.js 缓存策略（审计 A2）', () => {
  const { classifyRequest, CACHE } = loadSw();
  const origin = 'https://app.test';
  const get = (path: string, mode = 'cors') => classifyRequest('GET', origin + path, mode, origin);

  it('同步接口一律不缓存', () => {
    expect(get('/sync/spaces/abc/head')).toBe('pass');
    expect(get('/sync/spaces/abc/pull?since=5')).toBe('pass');
    expect(get('/sync/spaces/abc/meta')).toBe('pass');
    expect(get('/sync/spaces/abc', 'navigate')).toBe('pass');
    expect(get('/api/anything')).toBe('pass');
  });

  it('未列入白名单的同源 GET 不缓存', () => {
    expect(get('/whatever.json')).toBe('pass');
    expect(get('/data/export')).toBe('pass');
  });

  it('静态资源、图标、manifest、外壳走缓存', () => {
    expect(get('/assets/index-abc123.js')).toBe('cache');
    expect(get('/assets/index-abc123.css')).toBe('cache');
    expect(get('/icon-192.png')).toBe('cache');
    expect(get('/icon-home-192.png')).toBe('cache');
    expect(get('/icon-home-maskable-512.png')).toBe('cache');
    expect(get('/apple-touch-icon.png')).toBe('cache');
    expect(get('/manifest.webmanifest')).toBe('cache');
    expect(get('/index.html')).toBe('cache');
  });

  it('头像与立绘也在白名单里（否则装到桌面后离线全变破图）', () => {
    expect(get('/portraits/01.webp')).toBe('cache');
    expect(get('/portraits/thumbs/01.webp')).toBe('cache');
    expect(get('/portraits/avatars/01.webp')).toBe('cache');
    expect(get('/brand/logo.png')).toBe('cache');
    // 只有带斜杠的前缀算目录；无关路径照旧不进缓存
    expect(get('/portraits')).toBe('pass');
    expect(get('/brand')).toBe('pass');
    expect(get('/portraits/../secret.json')).toBe('pass');
  });

  it('导航请求网络优先并以外壳兜底', () => {
    expect(get('/', 'navigate')).toBe('navigate');
    expect(get('/some/deep/link', 'navigate')).toBe('navigate');
  });

  it('非 GET 与跨域放行', () => {
    expect(classifyRequest('POST', `${origin}/assets/x.js`, 'cors', origin)).toBe('pass');
    expect(classifyRequest('GET', 'https://api.deepseek.com/v1/models', 'cors', origin)).toBe('pass');
  });

  it('缓存版本已升级以补齐懒加载外壳', () => {
    expect(CACHE).toBe('dramatis-shell-v5');
  });

  it('首次安装收集未打开过的账户和设置模块', async () => {
    const requests: string[] = [];
    const sw = loadSw({
      fetch: async (path: string) => {
        requests.push(path);
        return Response.json(
          path === '/assets/shell-assets.json'
            ? { files: ['/assets/account-123.js', '/assets/settings-456.js', '/assets/main-123.css'] }
            : { icons: [] },
        );
      },
    });
    const files = await sw.discoverShell('<script src="/assets/main-123.js"></script>');
    expect(files).toEqual(
      expect.arrayContaining([
        '/assets/account-123.js',
        '/assets/settings-456.js',
        '/assets/main-123.css',
        '/assets/shell-assets.json',
      ]),
    );
    expect(requests).toContain('/assets/shell-assets.json');
  });

  it('不接受清单中的接口路径、跨源路径或路径穿越', async () => {
    for (const file of ['/sync/private', '//untrusted/path.js', '/assets/../private.js']) {
      const sw = loadSw({
        fetch: async (path: string) =>
          Response.json(path === '/assets/shell-assets.json' ? { files: [file] } : { icons: [] }),
      });
      await expect(sw.discoverShell('')).rejects.toThrow();
    }
  });

  // These lifecycle cases need distinct caches and a shared lock, rather than
  // aliasing every cache name to one mutable Map. Cache.put commits one entry;
  // writes to another cache are deliberately visible before pointer publication.
  function refreshFixture() {
    class BasicResponse extends Response {
      override get type(): ResponseType {
        return 'basic';
      }
      override clone(): Response {
        const copy = super.clone();
        Object.setPrototypeOf(copy, BasicResponse.prototype);
        return copy;
      }
    }
    const reply = (body: string, type: string) => new BasicResponse(body, { headers: { 'content-type': type } });
    const json = (body: unknown) => reply(JSON.stringify(body), 'application/json');
    const stores = new Map<string, Map<string, Response>>();
    const deleted: string[] = [];
    const generationPrefix = 'dramatis-shell-generation-v1-';
    const fixture = { version: 'A', failPut: '', deleted };
    const key = (input: string | { url: string }) =>
      new URL(typeof input === 'string' ? input : input.url, origin).href;
    const caches = {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const items = stores.get(name);
        if (!items) throw new Error('测试缓存未创建');
        return {
          match: async (input: string | { url: string }) => items.get(key(input))?.clone(),
          put: async (input: string | { url: string }, response: Response) => {
            if (name.startsWith(generationPrefix) && new URL(key(input)).pathname === fixture.failPut)
              throw new Error('新模块缓存失败');
            items.set(key(input), response.clone());
          },
          keys: async () => [...items.keys()].map((url) => ({ url })),
        };
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => {
        deleted.push(name);
        return stores.delete(name);
      },
    };
    let serial = 0;
    let tail = Promise.resolve();
    const sw = loadSw({
      caches,
      navigator: {
        locks: {
          request: (_name: string, _options: unknown, callback: () => Promise<string[]>) => {
            const pending = tail.then(callback);
            tail = pending.then(
              () => undefined,
              () => undefined,
            );
            return pending;
          },
        },
      },
      crypto: { randomUUID: () => String(++serial) },
      fetch: async (path: string) => {
        const name = fixture.version;
        if (path === '/index.html')
          return reply(
            `<title>${name}</title><script src="/assets/main-${name}.js"></script><link href="/assets/main-${name}.css" rel="stylesheet">`,
            'text/html',
          );
        if (path === '/assets/shell-assets.json')
          return json({ files: [`/assets/main-${name}.js`, `/assets/main-${name}.css`, `/assets/lazy-${name}.js`] });
        if (path === '/manifest.webmanifest') return json({ icons: [] });
        if (path.endsWith('.css')) return reply(`/* css ${name} */`, 'text/css');
        return reply(path.includes('lazy-') ? `lazy ${name}` : `main ${name}`, 'text/javascript');
      },
    });
    const read = async (name: string, path: string) => (await (await caches.open(name)).match(path))?.text();
    const pointer = async () => {
      const cached = await (await caches.open('dramatis-shell-control-v1')).match('/__dramatis/active-shell');
      if (!cached) return undefined;
      return (await cached.json()) as { active: string; previous: string | null };
    };
    return { deleted, state: fixture, sw, caches, read, pointer };
  }

  it('安装和激活两次刷新仍保留上一版已缓存模块', async () => {
    const fixture = refreshFixture();
    // Publish A first, including its lazy module that B's HTML never imports.
    await fixture.sw.refreshShell();
    const first = await fixture.pointer();
    if (!first) throw new Error('A 外壳未发布');
    fixture.state.version = 'B';
    await fixture.sw.refreshShell();
    await fixture.sw.refreshShell();
    const current = await fixture.pointer();
    if (!current) throw new Error('B 外壳未发布');
    expect(current.active).not.toBe(first.active);
    expect(await fixture.read(current.active, '/assets/main-B.js')).toBe('main B');
    expect(await fixture.read(current.active, '/assets/lazy-A.js')).toBe('lazy A');
    expect(await fixture.read(current.active, '/assets/lazy-B.js')).toBe('lazy B');
    expect(await fixture.read(current.active, '/index.html')).toContain('<title>B</title>');
    expect((await fixture.caches.keys()).filter((name) => name.startsWith('dramatis-shell-generation-v1-'))).toEqual(
      expect.arrayContaining([current.active, current.previous]),
    );
  });

  it('新模块缓存失败时不清掉已经可用的旧外壳', async () => {
    const fixture = refreshFixture();
    await fixture.sw.refreshShell();
    const before = await fixture.pointer();
    if (!before) throw new Error('A 外壳未发布');
    const beforeHTML = await fixture.read(before.active, '/index.html');
    fixture.state.version = 'B';
    fixture.state.failPut = '/assets/lazy-B.js';
    await expect(fixture.sw.refreshShell()).rejects.toThrow('新模块缓存失败');
    expect(await fixture.pointer()).toEqual(before);
    expect(await fixture.read(before.active, '/index.html')).toBe(beforeHTML);
    expect(await fixture.read(before.active, '/assets/lazy-A.js')).toBe('lazy A');
    expect(fixture.deleted).toEqual([]);
  });
});
