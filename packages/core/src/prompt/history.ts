import type { InstanceId } from '../model/ids.js';
import type { Message } from '../model/message.js';

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
