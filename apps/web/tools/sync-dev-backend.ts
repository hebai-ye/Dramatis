import type { SyncServer, SyncServerStore, SyncSpaceRecord } from '@dramatis/core';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * 开发用同步后端（P2-6 第四步，**只挂在 vite 上，不进应用构建**）。
 *
 * 它把内核里那份唯一的 HTTP 外壳（`handleSyncRequest`）挂到 `/sync/*`，
 * 数据落在一个 JSON 文件里。于是「两台设备同一条世界线」在本机就能真的跑起来：
 *
 * - `pnpm dev` 起来就有，不用另开进程、不用注册任何账号；
 * - 数据文件在系统临时目录（`dramatis-sync-dev.json`），不进仓库、不污染工作区；
 * - 它和 Cloudflare Worker 是**同一份逻辑**，只有存储适配器不同。
 *
 * 它不打算当生产后端：没有备份、没有并发保护、没有速率限制。线上要的是
 * `deploy/cloudflare/` 那份（同一协议、换存储）。
 *
 * **为什么核心模块是「用到时再加载」**：vite 配置文件本身是在 Node 里先跑一遍的，
 * 那一刻还不认 `packages/core` 里的 TS 源码（内部用 `./x.js` 指 `./x.ts`）。
 * 所以这里只做 `import type`（编译后不留痕），真正取用走 `ssrLoadModule`——
 * 那是 vite 自己的模块加载器，认识这套写法。
 */

/**
 * 我们用到的那一点 Node 表面。
 *
 * 这里自己声明而不是引 `@types/node`：`apps/web` 的 tsconfig 故意只有
 * `vite/client` 类型（浏览器项目不该顺手用上 Node 全局），为一个开发用插件
 * 破这个规矩不划算。
 */
interface NodeFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
}
interface NodeOs {
  tmpdir(): string;
}
interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}
interface NodeRequestLike {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}
interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** 动态载入一个 Node 内置模块（用字符串变量是为了不让 TS 去解析它的类型）。 */
async function nodeModule<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

interface StoreFile {
  spaces: Record<string, SyncSpaceRecord>;
  rows: Record<string, Record<string, unknown>>;
  heads: Record<string, number>;
}

/** 一个 JSON 文件的 `SyncServerStore`：写完就落盘，重启不丢（开发用够了）。 */
function createJsonFileStore(file: string, fs: NodeFs, path: NodePath): SyncServerStore {
  let loaded = false;
  let data: StoreFile = { spaces: {}, rows: {}, heads: {} };

  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<StoreFile>;
      data = {
        spaces: parsed.spaces ?? {},
        rows: parsed.rows ?? {},
        heads: parsed.heads ?? {},
      };
    } catch {
      // 文件不存在或者坏了都从头开始：这是开发后端，不该因为一个坏文件起不来
      data = { spaces: {}, rows: {}, heads: {} };
    }
  };

  const save = async (): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  };

  return {
    async getSpace(spaceHandle) {
      await load();
      return data.spaces[spaceHandle] ?? null;
    },

    async createSpace(record) {
      await load();
      if (data.spaces[record.spaceHandle] !== undefined) return false;
      data.spaces[record.spaceHandle] = record;
      data.rows[record.spaceHandle] = {};
      data.heads[record.spaceHandle] = 0;
      await save();
      return true;
    },

    async head(spaceHandle) {
      await load();
      return data.heads[spaceHandle] ?? 0;
    },

    async append(spaceHandle, records) {
      await load();
      data.rows[spaceHandle] ??= {};
      const table = data.rows[spaceHandle];
      if (table === undefined) return [];

      let head = data.heads[spaceHandle] ?? 0;
      const accepted = [];

      for (const record of records) {
        head += 1;
        table[`${record.collection}/${record.id}`] = {
          collection: record.collection,
          id: record.id,
          serverRev: head,
          updatedAt: record.updatedAt,
          deletedAt: record.deletedAt,
          sealed: record.sealed,
          // 顺序 14：设备号也存下来，开发后端才看得见设备列表
          deviceId: record.deviceId ?? null,
        };
        accepted.push({ collection: record.collection, id: record.id, serverRev: head });
      }

      data.heads[spaceHandle] = head;
      await save();
      return accepted;
    },

    async list(spaceHandle, options) {
      await load();
      const table = data.rows[spaceHandle] ?? {};
      return Object.values(table)
        .map((row) => row as { serverRev: number })
        .filter((row) => row.serverRev > options.since)
        .sort((left, right) => left.serverRev - right.serverRev)
        .slice(0, options.limit) as never;
    },

    /**
     * 顺序 14 / 15 这两个口子也要给开发后端接上。
     *
     * 少了它们，`pnpm dev` 里那台「服务端」会表现得像一台老服务器：
     * 设备列表空、换密码报「不支持」。本机联调时最容易踩的就是这种
     * 「代码是新的、跑起来的是旧的」，所以开发后端必须跟内核一起长。
     */
    async deviceUsage(spaceHandle) {
      await load();
      const rows = Object.values(data.rows[spaceHandle] ?? {}) as {
        deviceId?: string | null;
        updatedAt: string;
      }[];
      const byDevice = new Map<string, { deviceId: string; lastWriteAt: string; records: number }>();
      for (const row of rows) {
        const id = row.deviceId ?? '';
        if (id === '') continue;
        const existing = byDevice.get(id);
        if (existing === undefined) {
          byDevice.set(id, { deviceId: id, lastWriteAt: row.updatedAt, records: 1 });
          continue;
        }
        existing.records += 1;
        if (row.updatedAt > existing.lastWriteAt) existing.lastWriteAt = row.updatedAt;
      }
      return [...byDevice.values()].sort((left, right) => right.lastWriteAt.localeCompare(left.lastWriteAt));
    },

    async rotatePassword(spaceHandle, patch) {
      await load();
      const space = data.spaces[spaceHandle];
      if (space === undefined) return false;
      data.spaces[spaceHandle] = {
        ...space,
        credentialHash: patch.credentialHash,
        keyWraps: { ...space.keyWraps, password: patch.passwordWrap },
      };
      await save();
      return true;
    },
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> | undefined {
  if (chunks.length === 0) return undefined;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readBody(request: NodeRequestLike): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return concat(chunks);
}

export interface SyncDevBackendOptions {
  /** 数据文件路径；缺省放在系统临时目录，避免污染工作区。 */
  file?: string;
}

export function syncDevBackend(options: SyncDevBackendOptions = {}): Plugin {
  let ready: Promise<{ server: SyncServer }> | null = null;

  const setup = async (vite: ViteDevServer): Promise<{ server: SyncServer }> => {
    const core = (await vite.ssrLoadModule('@dramatis/core')) as {
      createSyncServer: (store: SyncServerStore) => SyncServer;
    };
    const fs = await nodeModule<NodeFs>('node:fs/promises');
    const os = await nodeModule<NodeOs>('node:os');
    const path = await nodeModule<NodePath>('node:path');
    const file = options.file ?? path.join(os.tmpdir(), 'dramatis-sync-dev.json');
    return { server: core.createSyncServer(createJsonFileStore(file, fs, path)) };
  };

  const middlewareFor =
    (vite: ViteDevServer) =>
    (request: NodeRequestLike, response: NodeResponseLike): void => {
      void (async () => {
        try {
          ready ??= setup(vite);
          const { server } = await ready;

          const core = (await vite.ssrLoadModule('@dramatis/core')) as {
            handleSyncRequest: (request: Request, deps: { server: SyncServer }) => Promise<Response>;
          };

          const host = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1';
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) {
            if (value === undefined) continue;
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const body = await readBody(request);

          const handled = await core.handleSyncRequest(
            new Request(`http://${host}/sync${request.url ?? '/'}`, {
              method: request.method ?? 'GET',
              headers,
              ...(body === undefined ? {} : { body }),
            }),
            { server },
          );

          const text = await handled.text();
          response.statusCode = handled.status;
          handled.headers.forEach((value, key) => {
            response.setHeader(key, value);
          });
          response.end(text);
        } catch (error) {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(
            JSON.stringify({
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
            }),
          );
        }
      })();
    };

  return {
    name: 'dramatis-sync-dev-backend',
    configureServer(vite) {
      // vite 的中间件类型来自 @types/node，这里刻意不引它，所以就地转一次
      vite.middlewares.use('/sync', middlewareFor(vite) as never);
    },
  };
}
