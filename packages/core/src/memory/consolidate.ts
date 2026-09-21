/**
 * 记忆合并：把一个视角下一堆「日常经过」压成几条「印象」（顺序 27a 的第一步）。
 *
 * 为什么需要它（实测）：300 轮对话产生 **590 条记忆**（约 2 条/轮），
 * 而每轮召回只带得进几条——池子越大，真正相关的那条越容易选不中。
 * 合并要解决的就是这个：**让池子里的条目数不再随轮数线性增长**。
 *
 * 这个文件只做**纯函数**部分：**决定合并哪些**（`planConsolidation`）与
 * **给模型的那段提示词怎么写**（`buildConsolidationPrompt`）。
 * 真正调用模型、写入印象、把原文标成「已被取代」那一步放在后台队列里——
 * 因为它要花钱、要网络，而「哪些该合并」这件事必须先在单测里定死。
 *
 * 三条硬约束（写在最前面，因为它们决定实现对不对）：
 *
 * 1. **只标「已被取代」，绝不删原文**。印象通过 `supersedes` 指回原文 id；
 *    原文仍在库里、仍能被面板搜到、也仍能同步。这是回滚的唯一依据。
 * 2. **按视角分开合并**。A 眼里的印象与 B 眼里的印象本来就是两件事，
 *    混在一起会让角色失去差异（这正是这个产品最值钱的地方）。
 * 3. **只碰低重要度、没被钉住、没被删的**。重要度高、用户钉过的记忆
 *    宁可留在池子里占地方——它们本来就是「值得单独被想起来」的那几条。
 */

import { type EventId, eventId, type InstanceId, newId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';

export interface ConsolidationOptions {
  /** 重要度不超过它的才参与合并（默认 0.4：实测里绝大多数「日常经过」落在这条线以下）。 */
  minImportance?: number;
  /** 一个视角下**至少**攒到多少条才开始合并（默认 40：低于它就先留着，别急着压）。 */
  threshold?: number;
  /** 一次最多合并多少条（默认 40：太多会让模型总结得很糊，也让一次调用太贵）。 */
  batchSize?: number;
  /** 时间相邻的判断：两条之间超过这个毫秒数就不放进同一批（默认 6 小时）。 */
  gapMs?: number;
  /** 一次最多产出几组（默认 2：一次后台调用只处理最该处理的那一两组）。 */
  maxGroups?: number;
}

/** 一组准备合并的记忆：同一个视角、时间相邻、都够低调。 */
export interface ConsolidationGroup {
  /** 这一组的视角（`null` = 客观经过） */
  observerId: InstanceId | null;
  conversationId: string | null;
  /** 按时间升序的原文 id。 */
  memoryIds: EventId[];
  /** 这一组的时间跨度，给提示词与界面显示用。 */
  from: string;
  to: string;
  /** 这一组里重要度的最大值（用来判断「合并出来该算多重要」）。 */
  maxImportance: number;
}

const DEFAULTS = {
  /*
   * 重要度的门槛（2026-09-21 演练里调的）。
   *
   * 原来是 0.4，结果整轮演练一条都合并不了——因为抽取出来的「日常经过」普遍落在
   * 0.45 上下（假模型给的就是 0.45；那个数字恰好是「有点意思但不算大事」）。
   * 改成 **0.5**：把「日常经过」收进来，同时把明显重要的事（≥0.6 那几档）留在池子里。
   *
   * 另一个理由：合并出来的印象按设计是 `min(0.6, max+0.2)`，所以**印象自己会在 0.5 以上**，
   * 天然不会在下一轮被再次合并（否则会「滚雪球」）。
   */
  minImportance: 0.5,
  /*
   * 一个视角攒多少条才动手（2026-09-21 演练里从 40 调到 20）。
   *
   * 40 太钝：门槛只算**低重要度**的那些，单角色对话里一个视角大约每轮产出一条，
   * 于是要 ~120 轮才第一次触发合并（实测 50 轮时两个视角各 ~33 条，一组都没出）。
   * 20 条压成一条印象已经足够有用，也让「池子不再线性涨」这件事更早发生。
   */
  threshold: 20,
  batchSize: 20,
  gapMs: 6 * 60 * 60 * 1000,
  maxGroups: 2,
} as const;

/** 这条记忆能不能参与合并。抽出来是为了让「为什么它没被合并」可测、可解释。 */
export function isConsolidatable(memory: MemoryEvent, minImportance: number): boolean {
  if (memory.deletedAt !== null) return false;
  if (memory.pinned || memory.importanceLocked) return false;
  if (memory.importance > minImportance) return false;
  if (memory.supersededBy !== null && memory.supersededBy !== undefined) return false;
  // 已经被合并成印象的那些（印象本身重要度高）不再参与——否则会「滚雪球」
  return memory.consolidatedAt === null || memory.consolidatedAt === undefined;
}

/**
 * 挑出该合并的那些组。
 *
 * 纯函数：只读输入、只出计划，不写任何东西。调用方（后台队列）拿着计划去
 * 调模型、写印象、标原文。
 */
export function planConsolidation(
  memories: readonly MemoryEvent[],
  options: ConsolidationOptions = {},
): ConsolidationGroup[] {
  const minImportance = options.minImportance ?? DEFAULTS.minImportance;
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const gapMs = options.gapMs ?? DEFAULTS.gapMs;
  const maxGroups = options.maxGroups ?? DEFAULTS.maxGroups;

  // 1) 按「视角 + 对话」分组：合并只在同一个角色的记忆之间发生
  const byObserver = new Map<string, MemoryEvent[]>();
  for (const memory of memories) {
    if (!isConsolidatable(memory, minImportance)) continue;
    const key = `${memory.observerId ?? 'objective'}::${memory.conversationId ?? ''}`;
    const bucket = byObserver.get(key);
    if (bucket === undefined) byObserver.set(key, [memory]);
    else bucket.push(memory);
  }

  const groups: ConsolidationGroup[] = [];
  for (const bucket of byObserver.values()) {
    if (bucket.length < threshold) continue; // 还没攒够，先留着
    const sorted = [...bucket].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    /*
     * 2) 从**最旧的那一段**开始切：老记忆最不可能被单独想起来，
     *    而最近的记忆还在剧情里活着（下一轮就可能用到）。
     */
    let index = 0;
    while (index < sorted.length && groups.length < maxGroups) {
      const start = sorted[index];
      if (start === undefined) break;
      const batch: MemoryEvent[] = [start];
      index += 1;
      while (index < sorted.length && batch.length < batchSize) {
        const previous = batch[batch.length - 1];
        const candidate = sorted[index];
        if (previous === undefined || candidate === undefined) break;
        // 时间隔太远就不放同一批：一段「半个月前的事」和「昨天的事」不该被压成一条印象
        if (Date.parse(candidate.createdAt) - Date.parse(previous.createdAt) > gapMs) break;
        batch.push(candidate);
        index += 1;
      }

      // 一段不够长就不值得单独压（比如只剩孤零零三条）
      if (batch.length < Math.min(threshold, 10)) continue;

      const first = batch[0];
      const last = batch[batch.length - 1];
      if (first === undefined || last === undefined) continue;
      groups.push({
        observerId: first.observerId,
        conversationId: first.conversationId,
        memoryIds: batch.map((memory) => memory.id),
        from: first.createdAt,
        to: last.createdAt,
        maxImportance: Math.max(...batch.map((memory) => memory.importance)),
      });
    }
    if (groups.length >= maxGroups) break;
  }

  return groups;
}

/**
 * 给模型的那段提示词。
 *
 * 要求它做的事只有一件：**把这一串日常经过压成 1–3 句话的「印象」**，
 * 并且**保留能被问到的细节**（人名、地点、承诺、数字）。不要求它抒情、
 * 不要求它推断性格——那是情感推演那一层的事（`affect.ts`）。
 */
export function buildConsolidationPrompt(group: ConsolidationGroup, memories: readonly MemoryEvent[]): string {
  const lines = memories
    .filter((memory) => group.memoryIds.includes(memory.id))
    .map((memory) => `- [${memory.createdAt.slice(0, 10)}] ${memory.summary}`)
    .join('\n');

  return [
    '你在帮一个角色整理记忆。下面是他视角里的一段时间的日常经过（按时间排序）。',
    '',
    lines,
    '',
    '请把它们压成 1–3 句「印象」，要求：',
    '1. 只写站得住的事实与承诺（人名、地点、约定、数字），不要抒情，不要编细节；',
    '2. 用第一人称写（这是**他**记得的东西），例如「这半个月我一直在替秦娘瞒着账房的事」；',
    '3. 如果这几条之间没有共同线索，就直接说「这段时间没有值得单独记住的事」，不要硬凑。',
    '',
    '只输出那 1–3 句，不要解释、不要标题、不要 JSON。',
  ].join('\n');
}

/** 模型说「这几条之间没有共同线索」时它通常会这么说——认出来，别硬压。 */
const NOTHING_WORTH_KEEPING = /没有值得(单独)?记住|不值得记住|没有共同线索|没有相关/;

export interface ApplyConsolidationInput {
  group: ConsolidationGroup;
  /** 这个空间里**当前**的记忆（要按 id 找出这一组） */
  memories: readonly MemoryEvent[];
  /** 模型回来的文字（调用方去调，核心不碰网络） */
  reply: string;
  /** 印象的 id；不传就现造一个（测试里传固定值好断言） */
  impressionId?: EventId;
  now?: string;
}

export interface ConsolidationResult {
  /** 合并出来的印象；模型说「没什么值得记」时是 null */
  impression: MemoryEvent | null;
  /** 已经盖上「已被取代」章的原文（调用方负责落库） */
  originals: MemoryEvent[];
  /** 给人看的一句话（写进任务日志/面板） */
  note: string;
}

/** 清掉代码围栏与多余空行；一条印象不该是两千字。 */
function cleanImpression(raw: string): string {
  const withoutFence = raw
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .trim();
  const firstParagraph = withoutFence.split(/\n{2,}/)[0] ?? '';
  return (firstParagraph === '' ? withoutFence : firstParagraph).slice(0, 400).trim();
}

/**
 * 把模型的结果落成一条印象，并给原文盖章（顺序 27a 第二步的核心）。
 *
 * **纯函数**：只算不写。三条性质都能在单测里钉死：
 *
 * 1. **原文永不删**：只加 `supersededBy` 与 `consolidatedAt` 两个章；
 * 2. **印象带来源**：`supersedes` 指回这一组的每一条原文，面板因此能展开「这条印象是怎么来的」；
 * 3. **模型说没什么可记时也要盖章**：否则下一轮还会把同一批再送去问一遍，白花钱。
 */
export function applyConsolidation(input: ApplyConsolidationInput): ConsolidationResult {
  const now = input.now ?? new Date().toISOString();
  const inGroup = input.memories.filter((memory) => input.group.memoryIds.includes(memory.id));
  if (inGroup.length === 0)
    return { impression: null, originals: [], note: '这一组的原文已经不在库里了（可能被删或已被合并）' };

  const text = cleanImpression(input.reply);
  const originals = inGroup.map((memory) => ({
    ...memory,
    // 章先盖上（印象 id 那一刻才知道，见下）；这里用「待定」占位再由下面统一填
    consolidatedAt: now,
    updatedAt: now,
  }));

  if (text === '' || NOTHING_WORTH_KEEPING.test(text)) {
    return {
      impression: null,
      originals,
      note: text === '' ? '模型没给出可用的印象（返回空）' : '模型说这段时间没有值得单独记住的事',
    };
  }

  // reduce 的初始值是这一组的第一条；`inGroup` 已在上面判过非空
  const [firstMemory, ...restMemories] = inGroup;
  if (firstMemory === undefined) return { impression: null, originals: [], note: '这一组里没有原文' };
  const last = restMemories.reduce(
    (latest, memory) => (memory.createdAt > latest.createdAt ? memory : latest),
    firstMemory,
  );
  const impression: MemoryEvent = {
    id: input.impressionId ?? eventId(newId()),
    roomId: last.roomId,
    conversationId: last.conversationId,
    sceneId: last.sceneId,
    // 印象继承这一组最后一条的时间线位置（它是「到那时候为止」的印象）
    timeline: { ...last.timeline },
    location: last.location,
    participants: [...new Set(inGroup.flatMap((memory) => memory.participants))],
    summary: text,
    // 印象本身就是「他记得的那件事」，所以视角跟着这一组走（客观组仍然客观）
    observerId: input.group.observerId,
    perception: '',
    /*
     * 重要度：比这一组里最高的再高一点（印象比零散经过更值得被想起来），但封顶 0.6——
     * 超过 0.6 就进了「高重要度」那一档，会被保护起来不再参与任何合并。
     */
    importance: Math.min(0.6, input.group.maxImportance + 0.2),
    pinned: false,
    importanceLocked: false,
    affects: [...new Set(inGroup.flatMap((memory) => memory.affects))],
    sourceTurnIds: [...new Set(inGroup.flatMap((memory) => memory.sourceTurnIds))],
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    deletedAt: null,
    supersededBy: null,
    supersedes: [...input.group.memoryIds],
    consolidatedAt: now,
  };

  return {
    impression,
    originals: originals.map((memory) => ({ ...memory, supersededBy: impression.id })),
    note: `压成一条印象（${String(inGroup.length)} 条原文已盖章）`,
  };
}
