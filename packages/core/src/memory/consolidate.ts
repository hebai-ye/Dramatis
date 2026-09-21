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

import type { EventId, InstanceId } from '../model/ids.js';
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
  minImportance: 0.4,
  threshold: 40,
  batchSize: 40,
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
