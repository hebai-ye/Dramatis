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

type DecompressionStreamCtor = new (format: 'deflate' | 'deflate-raw' | 'gzip') => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

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

  return new Uint8Array(await new Response(decompressed).arrayBuffer());
};
