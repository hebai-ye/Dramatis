/**
 * Deflate 解压适配器。
 *
 * PNG 的 zTXt / iTXt 数据块使用 zlib 格式压缩。浏览器与 Node 18+
 * 都提供全局 `DecompressionStream`，因此内核不需要引入压缩库，
 * 也不需要 `node:zlib` 这样的平台依赖。
 */
export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

export class InflateUnavailableError extends Error {
  constructor() {
    super('当前运行环境不支持 DecompressionStream，无法读取压缩的 PNG 文本块');
    this.name = 'InflateUnavailableError';
  }
}

/**
 * 解压结果的上限：**8 MB**（审计 B15）。
 *
 * 为什么必须有：deflate 的压缩比可以到上千倍，几 KB 的 PNG 文本块能解压出几个 GB，
 * 把标签页直接撑爆（zip bomb）。真正的角色卡（含内嵌立绘 base64）也远小于这个数——
 * 超过它要么是恶意文件，要么是根本不该读进来的东西，**中止比硬撑安全**。
 */
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

export class InflateTooLargeError extends Error {
  constructor(limit: number = MAX_INFLATED_BYTES) {
    super(`压缩块解压后超过 ${String(Math.round(limit / (1024 * 1024)))} MB，已中止（这不像是一张正常的角色卡）`);
    this.name = 'InflateTooLargeError';
  }
}

type DecompressionStreamCtor = new (
  format: 'deflate' | 'deflate-raw' | 'gzip',
) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

/**
 * 把一条字节流读完，**边读边数**，一旦超过 `limit` 就掐掉。
 *
 * 关键是「边读边数」：`new Response(stream).arrayBuffer()` 会先老老实实把全部内容
 * 收进内存，等它返回时炸弹已经炸了。这里主动 cancel 掉上游，服务端/解压器不必再算下去。
 *
 * 独立成函数是为了能测：用一个很小的上限就能验证「超限即中止」，
 * 不必在单测里真的造 8 MB 数据。
 */
export async function readAllWithLimit(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      if (total > limit) {
        // 先掐上游再抛：不能让解压器继续为我们不打算要的数据干活
        await reader.cancel().catch(() => undefined);
        throw new InflateTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已经 cancel 过、或还有读挂在上面时 releaseLock 会抛；这里没有别的收尾要做
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 基于 `DecompressionStream` 的默认实现。
 *
 * `new Uint8Array(data)` 会复制一份，确保底层是普通 ArrayBuffer，
 * 避免共享内存缓冲区在部分平台上无法作为 Blob 分片。
 */
export const streamInflate: Inflate = async (data) => {
  const ctor = (globalThis as { DecompressionStream?: unknown }).DecompressionStream as
    | DecompressionStreamCtor
    | undefined;

  if (typeof ctor !== 'function') {
    throw new InflateUnavailableError();
  }

  const copy = new Uint8Array(data);
  const compressed = new Blob([copy]).stream();
  const decompressed = compressed.pipeThrough(new ctor('deflate'));

  return readAllWithLimit(decompressed, MAX_INFLATED_BYTES);
};
