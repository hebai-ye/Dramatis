import type { Card, CardSource } from '../../model/card.js';
import { cardId, nowIso } from '../../model/ids.js';
import { asRecord, str } from '../../util/json.js';
import type { Inflate } from './inflate.js';
import { findCardPayload, readPngTextChunks } from './png.js';

export interface ImportWarning {
  code: string;
  message: string;
}

export interface CardImportResult {
  card: Card;
  warnings: ImportWarning[];
}

export class CardImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardImportError';
  }
}

/** V2 / V3 规范中 `data` 字段下的已知键；V1 是平铺的同名字段。 */
const KNOWN_DATA_KEYS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'tags',
  'creator',
  'character_version',
  'extensions',
]);

/** 卡顶层允许出现但与内容无关的键，不算未知字段。 */
const KNOWN_SHELL_KEYS = new Set([
  'spec',
  'spec_version',
  'data',
  'avatar',
  'chat',
  'talkativeness',
  'fav',
  'create_date',
]);

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

const utf8Decoder = new TextDecoder('utf-8');

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 解析角色卡载荷。
 *
 * SillyTavern 在 PNG 的 `chara` 块里存的是「UTF-8 JSON 的 base64」，
 * 但 JSON 直传（以及部分第三方工具）会写明文 JSON，因此两种都要认。
 */
export function decodeCardPayload(payload: string): unknown {
  const trimmed = payload.trim();
  if (trimmed === '') {
    throw new CardImportError('角色卡载荷为空');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new CardImportError(`角色卡 JSON 解析失败：${(error as Error).message}`);
    }
  }

  let decoded: string;
  try {
    decoded = utf8Decoder.decode(base64ToBytes(trimmed));
  } catch {
    throw new CardImportError('角色卡载荷既不是 JSON，也不是有效的 base64');
  }

  try {
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    throw new CardImportError(`base64 解码后不是合法 JSON：${(error as Error).message}`);
  }
}

/**
 * 把 SillyTavern 的 V1 / V2 / V3 角色卡统一成 Dramatis 的 `Card`。
 *
 * 未识别的字段一律保留进 `extensions` 并产生 warning，
 * 遵守设计文档 §9.2 的「不允许静默丢弃」。
 */
export function parseCharacterCard(raw: unknown, source: Partial<CardSource> = {}): CardImportResult {
  const warnings: ImportWarning[] = [];
  const record = asRecord(raw);
  if (!record) {
    throw new CardImportError('角色卡内容不是 JSON 对象');
  }

  const spec = str(record.spec) || 'chara_card_v1';
  const isNested = spec !== 'chara_card_v1' && asRecord(record.data) !== null;
  const data = isNested ? (asRecord(record.data) ?? {}) : record;

  if (spec !== 'chara_card_v1' && spec !== 'chara_card_v2' && spec !== 'chara_card_v3') {
    warnings.push({
      code: 'unknown-spec',
      message: `未识别的角色卡规范「${spec}」，按已有字段尽力导入`,
    });
  }

  const extensions: Record<string, unknown> = { ...(asRecord(data.extensions) ?? {}) };
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (KNOWN_DATA_KEYS.has(key) || key === 'extensions') continue;
    if (key in extensions) continue;
    extensions[key] = value;
    unknownKeys.push(key);
  }

  if (unknownKeys.length > 0) {
    warnings.push({
      code: 'unknown-fields',
      message: `以下字段未被识别，已原样保留：${unknownKeys.join('、')}`,
    });
  }

  const name = str(data.name).trim();
  if (name === '') {
    warnings.push({ code: 'missing-name', message: '角色卡没有名字，已命名为「未命名角色」' });
  }

  const firstMessage = str(data.first_mes);
  if (firstMessage === '') {
    warnings.push({ code: 'missing-greeting', message: '角色卡没有开场白，进入场景时不会自动发言' });
  }

  if (spec === 'chara_card_v1') {
    const shellUnknown = Object.keys(record).filter((key) => !KNOWN_SHELL_KEYS.has(key) && !KNOWN_DATA_KEYS.has(key));
    if (shellUnknown.length > 0) {
      warnings.push({
        code: 'unknown-fields',
        message: `V1 卡顶层有未识别字段，已原样保留：${shellUnknown.join('、')}`,
      });
      for (const key of shellUnknown) {
        if (!(key in extensions)) extensions[key] = record[key];
      }
    }
  }

  const card: Card = {
    id: cardId(crypto.randomUUID()),
    name: name === '' ? '未命名角色' : name,
    nickname: '',
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    firstMessage,
    alternateGreetings: strArray(data.alternate_greetings),
    exampleMessages: str(data.mes_example),
    systemPrompt: str(data.system_prompt),
    postHistoryInstructions: str(data.post_history_instructions),
    creator: str(data.creator),
    creatorNotes: str(data.creator_notes),
    characterVersion: str(data.character_version),
    tags: strArray(data.tags),
    embeddedWorldBook: data.character_book ?? null,
    extensions,
    source: {
      kind: source.kind ?? 'json',
      ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
      spec: spec === 'chara_card_v1' ? 'chara_card_v1' : spec,
      specVersion: str(record.spec_version),
      importedAt: nowIso(),
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };

  return { card, warnings };
}

/** 从 JSON 文本导入角色卡。 */
export function importCardFromJson(text: string, fileName?: string): CardImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CardImportError(`角色卡 JSON 解析失败：${(error as Error).message}`);
  }
  return parseCharacterCard(parsed, {
    kind: 'json',
    ...(fileName !== undefined ? { fileName } : {}),
  });
}

/**
 * 从 PNG 字节导入角色卡。
 *
 * 优先读 `ccv3`，其次 `chara`；两者都没有时给出可操作的错误信息。
 */
export async function importCardFromPng(
  bytes: Uint8Array,
  fileName?: string,
  options: { inflate?: Inflate } = {},
): Promise<CardImportResult> {
  /*
   * CRC 校验失败的块会被跳过（顺序 64），跳过这事得让用户看得见：
   * 一张「少了内嵌世界书」的卡，和一张「本来就只有角色卡」的卡，是两回事。
   */
  const warnings: ImportWarning[] = [];
  const chunks = await readPngTextChunks(bytes, { ...options, warnings });
  const payload = findCardPayload(chunks);

  if (!payload) {
    const keywords = chunks.map((chunk) => chunk.keyword).filter((keyword) => keyword !== '');
    const badCrc = warnings.filter((warning) => warning.code === 'png.bad-crc').length;
    /*
     * 三种「没找到卡」要分开说（顺序 64）：这里跳过过坏块时，就别再说
     * 「这可能只是一张普通图片」——那张图很可能正是用户的卡，只是被改坏了。
     */
    const reason =
      keywords.length > 0
        ? `仅找到：${keywords.join('、')}`
        : badCrc > 0
          ? `另有 ${String(badCrc)} 个数据块的 CRC 校验没通过、已被跳过——这张卡多半被别的工具改坏了`
          : '这可能只是一张普通图片';
    throw new CardImportError(
      `PNG 中没有读到角色卡数据块（chara / ccv3）${keywords.length > 0 ? '，' : '：'}${reason}`,
    );
  }

  const decoded = decodeCardPayload(payload.text);
  const result = parseCharacterCard(decoded, {
    kind: 'png',
    ...(fileName !== undefined ? { fileName } : {}),
  });

  return warnings.length === 0 ? result : { card: result.card, warnings: [...warnings, ...result.warnings] };
}
