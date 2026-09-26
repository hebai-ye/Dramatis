import { describe, expect, it } from 'vitest';
import { importCardFromPng } from './card.js';
import {
  InflateTooLargeError,
  InflateUnavailableError,
  MAX_INFLATED_BYTES,
  readAllWithLimit,
  streamInflate,
} from './inflate.js';
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

/**
 * 故意把 CRC 改坏的块（顺序 64）。
 *
 * PNG 块的最后 4 个字节就是 CRC，翻掉最后一字节既能让校验对不上，
 * 又不动内容——正好是「被别的工具重新压过」那种坏法。
 */
function corruptCrc(part: Uint8Array): Uint8Array {
  const broken = new Uint8Array(part);
  const last = broken.length - 1;
  broken[last] = (broken[last] ?? 0) ^ 0xff;
  return broken;
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
  it('crc32 对得上标准向量（"123456789" → 0xCBF43926）', () => {
    // 顺序 64 之前这个函数是死代码，但它一用上就是「认不认得出真卡」的判据，值得钉住
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

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

  it('CRC 对不上的块跳过，并留下一条 png.bad-crc 警告', async () => {
    const warnings: Array<{ code: string; message: string }> = [];
    const png = concat([
      SIGNATURE,
      ihdr(),
      textChunk('chara', 'first'),
      corruptCrc(textChunk('description', '被压坏的块')),
      textChunk('ccv3', 'second'),
      end(),
    ]);

    const chunks = await readPngTextChunks(png, { warnings });

    expect(chunks.map((item) => item.keyword)).toEqual(['chara', 'ccv3']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('png.bad-crc');
    expect(warnings[0]?.message).toContain('description');
  });

  it('CRC 正确时一条警告都不发', async () => {
    const warnings: Array<{ code: string; message: string }> = [];
    const png = concat([SIGNATURE, ihdr(), textChunk('chara', 'hello'), end()]);

    await readPngTextChunks(png, { warnings });

    expect(warnings).toEqual([]);
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

  it('坏块被跳过，但卡本身照常导入（并带着警告）', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '炉边诗人', description: '常在夜里唱曲的旅人。', first_mes: '要来一杯吗？' },
    };
    const png = concat([
      SIGNATURE,
      ihdr(),
      corruptCrc(textChunk('description', '这块坏了')),
      textChunk('chara', toBase64(JSON.stringify(card))),
      end(),
    ]);

    const result = await importCardFromPng(png, 'poet.png');

    expect(result.card.name).toBe('炉边诗人');
    expect(result.warnings.some((warning) => warning.code === 'png.bad-crc')).toBe(true);
  });

  it('角色卡那一块自己坏了：报错里说清「有块 CRC 没过」', async () => {
    const png = concat([SIGNATURE, ihdr(), corruptCrc(textChunk('chara', 'whatever')), end()]);

    await expect(importCardFromPng(png)).rejects.toThrow(/CRC/);
  });
});

/*
 * 审计 B15：两件事以前会让导入以最难看的方式失败——
 * ①解压没有上限，几 KB 的块能解出几 GB（压缩炸弹），标签页直接被撑爆；
 * ②任意一个文本块解析失败都会让整张卡导入失败，哪怕那块与角色卡毫无关系。
 */
describe('PNG 解压上限与坏块跳过（审计 B15）', () => {
  it('上限就是 8 MB', () => {
    expect(MAX_INFLATED_BYTES).toBe(8 * 1024 * 1024);
  });

  it('没超上限时按原样、按顺序拼回来', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    });

    expect([...(await readAllWithLimit(stream, 5))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('边读边数：超限立刻抛出并掐掉上游，不等整条流读完', async () => {
    let cancelled = false;
    // 永不结束的流：如果实现是「全收进内存再检查」，这个测试会一直转下去
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readAllWithLimit(stream, 8192)).rejects.toThrow(InflateTooLargeError);
    expect(cancelled).toBe(true);
  });

  it('压缩炸弹真的会被拦住：9 MB 的零只压出几 KB，解压时停在 8 MB', async () => {
    const bomb = await deflate(new Uint8Array(9 * 1024 * 1024));
    // 先确认这确实是「小文件撑出大内存」的那种输入
    expect(bomb.byteLength).toBeLessThan(100 * 1024);

    await expect(streamInflate(bomb)).rejects.toThrow(InflateTooLargeError);
  });

  it('与角色卡无关的压缩块坏掉时，卡照常导入并带上警告', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '炉边诗人', description: '常在夜里唱曲的旅人。', first_mes: '要来一杯吗？' },
    };
    const png = concat([
      SIGNATURE,
      ihdr(),
      await ztxtChunk('description', '这块解不开'),
      textChunk('chara', toBase64(JSON.stringify(card))),
      end(),
    ]);

    const result = await importCardFromPng(png, 'poet.png', {
      inflate: () => Promise.reject(new InflateTooLargeError()),
    });

    expect(result.card.name).toBe('炉边诗人');
    const failed = result.warnings.find((warning) => warning.code === 'png.chunk-failed');
    expect(failed?.message).toContain('description');
    expect(failed?.message).toContain('MB');
  });

  it('环境不支持解压时照样抛错：这不是坏文件，不能静默跳过', async () => {
    const png = concat([SIGNATURE, ihdr(), await ztxtChunk('chara', '{}'), end()]);

    await expect(
      readPngTextChunks(png, {
        inflate: () => Promise.reject(new InflateUnavailableError()),
      }),
    ).rejects.toThrow(InflateUnavailableError);
  });
});
