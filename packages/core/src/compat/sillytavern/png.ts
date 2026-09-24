import { type Inflate, streamInflate } from './inflate.js';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngTextChunkType = 'tEXt' | 'zTXt' | 'iTXt';

export interface PngTextChunk {
  type: PngTextChunkType;
  keyword: string;
  text: string;
  compressed: boolean;
}

/**
 * 导入警告的形状。
 *
 * 与 `card.ts` 的 `ImportWarning` 同形；这里刻意不 import 那一个——`card.ts` 已经
 * import 了本模块，反向再指一次会绕成环。
 */
export interface PngWarning {
  code: string;
  message: string;
}

export class PngParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngParseError';
  }
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** 标准 CRC-32，用于校验 PNG 数据块。 */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    const lookup = table[(crc ^ byte) & 0xff] ?? 0;
    crc = lookup ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new PngParseError('PNG 文件在读取长度字段时提前结束');
  }
  return (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) >>> 0;
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

/** 找到关键字与正文之间的 NUL 分隔符。 */
function splitKeyword(data: Uint8Array): { keyword: string; rest: Uint8Array } {
  const nul = data.indexOf(0);
  if (nul < 0) {
    throw new PngParseError('PNG 文本块缺少关键字分隔符');
  }
  return {
    keyword: latin1.decode(data.subarray(0, nul)),
    rest: data.subarray(nul + 1),
  };
}

async function parseTextChunk(data: Uint8Array, type: PngTextChunkType, inflate: Inflate): Promise<PngTextChunk> {
  const { keyword, rest } = splitKeyword(data);

  if (type === 'tEXt') {
    return { type, keyword, text: latin1.decode(rest), compressed: false };
  }

  if (type === 'zTXt') {
    const method = rest[0];
    if (method !== 0) {
      throw new PngParseError(`PNG zTXt 使用了不支持的压缩方法：${String(method)}`);
    }
    const text = utf8.decode(await inflate(rest.subarray(1)));
    return { type, keyword, text, compressed: true };
  }

  // iTXt: 压缩标志 + 压缩方法 + 语言标签\0 + 翻译关键字\0 + 正文
  const compressionFlag = rest[0];
  const compressionMethod = rest[1];
  let cursor = 2;

  const langEnd = rest.indexOf(0, cursor);
  if (langEnd < 0) throw new PngParseError('PNG iTXt 语言标签未正确结束');
  cursor = langEnd + 1;

  const translatedEnd = rest.indexOf(0, cursor);
  if (translatedEnd < 0) throw new PngParseError('PNG iTXt 翻译关键字未正确结束');
  cursor = translatedEnd + 1;

  let body = rest.subarray(cursor);
  const compressed = compressionFlag === 1;

  if (compressed) {
    if (compressionMethod !== 0) {
      throw new PngParseError(`PNG iTXt 使用了不支持的压缩方法：${String(compressionMethod)}`);
    }
    body = await inflate(body);
  }

  return { type, keyword, text: utf8.decode(body), compressed };
}

/**
 * 读取 PNG 中所有的文本块，**跳过 CRC 校验失败的块**。
 *
 * 校验失败通常意味着卡被某个工具重新压缩过，但内容仍可读；
 * 直接报错会让用户失去一张可用的卡，因此选择跳过并在结果中体现。
 *
 * 顺序 64 之前这里只是**写着**校验：遍历时压根没算过 CRC（`crc32` 是死代码）。
 * 现在每块都真算一遍（CRC 覆盖「类型 + 数据」四个字节的记账），对不上就跳过，
 * 并把原因塞进 `options.warnings`——用户拿到的只是一张「少了一块」的卡，
 * 得有个地方说得清少了什么、为什么。
 */
export async function readPngTextChunks(
  bytes: Uint8Array,
  options: { inflate?: Inflate; warnings?: PngWarning[] } = {},
): Promise<PngTextChunk[]> {
  const inflate = options.inflate ?? streamInflate;
  const warnings = options.warnings;

  if (bytes.length < PNG_SIGNATURE.length) {
    throw new PngParseError('文件太短，不是有效的 PNG');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new PngParseError('文件头不是 PNG 签名');
    }
  }

  const chunks: PngTextChunk[] = [];
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > bytes.length) {
      throw new PngParseError(`PNG 数据块 ${type} 超出文件长度，文件可能已损坏`);
    }

    const data = bytes.subarray(dataStart, dataEnd);
    // 块尾那 4 个字节是 CRC，覆盖「类型 + 数据」（PNG 规范）
    const storedCrc = readUint32(bytes, dataEnd);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));

    offset = dataEnd + 4;

    if (storedCrc !== actualCrc) {
      /*
       * 报错尽量长眼睛：文本块的关键字在数据最前面（NUL 之前），
       * 就算这一块坏了也能读出来——只说「tEXt 坏了」，用户没法判断丢了什么。
       */
      const keywordEnd = type === 'tEXt' || type === 'zTXt' || type === 'iTXt' ? data.indexOf(0) : -1;
      const keyword = keywordEnd > 0 ? latin1.decode(data.subarray(0, keywordEnd)) : '';
      warnings?.push({
        code: 'png.bad-crc',
        message: `PNG 数据块 ${type}${
          keyword === '' ? '' : `（关键字 ${keyword}）`
        } 的 CRC 校验没通过（文件可能被别的工具重新压过），这一块已跳过。`,
      });
      if (type === 'IEND') break;
      continue;
    }

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      chunks.push(await parseTextChunk(data, type, inflate));
    }

    if (type === 'IEND') break;
  }

  return chunks;
}

/**
 * 找出角色卡载荷。
 *
 * `ccv3` 是 V3 规范的新关键字，`chara` 是 V1/V2 的通行关键字。
 * 同时存在时优先取 `ccv3`，因为它携带的信息更完整。
 */
export function findCardPayload(chunks: PngTextChunk[]): PngTextChunk | null {
  for (const keyword of ['ccv3', 'chara']) {
    const found = chunks.find((chunk) => chunk.keyword === keyword && chunk.text.trim() !== '');
    if (found) return found;
  }
  return null;
}
