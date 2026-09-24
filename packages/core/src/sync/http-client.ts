/**
 * HTTP 客户端（P2-6 第四步·部署）。
 *
 * 把 `SyncTransport` 的三个接口翻成三个 HTTP 请求，外加建空间 / 取空间元数据两个
 * 接口。放在内核里而不是网页里，是因为 **fetch 在浏览器与 Node 18+ 都有**：
 * 网页、部署脚本、以后的命令行工具都能共用同一份实现（服务端自己的冒烟测试也用它）。
 *
 * 错误处理只做一件事：把服务端那句人话（`{"error":{"message":...}}`）原样抛出来。
 * 底层的 `TypeError: Failed to fetch` 对用户毫无意义，而「凭证不对：检查一下
 * 同步密码」正是他要看的。
 */
import type { SyncDeviceSummary, SyncHeadResult, SyncPullResult, SyncPushResult, SyncTransport } from './types.js';

/**
 * HTTP 传输层（P2-6 第四步）。
 *
 * 说人话：把 `SyncTransport` 的三个接口翻成三个 HTTP 请求，打到
 * 「同步服务端」上。服务端可以是开发用的本机后端，也可以是自己部署的
 * Cloudflare Worker——**客户端只认地址，不认是谁实现的**（SYNC §3.2）。
 *
 * 错误处理只做一件事：把服务端那句人话（`{"error":{"message":...}}`）原样抛出来。
 * 底层的 `TypeError: Failed to fetch` 对用户毫无意义，而「凭证不对：检查一下
 * 同步密码」正是他要看的。
 */

export interface HttpSyncTransportOptions {
  /** 服务端根地址，例如 `https://sync.example.com` 或本机的 `http://127.0.0.1:5273/sync`。 */
  endpoint: string;
  /** 测试用：注入 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 服务端空间元数据：两份凭证哈希 + 两份主密钥封装（都解不开明文）。 */
export interface RemoteSpaceMeta {
  spaceHandle: string;
  credentialHash: string;
  recoveryCredentialHash: string;
  keyWraps: Record<string, unknown>;
  createdAt: string;
}

export interface RemoteSpaceInput {
  spaceHandle: string;
  credentialHash: string;
  recoveryCredentialHash: string;
  keyWraps: Record<string, unknown>;
}

function base(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
}

/**
 * 服务端返回的结构化错误（顺序 61）。
 *
 * 为什么不能只抛一句人话：客户端要按**机器可读的 code** 判断「是不是撞满配额」
 * （413 / `space-full`）、「是不是写入太频繁」（429 / `rate-limited`）、
 * 「是不是凭证不对」（401 / `unauthorized`）。在此之前只能拿中文文案
 * `message.includes('存满')` 去猜——服务端改一个字，客户端就静默失效。
 *
 * 它仍然 `extends Error`：老调用方与 `catch (error) { error.message }` 照常工作。
 */
export class SyncHttpError extends Error {
  override readonly name = 'SyncHttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const message = typeof body.error?.message === 'string' ? body.error.message : '';
    const code = typeof body.error?.code === 'string' ? body.error.code : '';
    if (message !== '' || code !== '') {
      return {
        code: code === '' ? 'unknown' : code,
        message: message === '' ? `同步服务端返回了 ${String(response.status)}。` : message,
      };
    }
  } catch {
    // 不是 JSON 就退到状态码
  }
  return { code: 'unknown', message: `同步服务端返回了 ${String(response.status)}。` };
}

async function expectOk(response: Response): Promise<unknown> {
  if (!response.ok) {
    const { code, message } = await readError(response);
    throw new SyncHttpError(response.status, code, message);
  }
  return response.json();
}

/** 建空间（首次同步时做一次）。已存在时返回 'exists'，界面据此提示「直接同步」。 */
export async function createRemoteSpace(
  options: HttpSyncTransportOptions,
  input: RemoteSpaceInput,
): Promise<'created' | 'exists'> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${base(options.endpoint)}/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (response.status === 409) return 'exists';
  const body = (await expectOk(response)) as { status?: string };
  return body.status === 'created' ? 'created' : 'exists';
}

/** 取空间元数据。它**不需要凭证**（要加入的人还没有凭证），里面只有哈希与密文。 */
export async function fetchRemoteSpace(
  options: HttpSyncTransportOptions,
  spaceHandle: string,
): Promise<RemoteSpaceMeta | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${base(options.endpoint)}/spaces/${encodeURIComponent(spaceHandle)}`);
  if (response.status === 404) return null;
  return (await expectOk(response)) as RemoteSpaceMeta;
}

/** 三个接口的实现。凭证每次请求带在 `Authorization` 头上。 */
export function createHttpSyncTransport(options: HttpSyncTransportOptions): SyncTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const auth = (credential: string): Record<string, string> => ({
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  });

  return {
    async head(input) {
      const response = await doFetch(`${base(options.endpoint)}/spaces/${encodeURIComponent(input.spaceHandle)}/head`, {
        headers: auth(input.credential),
      });
      return (await expectOk(response)) as SyncHeadResult;
    },

    async push(input) {
      const response = await doFetch(`${base(options.endpoint)}/spaces/${encodeURIComponent(input.spaceHandle)}/push`, {
        method: 'POST',
        headers: auth(input.credential),
        body: JSON.stringify({ records: input.records }),
      });
      return (await expectOk(response)) as SyncPushResult;
    },

    async pull(input) {
      const query = new URLSearchParams({ since: String(input.since) });
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const response = await doFetch(
        `${base(options.endpoint)}/spaces/${encodeURIComponent(input.spaceHandle)}/pull?${query.toString()}`,
        { headers: auth(input.credential) },
      );
      return (await expectOk(response)) as SyncPullResult;
    },

    /* 顺序 14 / 15：设备列表与换密码。老服务端没这两个路由时会回 404，
       客户端把服务端那句人话原样抛出来——界面据此说「这台服务端还不支持」。 */
    async devices(input) {
      const response = await doFetch(
        `${base(options.endpoint)}/spaces/${encodeURIComponent(input.spaceHandle)}/devices`,
        { headers: auth(input.credential) },
      );
      return (await expectOk(response)) as { devices: SyncDeviceSummary[] };
    },

    async rotate(input) {
      const response = await doFetch(
        `${base(options.endpoint)}/spaces/${encodeURIComponent(input.spaceHandle)}/rotate`,
        {
          method: 'POST',
          headers: auth(input.credential),
          body: JSON.stringify({ credentialHash: input.credentialHash, passwordWrap: input.passwordWrap }),
        },
      );
      await expectOk(response);
    },
  };
}
