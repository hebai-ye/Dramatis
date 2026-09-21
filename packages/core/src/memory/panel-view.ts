import type { ConversationId, EventId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';

/**
 * 记忆面板的视图计算（T11）。
 *
 * 记忆是**世界级**的，对话是多条的：同一个世界下开三条线，面板里就躺着三条线的
 * 记忆混在一起，用户看不出「这条是哪条线里的」。所以面板要两个维度：
 *
 * - **对话**：这条记忆是哪条对话产生的（`MemoryEvent.conversationId`）
 * - **视角**：客观经过，还是某个角色眼中的事（`observerId`）
 *
 * 这两个维度是正交的：只看「主线 × 秦娘」和「主线 × 客观」对照起来看，
 * 才谈得上「她记得的与实际上发生的差在哪」。计算放在内核里是为了能单测——
 * 界面只负责画。
 */

/** 「全部」在这些维度里是一个显式的取值，而不是 null——null 在数据里有别的含义。 */
export const ALL = 'all' as const;
export const OBJECTIVE = 'objective' as const;

export interface MemoryPanelFilter {
  /** 某条对话，或 `ALL`。 */
  conversationId: ConversationId | typeof ALL;
  /** 某个角色实例，或 `ALL` / `OBJECTIVE`。 */
  observerId: string | typeof ALL | typeof OBJECTIVE;
}

export function defaultMemoryFilter(): MemoryPanelFilter {
  return { conversationId: ALL, observerId: ALL };
}

export function filterMemories(memories: readonly MemoryEvent[], filter: MemoryPanelFilter): MemoryEvent[] {
  return memories.filter((memory) => {
    if (filter.conversationId !== ALL && memory.conversationId !== filter.conversationId) return false;
    if (filter.observerId === OBJECTIVE) return memory.observerId === null;
    if (filter.observerId !== ALL && memory.observerId !== filter.observerId) return false;
    return true;
  });
}

/**
 * 一条记忆落在哪条对话里。
 *
 * `conversationId` 在老数据上可能是 null（P2-6 之前的记忆没有对话维度），
 * 这种情况单独归一类，界面上说「未归属」而不是硬塞进第一条线。
 */
/** 这条条目是不是 27a 合并出来的粗粒度印象。 */
export function isImpressionMemory(memory: Pick<MemoryEvent, 'supersedes'>): boolean {
  return (memory.supersedes?.length ?? 0) > 0;
}

export interface MemorySourceChain {
  /** 按印象里记录的来源顺序解析出来的原文；已软删或找不到的不会伪造。 */
  sources: MemoryEvent[];
  /** 来源 id 存在，但当前可见记忆里找不到（例如原对话已归档）。 */
  missingIds: EventId[];
}

/** 印象 → 来源原文的面板链路解析。 */
export function resolveMemorySources(
  memory: Pick<MemoryEvent, 'supersedes'>,
  allMemories: readonly MemoryEvent[],
): MemorySourceChain {
  const byId = new Map(allMemories.map((item) => [item.id, item]));
  const sources: MemoryEvent[] = [];
  const missingIds: EventId[] = [];
  for (const id of memory.supersedes ?? []) {
    const source = byId.get(id);
    if (source === undefined) missingIds.push(id);
    else sources.push(source);
  }
  return { sources, missingIds };
}
export function conversationKeyOf(memory: MemoryEvent): string {
  return memory.conversationId ?? '';
}

/** 每条对话各有多少条记忆，用来在筛选器上标数量。 */
export function countByConversation(memories: readonly MemoryEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const key = conversationKeyOf(memory);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * 事件的对照视图：把同一轮（`sourceTurnIds` 的第一项）的记忆放回一张卡里。
 *
 * 为什么要按轮分组：一次抽取产出的就是「1 条客观 + N 条视角」（`buildMemoryEvents`），
 * 它们本来就是一件事的不同说法。平铺着看，客观条目和视角条目会隔着几十条互相找不着；
 * 摆在一起，「同一件事，各人记成什么样」才一眼可辨——这也是多角色扮演最有意思的地方。
 */
export interface MemoryTurnGroup {
  /** 分组键：一般是这一轮的 turnId；老数据没有时退回记忆自身的 id，保证不把无关条目并进来。 */
  key: string;
  turnId: string | null;
  /** 组里最新一条的时间，用来排序。 */
  at: string;
  objective: MemoryEvent | null;
  /** 只留最新一条客观条目之外的全部视角条目，按时间正序。 */
  observations: MemoryEvent[];
}

function groupKeyOf(memory: MemoryEvent): { key: string; turnId: string | null } {
  const turnId = memory.sourceTurnIds[0] ?? null;
  return turnId === null ? { key: `memory:${memory.id}`, turnId: null } : { key: `turn:${turnId}`, turnId };
}

export function groupMemoriesByTurn(memories: readonly MemoryEvent[]): MemoryTurnGroup[] {
  const groups = new Map<string, MemoryTurnGroup>();

  for (const memory of memories) {
    const { key, turnId } = groupKeyOf(memory);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, turnId, at: memory.createdAt, objective: null, observations: [] };
      groups.set(key, group);
    }
    if (memory.createdAt > group.at) group.at = memory.createdAt;
    if (memory.observerId === null) {
      // 同一轮理论上只有一条客观条目；真出现两条时留最新的，另一条落到视角列表里不会丢
      if (group.objective === null || memory.createdAt >= group.objective.createdAt) {
        if (group.objective !== null) group.observations.push(group.objective);
        group.objective = memory;
      } else {
        group.observations.push(memory);
      }
    } else {
      group.observations.push(memory);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      observations: group.observations.sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1)),
    }))
    .sort((left, right) => (left.at < right.at ? 1 : -1));
}
