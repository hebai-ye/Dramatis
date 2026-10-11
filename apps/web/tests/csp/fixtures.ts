import { Buffer } from 'node:buffer';

// Literal 1x1 PNG is a non-secret local image fixture used for the App's data: background.
export const BACKGROUND_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64',
);

export const JSON_CARD = Buffer.from(
  JSON.stringify({ name: 'CSP JSON 素材', description: '固定、无秘密、仅用于导入验收。', first_mes: '测试开场。' }),
);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** Deterministic SillyTavern V2 chara metadata; no user card or private image enters this run. */
export function pngCard(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'CSP PNG 素材', description: '固定、无秘密、仅用于导入验收。', first_mes: '测试开场。' },
  };
  const metadata = Buffer.concat([
    Buffer.from('chara\0', 'ascii'),
    Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'ascii'),
  ]);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('tEXt', metadata),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
