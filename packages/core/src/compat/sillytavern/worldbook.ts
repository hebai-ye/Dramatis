import {
  SelectiveLogic,
  type SelectiveLogicValue,
  type WorldBook,
  type WorldBookEntry,
  type WorldBookPosition,
} from '../../model/card.js';
import { type WorldBookId, worldBookId } from '../../model/ids.js';
import type { ImportWarning } from './card.js';

export interface WorldBookImportResult {
  book: WorldBook;
  warnings: ImportWarning[];
}

const POSITION_BY_CODE: Record<number, WorldBookPosition> = {
  0: 'before_char',
  1: 'after_char',
  2: 'before_an',
  3: 'after_an',
  4: 'at_depth',
};

const KNOWN_ENTRY_KEYS = new Set([
  'uid',
  'id',
  'key',
  'keys',
  'keysecondary',
  'secondary_keys',
  'comment',
  'content',
  'constant',
  'selective',
  'selectiveLogic',
  'order',
  'position',
  'depth',
  'probability',
  'useProbability',
  'disable',
  'caseSensitive',
  'matchWholeWords',
  'scanDepth',
  'preventRecursion',
  'excludeRecursion',
  'group',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** SillyTavern 的 key 字段有时是字符串，有时是字符串数组。 */
function strArray(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function parseEntry(raw: unknown, fallbackId: string, warnings: ImportWarning[]): WorldBookEntry | null {
  const record = asRecord(raw);
  if (!record) return null;

  const extensions: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (KNOWN_ENTRY_KEYS.has(key)) continue;
    extensions[key] = value;
    unknownKeys.push(key);
  }
  if (unknownKeys.length > 0) {
    warnings.push({
      code: 'unknown-entry-fields',
      message: `世界书条目「${str(record.comment) || fallbackId}」有未识别字段，已原样保留：${unknownKeys.join('、')}`,
    });
  }

  const uid = record.uid ?? record.id ?? fallbackId;
  const selectiveLogicRaw = num(record.selectiveLogic, SelectiveLogic.AND_ANY);
  const selectiveLogic = (
    [0, 1, 2, 3].includes(selectiveLogicRaw) ? selectiveLogicRaw : SelectiveLogic.AND_ANY
  ) as SelectiveLogicValue;

  return {
    id: String(uid),
    title: str(record.comment),
    keys: strArray(record.key ?? record.keys),
    secondaryKeys: strArray(record.keysecondary ?? record.secondary_keys),
    content: str(record.content),
    constant: bool(record.constant, false),
    selective: bool(record.selective, true),
    selectiveLogic,
    order: num(record.order, 100),
    position: POSITION_BY_CODE[num(record.position, 0)] ?? 'unknown',
    depth: num(record.depth, 4),
    probability: num(record.probability, 100),
    useProbability: bool(record.useProbability, true),
    disabled: bool(record.disable, false),
    caseSensitive: bool(record.caseSensitive, false),
    matchWholeWords: bool(record.matchWholeWords, false),
    scanDepth: typeof record.scanDepth === 'number' && Number.isFinite(record.scanDepth) ? record.scanDepth : null,
    preventRecursion: bool(record.preventRecursion, true),
    excludeRecursion: bool(record.excludeRecursion, false),
    group: str(record.group),
    extensions,
  };
}

/**
 * 导入 SillyTavern 世界书。
 *
 * 兼容三种形态：`{ entries: { "0": {...} } }`、`{ entries: [...] }`、
 * 以及直接由 uid 作键的对象。
 */
export function parseWorldBook(
  raw: unknown,
  name = '未命名世界书',
  id: WorldBookId = worldBookId(crypto.randomUUID()),
): WorldBookImportResult {
  const warnings: ImportWarning[] = [];
  const root = asRecord(raw);
  if (!root) {
    throw new Error('世界书内容不是 JSON 对象');
  }

  // 条目容器有三种形态：`{ entries: [...] }`、`{ entries: { "0": {...} } }`、
  // 以及直接把 uid 当键的 `{ "0": {...} }`。缺省时才回退到根对象。
  const container: unknown = root.entries ?? root;
  const rawEntries: Array<[string, unknown]> = Array.isArray(container)
    ? container.map((entry, index) => [String(index), entry] as [string, unknown])
    : Object.entries(asRecord(container) ?? {});

  const entries: WorldBookEntry[] = [];
  let skipped = 0;
  let emptyKeys = 0;

  for (const [key, value] of rawEntries) {
    const entry = parseEntry(value, key, warnings);
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (!entry.constant && entry.keys.length === 0) {
      emptyKeys += 1;
    }
    entries.push(entry);
  }

  if (skipped > 0) {
    warnings.push({ code: 'skipped-entries', message: `跳过了 ${skipped} 个无法解析的条目` });
  }
  if (emptyKeys > 0) {
    warnings.push({
      code: 'entries-without-keys',
      message: `${emptyKeys} 个条目既非常驻又没有关键词，永远不会被触发`,
    });
  }

  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key === 'entries') continue;
    extensions[key] = value;
  }

  return {
    book: { id, name, entries, extensions },
    warnings,
  };
}

export interface WorldBookMatch {
  entry: WorldBookEntry;
  matchedKeys: string[];
  reason: 'constant' | 'keyword';
}

export interface MatchOptions {
  /** 用于扫描的文本，通常是最近若干轮对话 + 玩家输入。 */
  scanText: string;
  /** 注入随机源便于测试；默认 Math.random。 */
  random?: () => number;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** 中日韩文字没有词间空格，整词匹配对它们没有意义。 */
const WIDE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function keyMatches(haystack: string, needle: string, entry: WorldBookEntry): boolean {
  const key = needle.trim();
  if (key === '') return false;

  const hay = entry.caseSensitive ? haystack : haystack.toLowerCase();
  const target = entry.caseSensitive ? key : key.toLowerCase();

  // 关键词含中日韩文字时退化为子串匹配：原文里「酒馆」两边永远紧贴汉字，
  // 强行要求词边界会让条目永远不会触发，与用户的直觉相反。
  if (!entry.matchWholeWords || WIDE_SCRIPT.test(key)) {
    return hay.includes(target);
  }

  // \b 对 Unicode 不可靠，这里显式用「非字母数字下划线」作为词边界
  const pattern = `(^|[^\\p{L}\\p{N}_])${target.replace(REGEXP_SPECIALS, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`;
  return new RegExp(pattern, 'u').test(hay);
}

function applySelectiveLogic(entry: WorldBookEntry, hitSecondary: boolean[]): boolean {
  if (entry.secondaryKeys.length === 0 || !entry.selective) return true;

  switch (entry.selectiveLogic) {
    case SelectiveLogic.AND_ANY:
      return hitSecondary.some(Boolean);
    case SelectiveLogic.NOT_ALL:
      return !hitSecondary.every(Boolean);
    case SelectiveLogic.NOT_ANY:
      return !hitSecondary.some(Boolean);
    case SelectiveLogic.AND_ALL:
      return hitSecondary.every(Boolean);
    default:
      return true;
  }
}

/**
 * 按关键词筛选应当插入的世界书条目。
 *
 * 返回结果按 `order` 降序排列，与 SillyTavern 的插入优先级一致。
 */
export function matchWorldBookEntries(book: WorldBook, options: MatchOptions): WorldBookMatch[] {
  const random = options.random ?? Math.random;
  const matches: WorldBookMatch[] = [];

  for (const entry of book.entries) {
    if (entry.disabled) continue;

    let matchedKeys: string[] = [];
    let reason: WorldBookMatch['reason'] = 'keyword';

    if (entry.constant) {
      reason = 'constant';
    } else {
      matchedKeys = entry.keys.filter((key) => keyMatches(options.scanText, key, entry));
      if (matchedKeys.length === 0) continue;

      const secondaryHits = entry.secondaryKeys.map((key) => keyMatches(options.scanText, key, entry));
      if (!applySelectiveLogic(entry, secondaryHits)) continue;
    }

    if (entry.useProbability && entry.probability < 100 && random() * 100 >= entry.probability) {
      continue;
    }

    matches.push({ entry, matchedKeys, reason });
  }

  return matches.sort((a, b) => {
    if (b.entry.order !== a.entry.order) return b.entry.order - a.entry.order;
    return a.entry.title.localeCompare(b.entry.title);
  });
}
