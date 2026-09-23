import { tokenizeQuery } from '../memory/recall.js';
import { coveredBySummary } from '../memory/summary.js';
import type { HistoryPolicy } from '../model/conversation.js';
import type { InstanceId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';

/**
 * 按视角裁剪历史（ROADMAP P0-5）。
 *
 * 规则只有两条：
 * - `audience` 为空的旁白与系统消息，所有人都看得到
 * - 否则只有当时的在场者看得到，自己说过的话当然也算
 *
 * 这条规则让「角色离场期间发生的事他不知道」变成结构上的必然，
 * 而不是靠 prompt 里写一句「你不记得之前的事」来祈求模型配合。
 * 完全不消耗额外模型调用。
 */
export function isVisibleTo(message: Message, instanceId: InstanceId): boolean {
  if (message.audience.length === 0) return true;
  if (message.audience.includes(instanceId)) return true;
  return message.speakerInstanceId === instanceId;
}

export function selectHistoryFor(history: readonly Message[], instanceId: InstanceId): Message[] {
  return history.filter((message) => isVisibleTo(message, instanceId));
}

export interface HistoryPartition {
  /** 逐条带进提示词的原文（保持时间顺序）。 */
  kept: Message[];
  /** 收起的原文：已被场记覆盖、又在近窗之外；由场记 / 章节 / 记忆代表，提到时可取回。 */
  collapsed: Message[];
}

/**
 * 按「场记覆盖」把历史分成带与不带（顺序 58）。
 *
 * 用户拍板「对话质量优先于省 token」，所以这里**不是**固定条数砍历史：
 *
 * 1. 未被任何场记覆盖的原文：全带（场记每 8 轮 / 2400 token 才滚一次，最近这段本来就在）；
 * 2. 已被覆盖、但在近窗内的：全带——近窗是「就算场记已覆盖也保留原文」的下限；
 * 3. 已被覆盖、且在近窗之外的：收起。它们不是丢了：场记、章节、记忆代表它们，
 *    玩家提到关键词时 `expandHistoryOnMention` 再把原文取回来。
 *
 * `visible` 是这个角色看得见的历史（已按视角裁过），近窗按它计数；`messages` 要传
 * 这条对话的**全部**消息，场记的消息 id 游标要在全量里才找得到。
 */
export function partitionHistory(
  visible: readonly Message[],
  options: {
    messages: readonly Message[];
    scenes: readonly Scene[];
    policy: HistoryPolicy;
  },
): HistoryPartition {
  if (options.policy.mode === 'full') return { kept: [...visible], collapsed: [] };

  const covered = new Set<string>();
  for (const scene of options.scenes) {
    const inScene = options.messages.filter((message) => message.sceneId === scene.id);
    for (const id of coveredBySummary(scene, inScene)) covered.add(id);
  }

  const nearStart = Math.max(0, visible.length - Math.max(0, options.policy.nearWindow));
  const kept: Message[] = [];
  const collapsed: Message[] = [];
  visible.forEach((message, index) => {
    if (index >= nearStart || !covered.has(message.id)) {
      kept.push(message);
    } else {
      collapsed.push(message);
    }
  });
  return { kept, collapsed };
}

/** 一轮最多从收起的原文里取回几条。 */
export const DEFAULT_HISTORY_RECALL_LIMIT = 3;

/**
 * 玩家这一句提到了收起段里的什么，就把那几条原文取回来（顺序 58，复用 57 的「提到」口径）。
 *
 * 只认**玩家这一句**的关键词，不看最近几轮（否则台词里的地名会把整段翻回来）。
 * 命中多的优先，其次是更近的；返回时按时间顺序排好。一个词都没命中就什么都不取——
 * 「问过去」而没有具体所指时，场记、章节与印象来源已经在回答它。
 */
export function expandHistoryOnMention(
  collapsed: readonly Message[],
  mentionText: string,
  limit: number = DEFAULT_HISTORY_RECALL_LIMIT,
): Message[] {
  const terms = tokenizeQuery(mentionText);
  if (terms.length === 0 || limit <= 0) return [];

  const scored = collapsed
    .map((message, index) => {
      const haystack = message.content.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (haystack.includes(term)) hits += 1;
      }
      return { message, index, hits };
    })
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits || right.index - left.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index);

  return scored.map((item) => item.message);
}
