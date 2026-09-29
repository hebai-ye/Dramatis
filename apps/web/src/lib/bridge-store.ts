import { createPlayerMessage, hasSpeech, type InstanceId, type Message } from '@dramatis/core';
import type { PendingBridgeTurn, WebBridgeState } from '../components/WebBridgePanel';

/**
 * 桥接进度不丢（顺序 25）。
 *
 * 网页版桥接要用户「复制出去、贴回来」——刷新一次就白贴一遍，那太欺负人了。
 * 所以把桥接状态存在 **sessionStorage**（同一个标签页内、刷新也在；关掉标签页就清），
 * 界面打开时自动接回上一步。
 *
 * 为什么不用 localStorage：它是「这台设备长期的事实」，而半截的桥接进度只属于这一次会话。
 * 关掉标签页还留着「等你贴回来」会让人困惑。
 */
const PREFIX = 'dramatis.bridge.v1:';

/**
 * 刷新或切场后，贴回内容绝不能套用到另一条场景线。
 * 首份待贴回时库里应当没有半轮；此后已落盘的角色必须恰好是名单前缀。
 */
export function readPendingBridgeProgress(
  pending: PendingBridgeTurn,
  current: Pick<PendingBridgeTurn, 'roomId' | 'conversationId' | 'sceneId'>,
  turnMessages: readonly Message[],
): { committed: number } | { error: string } {
  if (pending.roomId !== current.roomId || pending.conversationId !== current.conversationId) {
    return { error: '网页版桥接所属世界或对话已变化，请切回原对话后继续。' };
  }
  if (pending.sceneId !== current.sceneId) {
    return { error: '网页版桥接所属场景已变化，请切回原场景后继续。' };
  }
  if (
    !Array.isArray(pending.speakerIds) ||
    pending.speakerIds.length < 1 ||
    pending.speakerIds.length > 3 ||
    pending.nextIndex < 0 ||
    pending.nextIndex >= pending.speakerIds.length ||
    !Number.isInteger(pending.nextIndex) ||
    new Set(pending.speakerIds).size !== pending.speakerIds.length ||
    (pending.speakerPlans !== undefined &&
      (!Array.isArray(pending.speakerPlans) || pending.speakerPlans.length !== pending.speakerIds.length))
  ) {
    return { error: '网页版桥接进度已损坏，请重新发送这一句。' };
  }
  const alive = turnMessages.filter((item) => item.deletedAt === null && item.turnId === pending.turnId);
  const player = alive.filter((item) => item.role === 'player');
  const characters = alive.filter((item) => item.role === 'character');
  if (
    player.length !== (characters.length === 0 ? 0 : 1) ||
    characters.length > pending.speakerIds.length ||
    characters.some((item, index) => item.speakerInstanceId !== pending.speakerIds[index]) ||
    alive.some((item) => item.role !== 'player' && item.role !== 'character') ||
    alive.some(
      (item) =>
        item.roomId !== pending.roomId ||
        item.conversationId !== pending.conversationId ||
        item.sceneId !== pending.sceneId,
    )
  ) {
    return { error: '网页版桥接进度与已保存消息不一致，请检查原对话，勿将回复贴入新场景。' };
  }
  return { committed: characters.length };
}

export function validatePendingBridgeTurn(
  pending: PendingBridgeTurn,
  current: Pick<PendingBridgeTurn, 'roomId' | 'conversationId' | 'sceneId'>,
  turnMessages: readonly Message[],
): string | null {
  const progress = readPendingBridgeProgress(pending, current, turnMessages);
  if ('error' in progress) return progress.error;
  return progress.committed === pending.nextIndex
    ? null
    : '网页版桥接进度与已保存消息不一致，请检查原对话，勿将回复贴入新场景。';
}

/** 首份玩家与角色一次批量写入，避免桥接在“仅有玩家”的半轮停住。 */
export function bridgeReplyBatch(pending: PendingBridgeTurn | undefined, line: Message, playerName: string): Message[] {
  if (!pending || pending.nextIndex > 0) return [line];
  return [
    {
      ...createPlayerMessage({
        roomId: pending.roomId,
        conversationId: pending.conversationId,
        sceneId: pending.sceneId,
        turnId: pending.turnId,
        speakerName: playerName,
        content: pending.playerText,
        audience: [...line.audience],
      }),
      // 消息总序先看 createdAt 再看 localSeq；同批强制同一时刻，才能保证玩家排在角色前。
      createdAt: line.createdAt,
    },
    line,
  ];
}

export function validateBridgeReplyContent(pending: PendingBridgeTurn | undefined, content: string): string | null {
  const actionOnly = pending?.actionsOnly === true || pending?.speakerPlans?.[pending.nextIndex]?.mode === 'hold_back';
  return actionOnly && hasSpeech(content) ? '当前回合只许动作，贴回内容含有台词；请删去台词后再收下。' : null;
}

/**
 * 双存储恢复只相信已落盘的角色前缀；提示词可能比消息慢一拍，重新装配不会重复落消息。
 */
export async function recoverPendingBridgeState(input: {
  pending: PendingBridgeTurn;
  committed: number;
  history: Message[];
  speakers: readonly { id: InstanceId; displayName: string }[];
  preparePrompt: (pending: PendingBridgeTurn, history: Message[]) => Promise<string>;
  analysisPrompt: () => string;
}): Promise<WebBridgeState> {
  if (input.committed < input.pending.speakerIds.length) {
    const nextPending = { ...input.pending, nextIndex: input.committed };
    const speaker = input.speakers.find((item) => item.id === input.pending.speakerIds[input.committed]);
    if (!speaker) throw new Error('下一位角色已离开当前世界');
    const prompt = await input.preparePrompt(nextPending, input.history);
    return {
      stage: 'reply',
      turnId: input.pending.turnId,
      speakerInstanceId: speaker.id,
      speakerName: speaker.displayName,
      prompt,
      pendingTurn: nextPending,
    };
  }
  return { stage: 'analysis', turnId: input.pending.turnId, prompt: input.analysisPrompt() };
}

export function loadBridge<T>(slot: 'main' | 'admin'): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + slot);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function saveBridge(slot: 'main' | 'admin', value: unknown): void {
  try {
    if (value === null || value === undefined) sessionStorage.removeItem(PREFIX + slot);
    else sessionStorage.setItem(PREFIX + slot, JSON.stringify(value));
  } catch {
    // 隐私模式下写不进去：不影响这次会话的桥接，只是刷新后要重贴
  }
}
