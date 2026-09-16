import { describe, expect, it } from 'vitest';
import { importCardFromPng } from './card.js';
import { crc32, findCardPayload, PngParseError, readPngTextChunks } from './png.js';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 最小合法 IHDR，只为让文件结构看起来像 PNG。 */
function ihdr(): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  data[8] = 8;
  data[9] = 6;
  return chunk('IHDR', data);
}

function end(): Uint8Array {
  return chunk('IEND', new Uint8Array(0));
}

function textChunk(keyword: string, text: string): Uint8Array {
  const head = new TextEncoder().encode(`${keyword}\0`);
  return chunk('tEXt', concat([head, new TextEncoder().encode(text).map((byte) => byte & 0xff)]));
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function ztxtChunk(keyword: string, text: string): Promise<Uint8Array> {
  const head = new TextEncoder().encode(`${keyword}\0`);
  const method = Uint8Array.from([0]);
  const body = await deflate(new TextEncoder().encode(text));
  return chunk('zTXt', concat([head, method, body]));
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('readPngTextChunks', () => {
  it('读取未压缩的 tEXt 块', async () => {
    const png = concat([SIGNATURE, ihdr(), textChunk('chara', 'hello'), end()]);
    const chunks = await readPngTextChunks(png);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.keyword).toBe('chara');
    expect(chunks[0]?.text).toBe('hello');
    expect(chunks[0]?.compressed).toBe(false);
  });

  it('解压 zTXt 块', async () => {
    const png = concat([SIGNATURE, ihdr(), await ztxtChunk('description', '酒馆的炉火'), end()]);
    const chunks = await readPngTextChunks(png);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('zTXt');
    expect(chunks[0]?.text).toBe('酒馆的炉火');
    expect(chunks[0]?.compressed).toBe(true);
  });

  it('同时读取多个块并保留顺序', async () => {
    const png = concat([SIGNATURE, ihdr(), textChunk('chara', 'first'), await ztxtChunk('ccv3', 'second'), end()]);
    const chunks = await readPngTextChunks(png);

    expect(chunks.map((item) => item.keyword)).toEqual(['chara', 'ccv3']);
  });

  it('拒绝非 PNG 文件', async () => {
    await expect(readPngTextChunks(new TextEncoder().encode('这不是 PNG'))).rejects.toThrow(PngParseError);
  });

  it('拒绝声明长度超出文件的块', async () => {
    const png = concat([SIGNATURE, ihdr(), textChunk('chara', 'x')]);
    // 把第一个块的 length 字段改成一个不可能的值
    const broken = new Uint8Array(png);
    new DataView(broken.buffer).setUint32(8, 0xffffff);

    await expect(readPngTextChunks(broken)).rejects.toThrow(PngParseError);
  });
});

describe('findCardPayload', () => {
  it('优先选择 ccv3', async () => {
    const png = concat([SIGNATURE, ihdr(), textChunk('chara', 'old'), textChunk('ccv3', 'new'), end()]);
    const chunks = await readPngTextChunks(png);

    expect(findCardPayload(chunks)?.text).toBe('new');
  });

  it('没有卡数据时返回 null', async () => {
    const png = concat([SIGNATURE, ihdr(), textChunk('software', 'photoshop'), end()]);
    const chunks = await readPngTextChunks(png);

    expect(findCardPayload(chunks)).toBeNull();
  });
});

describe('importCardFromPng', () => {
  it('从 base64 载荷导入 V2 角色卡', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '炉边诗人',
        description: '常在夜里唱曲的旅人。',
        personality: '温和而健谈',
        first_mes: '要来一杯吗？',
        tags: ['酒馆'],
      },
    };

    const png = concat([SIGNATURE, ihdr(), textChunk('chara', toBase64(JSON.stringify(card))), end()]);
    const result = await importCardFromPng(png, 'poet.png');

    expect(result.card.name).toBe('炉边诗人');
    expect(result.card.firstMessage).toBe('要来一杯吗？');
    expect(result.card.tags).toEqual(['酒馆']);
    expect(result.card.source.kind).toBe('png');
    expect(result.card.source.fileName).toBe('poet.png');
  });

  it('普通图片给出可操作的错误信息', async () => {
    const png = concat([SIGNATURE, ihdr(), textChunk('software', 'photoshop'), end()]);

    await expect(importCardFromPng(png)).rejects.toThrow(/chara/);
  });
});
