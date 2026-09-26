import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Classify = (method: string, href: string, mode: string, origin: string) => string;

function loadSw(): { classifyRequest: Classify; CACHE: string } {
  const source = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
  const self = { addEventListener: () => {}, location: { origin: 'https://app.test' } };
  const context: Record<string, unknown> = { self, URL, Set, Response: {}, caches: {}, fetch: () => {} };
  runInNewContext(`${source}\n;globalThis.__exports = { classifyRequest, CACHE };`, context);
  return context.__exports as { classifyRequest: Classify; CACHE: string };
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

  it('缓存版本已升级以清除被污染的 v1', () => {
    expect(CACHE).not.toBe('dramatis-shell-v1');
  });
});
