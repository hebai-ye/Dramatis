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

  it('安装和激活两次刷新仍保留上一版已缓存模块', async () => {
    const items = new Map<string, Response>([
      ['/assets/shell-assets.json', Response.json({ files: ['/assets/old-123.js'] })],
      ['/assets/old-123.js', new Response('old module')],
    ]);
    const cache = {
      match: async (path: string) => items.get(path)?.clone(),
      put: async (path: string, response: Response) => {
        items.set(path, response.clone());
      },
      keys: async () => [...items.keys()].map((path) => ({ url: origin + path })),
      delete: async (request: { url: string }) => items.delete(new URL(request.url).pathname),
      addAll: async (paths: string[]) => {
        for (const path of paths)
          items.set(
            path,
            path === '/assets/shell-assets.json'
              ? Response.json({ files: ['/assets/account-456.js', '/assets/new-456.js'] })
              : new Response('new'),
          );
      },
    };
    const sw = loadSw({
      caches: { open: async () => cache, keys: async () => [] },
      fetch: async (path: string) =>
        path === '/index.html'
          ? new Response('<script src="/assets/new-456.js"></script>')
          : Response.json(
              path === '/assets/shell-assets.json'
                ? { files: ['/assets/account-456.js', '/assets/new-456.js'] }
                : { icons: [] },
            ),
    });
    await sw.refreshShell();
    await sw.refreshShell();
    expect(items.has('/assets/new-456.js')).toBe(true);
    expect(await items.get('/assets/old-123.js')?.text()).toBe('old module');
  });

  it('新模块缓存失败时不清掉已经可用的旧外壳', async () => {
    let deleted = false;
    const cache = {
      match: async () => undefined,
      keys: async () => [{ url: `${origin}/assets/old-123.js` }],
      put: async () => {},
      delete: async () => {
        deleted = true;
      },
      addAll: async () => {
        throw new Error('新模块下载失败');
      },
    };
    const sw = loadSw({
      caches: { open: async () => cache, keys: async () => [] },
      fetch: async (path: string) =>
        path === '/index.html'
          ? new Response('')
          : Response.json(path === '/assets/shell-assets.json' ? { files: ['/assets/new-456.js'] } : { icons: [] }),
    });
    await expect(sw.refreshShell()).rejects.toThrow('新模块下载失败');
    expect(deleted).toBe(false);
  });
});
