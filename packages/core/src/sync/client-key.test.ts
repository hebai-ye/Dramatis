import { describe, expect, it } from 'vitest';
import { resolveClientKey } from './client-key.js';

describe('限流来源（审计 A8）', () => {
  it('默认一层代理：优先 X-Real-IP，客户端自填的 XFF 第一跳不算', () => {
    expect(
      resolveClientKey({
        socketAddress: '127.0.0.1',
        headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      }),
    ).toBe('203.0.113.9');
  });

  it('没有 X-Real-IP：取 XFF 最后一跳（nginx 追加的那一跳）', () => {
    expect(
      resolveClientKey({ socketAddress: '127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } }),
    ).toBe('203.0.113.9');
  });

  it('两层代理：从右数第二跳', () => {
    expect(
      resolveClientKey({
        socketAddress: '::1',
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2', 'x-real-ip': '10.0.0.2' },
        trustedProxyHops: 2,
      }),
    ).toBe('203.0.113.9');
  });

  it('外部直连（socket 不是回环）一律只信 socket，头随便填都没用', () => {
    expect(
      resolveClientKey({
        socketAddress: '198.51.100.7',
        headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' },
      }),
    ).toBe('198.51.100.7');
  });

  it('hops = 0：不信任何转发头；什么头都没有时退回 socket', () => {
    expect(
      resolveClientKey({ socketAddress: '127.0.0.1', headers: { 'x-real-ip': '1.1.1.1' }, trustedProxyHops: 0 }),
    ).toBe('127.0.0.1');
    expect(resolveClientKey({ socketAddress: '127.0.0.1', headers: {} })).toBe('127.0.0.1');
  });
});
