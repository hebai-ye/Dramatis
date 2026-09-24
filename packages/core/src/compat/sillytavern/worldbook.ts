import {
  SelectiveLogic,
  type SelectiveLogicValue,
  type WorldBook,
  type WorldBookEntry,
  type WorldBookPosition,
} from '../../model/card.js';
import { nowIso, type WorldBookId, worldBookId } from '../../model/ids.js';
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

  /*
   * 位置：认识的 0–4 各就各位（顺序 60），不认识的才记一条 warning。
   * 以前这里不提示，用户会以为导出后位置语义没了——「不静默丢弃」是这一层的要求。
   */
  const positionCode = num(record.position, 0);
  const position = POSITION_BY_CODE[positionCode];
  if (position === undefined) {
    warnings.push({
      code: 'unsupported-position',
      message: `世界书条目「${str(record.comment) || fallbackId}」的插入位置 ${String(positionCode)} 不认识，按默认位置（并进世界设定）处理`,
    });
  }

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
    position: position ?? 'unknown',
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

  const at = nowIso();
  return {
    book: { id, name, entries, extensions, createdAt: at, updatedAt: at, deletedAt: null },
    warnings,
  };
}

export interface WorldBookMatch {
  entry: WorldBookEntry;
  matchedKeys: string[];
  reason: 'constant' | 'keyword';
  /** 第几轮扫出来的：1 是玩家输入 + 最近历史那一轮，>1 是被上一轮命中带出来的（顺序 60）。 */
  round: number;
}

export interface MatchOptions {
  /** 单块扫描文本。与 `scanLines` 二选一时以 `scanLines` 为准（保留它给简单调用与老测试）。 */
  scanText?: string;
  /**
   * 扫描窗口，**按时间从旧到新**排列（通常是最近若干条对话 + 玩家这一句）。
   *
   * 为什么是数组而不是一段拼好的文本：顺序 60 起，每条世界书条目按**自己的** `scanDepth`
   * 从末尾截取，所以「扫描窗口有多长」是逐条决定的，调用方不能提前拼死。
   */
  scanLines?: readonly string[];
  /** 条目没写 `scanDepth` 时看多少条（SillyTavern 的全局默认是 8）。 */
  globalScanDepth?: number;
  /** 递归最多跑几轮（默认 3）：上一轮命中的正文会被当成新的扫描文本。 */
  maxRecursionRounds?: number;
  /** 注入随机源便于测试；默认 Math.random。 */
  random?: () => number;
}

/** SillyTavern 里 `scanDepth` 为空时看的条数。 */
export const DEFAULT_SCAN_DEPTH = 8;

/** 递归轮数上限。再长就是「世界书自己和自己互相触发」，收益小、提示词涨得快。 */
export const DEFAULT_MAX_RECURSION_ROUNDS = 3;

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
 * 一条条目在这段文本里命中了哪些主键；没命中返回 null。
 *
 * 常驻条目（constant）不看文本，永远算命中——所以它返回空数组而不是 null。
 */
function matchedKeysIn(entry: WorldBookEntry, scanText: string): string[] | null {
  if (entry.constant) return [];

  const matchedKeys = entry.keys.filter((key) => keyMatches(scanText, key, entry));
  if (matchedKeys.length === 0) return null;

  const secondaryHits = entry.secondaryKeys.map((key) => keyMatches(scanText, key, entry));
  if (!applySelectiveLogic(entry, secondaryHits)) return null;
  return matchedKeys;
}

/**
 * 这一条该看多长的窗口。
 *
 * 条目自己的 `scanDepth` 优先，`null` 才用全局默认；递归带出来的正文不算「对话条数」，
 * 它们永远留在窗口里（否则第二轮一进来就被自己的 scanDepth 截掉了）。
 */
function scanWindowFor(
  entry: WorldBookEntry,
  lines: readonly string[],
  injected: readonly string[],
  globalScanDepth: number,
): string {
  const depth = entry.scanDepth ?? globalScanDepth;
  const count = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  const tail = count === 0 ? [] : lines.slice(Math.max(0, lines.length - count));
  return [...tail, ...injected].join('\n');
}

/** 概率骰子。`useProbability` 关掉或写满 100 时**不消耗**随机源（老测试盯着这一点）。 */
function passesProbability(entry: WorldBookEntry, random: () => number): boolean {
  if (!entry.useProbability || entry.probability >= 100) return true;
  return random() * 100 < entry.probability;
}

/**
 * 按关键词筛选应当插入的世界书条目（顺序 60 补齐了 SillyTavern 的匹配语义）。
 *
 * 与旧版的差别有四条：
 * 1. **逐条 `scanDepth`**：每条条目看自己那一段窗口，而不是所有条目共用「最后 8 条」；
 * 2. **递归**：最多 3 轮，上一轮命中的正文当新的扫描文本；`preventRecursion` 的条目不做
 *    触发源，`excludeRecursion` 的条目不被递归触发；
 * 3. **group**：同一组只留一条（`order` 最高优先，用了概率的条目没过骰子就顺延给下一条）；
 * 4. 概率骰子从「边扫边掷」挪到**收口之后**，否则同组的两条会被掷两次，语义不一致。
 *
 * 返回结果按 `order` 降序排列，与 SillyTavern 的插入优先级一致。
 */
export function matchWorldBookEntries(book: WorldBook, options: MatchOptions): WorldBookMatch[] {
  const random = options.random ?? Math.random;
  const globalScanDepth = options.globalScanDepth ?? DEFAULT_SCAN_DEPTH;
  const maxRounds = Math.max(1, Math.floor(options.maxRecursionRounds ?? DEFAULT_MAX_RECURSION_ROUNDS));
  const lines =
    options.scanLines ?? (options.scanText === undefined || options.scanText === '' ? [] : [options.scanText]);

  const matched = new Map<string, WorldBookMatch>();
  /** 递归用的「新扫描文本」：**上一轮**命中、且没标 preventRecursion 的正文。 */
  const injected: string[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    let hitThisRound = false;
    /*
     * 本轮新命中的正文先攒着，**等这一轮扫完再加进窗口**。
     * 边扫边加会让「排在后面的条目」在同一轮里就看到前面条目的正文，
     * 递归就退化成了一次全量扫描（实测：三层递归在 round 1 全部命中）。
     */
    const nextRoundInjection: string[] = [];

    for (const entry of book.entries) {
      if (entry.disabled) continue;
      if (matched.has(entry.id)) continue;
      // 第一轮是主扫描，谁都算；第二轮起跳过「不被递归触发」的条目
      if (round > 1 && entry.excludeRecursion) continue;

      const matchedKeys = matchedKeysIn(entry, scanWindowFor(entry, lines, injected, globalScanDepth));
      if (matchedKeys === null) continue;

      matched.set(entry.id, {
        entry,
        matchedKeys,
        reason: entry.constant ? 'constant' : 'keyword',
        round,
      });
      hitThisRound = true;

      const content = entry.content.trim();
      if (round < maxRounds && !entry.preventRecursion && content !== '') {
        nextRoundInjection.push(content);
      }
    }

    // 这一轮既没命中、也没有新的触发源，再扫下去不会变
    if (!hitThisRound || nextRoundInjection.length === 0) break;
    injected.push(...nextRoundInjection);
  }

  const compareByOrder = (a: WorldBookMatch, b: WorldBookMatch): number => {
    if (b.entry.order !== a.entry.order) return b.entry.order - a.entry.order;
    return a.entry.title.localeCompare(b.entry.title);
  };

  const picked: WorldBookMatch[] = [];
  const groups = new Map<string, WorldBookMatch[]>();
  for (const match of matched.values()) {
    const group = match.entry.group.trim();
    if (group === '') {
      // 不进组的条目各掷各的
      if (passesProbability(match.entry, random)) picked.push(match);
      continue;
    }
    const list = groups.get(group);
    if (list === undefined) groups.set(group, [match]);
    else list.push(match);
  }

  for (const list of groups.values()) {
    list.sort(compareByOrder);
    // 同组只留一条：order 最高的先掷，没过骰子才轮到下一条
    const winner = list.find((match) => passesProbability(match.entry, random));
    if (winner !== undefined) picked.push(winner);
  }

  return picked.sort(compareByOrder);
}
