/**
 * 给公开接口限流用的「来源」怎么认（审计 A8）。
 *
 * 以前取 `X-Forwarded-For` 的**第一跳**。nginx 示例用的是
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`——**追加**，于是第一跳
 * 是客户端自己填的：攻击者每个请求换一个假地址，建空间的限流就失效了。
 *
 * 正确的读法是从**右边**数：最后 N 跳是我们信任的 N 层代理写下的，第 N 跳才是
 * 真正连到最外层代理的那个地址。只有一层代理（默认）时：
 *
 * 1. 优先 `X-Real-IP`（nginx 示例里是 `$remote_addr`，**覆盖**而不是追加，客户端伪造不了）；
 * 2. 没有就取 `X-Forwarded-For` 的最后一跳；
 * 3. 都没有就用 socket 地址。
 *
 * 而且**只有请求来自本机**（反代与服务端同机，socket 是回环地址）时才看这些头：
 * 外面直连过来的请求可以随便填头，那时只信 socket 地址。
 */

export interface ClientKeyInput {
  /** socket 的对端地址。 */
  socketAddress: string;
  /** 请求头（小写键名，Node 的形状：同名头可能是数组）。 */
  headers: Record<string, string | string[] | undefined>;
  /**
   * 前面有几层可信反向代理（默认 1）。0 = 不信任何转发头，只用 socket 地址。
   * 配置入口：`--trusted-proxy-hops` / `DRAMATIS_SYNC_TRUSTED_PROXY_HOPS`。
   */
  trustedProxyHops?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function header(headers: ClientKeyInput['headers'], name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

export function resolveClientKey(input: ClientKeyInput): string {
  const hops = Math.max(0, Math.floor(input.trustedProxyHops ?? 1));
  const socket = input.socketAddress;
  if (hops === 0 || !LOOPBACK.has(socket)) return socket;

  const forwarded = (header(input.headers, 'x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (hops === 1) {
    const realIp = header(input.headers, 'x-real-ip')?.split(',').at(-1)?.trim();
    if (realIp !== undefined && realIp !== '') return realIp;
  }
  // 从右数第 hops 跳：最后那几跳是可信代理追加的，客户端自己填的都在更左边
  const fromRight = forwarded[forwarded.length - hops];
  if (fromRight !== undefined && fromRight !== '') return fromRight;
  return socket;
}
