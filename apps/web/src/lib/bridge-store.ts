import {
  applyTurnAnalysis,
  buildTurnAnalysisMessages,
  captureTurnAnalysis,
  createPlayerMessage,
  hasSpeech,
  type InstanceId,
  type Message,
  type Repository,
  renderPromptForWeb,
  StaleTurnAnalysisError,
  type TurnAnalysisScope,
} from '@dramatis/core';
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

interface BridgeAnalysisBinding {
  version: 1;
  accountKey: string;
  scope: TurnAnalysisScope;
  viewSceneId: TurnAnalysisScope['sceneId'];
  generation: string;
  revision: string;
}

interface BoundAnalysisBridge extends WebBridgeState {
  stage: 'analysis';
  analysisBinding: BridgeAnalysisBinding;
}

/** Persist the fingerprint only. The exact source snapshot stays inside the core capture/commit path. */
export async function prepareBridgeAnalysis(
  repository: Repository,
  scope: TurnAnalysisScope,
  accountKey: string,
  viewSceneId: TurnAnalysisScope['sceneId'] = scope.sceneId,
): Promise<BoundAnalysisBridge> {
  const context = await captureTurnAnalysis(repository, scope);
  if (!context) throw new StaleTurnAnalysisError('这一轮已被撤销或所属对话已变化，无法准备分析。');
  return {
    stage: 'analysis',
    turnId: scope.turnId,
    prompt: renderPromptForWeb(
      buildTurnAnalysisMessages({
        scene: context.scene,
        cast: context.participants,
        playerName: context.room.playerName,
        messages: context.messages,
      }),
    ),
    analysisBinding: {
      version: 1,
      accountKey,
      scope: { ...scope },
      viewSceneId,
      generation: context.source.generation,
      revision: context.source.revision,
    },
  };
}

/** Reassigning a message can target an older scene shown in the current conversation history. */
export async function prepareReassignedBridgeAnalysis(
  repository: Repository,
  current: Pick<TurnAnalysisScope, 'roomId' | 'conversationId' | 'sceneId'>,
  turnId: string,
  accountKey: string,
): Promise<BoundAnalysisBridge> {
  const messages = (await repository.listMessages(current.roomId)).filter((message) => message.turnId === turnId);
  const first = messages[0];
  if (
    !first ||
    first.conversationId !== current.conversationId ||
    messages.some((message) => message.conversationId !== first.conversationId || message.sceneId !== first.sceneId)
  )
    throw new StaleTurnAnalysisError('这一轮的原始对话或场景已变化，无法准备分析。');
  return prepareBridgeAnalysis(
    repository,
    { roomId: current.roomId, conversationId: first.conversationId, sceneId: first.sceneId, turnId },
    accountKey,
    current.sceneId,
  );
}

function readAnalysisBinding(bridge: unknown): BridgeAnalysisBinding {
  const stale = () => new StaleTurnAnalysisError('这份桥接分析缺少有效来源，请放弃旧进度并重新准备这一轮。');
  if (!bridge || typeof bridge !== 'object' || !('analysisBinding' in bridge)) throw stale();
  const value = bridge.analysisBinding;
  if (!value || typeof value !== 'object' || !('scope' in value)) throw stale();
  const binding = value as BridgeAnalysisBinding;
  const scope = binding.scope;
  if (
    !('stage' in bridge) ||
    bridge.stage !== 'analysis' ||
    !('turnId' in bridge) ||
    binding.version !== 1 ||
    typeof binding.accountKey !== 'string' ||
    binding.accountKey === '' ||
    typeof binding.generation !== 'string' ||
    binding.generation === '' ||
    typeof binding.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.revision) ||
    !scope ||
    typeof scope !== 'object' ||
    typeof scope.roomId !== 'string' ||
    scope.roomId === '' ||
    !(scope.conversationId === null || (typeof scope.conversationId === 'string' && scope.conversationId !== '')) ||
    !(scope.sceneId === null || (typeof scope.sceneId === 'string' && scope.sceneId !== '')) ||
    !(binding.viewSceneId === null || (typeof binding.viewSceneId === 'string' && binding.viewSceneId !== '')) ||
    typeof scope.turnId !== 'string' ||
    scope.turnId === '' ||
    bridge.turnId !== scope.turnId
  )
    throw stale();
  return binding;
}

export async function applyBridgeAnalysis(input: {
  repository: Repository;
  bridge: unknown;
  current: Pick<TurnAnalysisScope, 'roomId' | 'conversationId' | 'sceneId'>;
  accountKey: string;
  raw: string;
  isCurrent?: () => boolean;
}) {
  const binding = readAnalysisBinding(input.bridge);
  if (binding.accountKey !== input.accountKey) {
    throw new StaleTurnAnalysisError('这份桥接分析属于另一账户，请切回原账户后继续。');
  }
  const isCurrent = () =>
    binding.scope.roomId === input.current.roomId &&
    binding.scope.conversationId === input.current.conversationId &&
    binding.viewSceneId === input.current.sceneId &&
    (input.isCurrent?.() ?? true);
  if (!isCurrent()) throw new StaleTurnAnalysisError('桥接所属世界、对话或场景已变化，请切回原处后继续。');
  const context = await captureTurnAnalysis(input.repository, binding.scope);
  if (!context || context.source.generation !== binding.generation || context.source.revision !== binding.revision) {
    throw new StaleTurnAnalysisError('准备提示词之后这一轮已被修改或撤销，未写入旧分析；请重新准备这一轮。');
  }
  if (!isCurrent()) throw new StaleTurnAnalysisError();
  return applyTurnAnalysis({
    repository: input.repository,
    ...binding.scope,
    worldTime: context.scene?.worldTime ?? '',
    participants: context.participants,
    source: context.source,
    raw: input.raw,
  });
}

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
  analysisPrompt?: () => string;
  prepareAnalysis?: () => Promise<WebBridgeState>;
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
  if (input.prepareAnalysis) return input.prepareAnalysis();
  if (!input.analysisPrompt) throw new Error('缺少这一轮的分析准备器');
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

export function saveBridge(slot: 'main' | 'admin', value: unknown, strict = false): void {
  try {
    if (value === null || value === undefined) sessionStorage.removeItem(PREFIX + slot);
    else sessionStorage.setItem(PREFIX + slot, JSON.stringify(value));
  } catch {
    if (strict) throw new Error('桥接恢复状态未能保存，输入已保留；请检查本机存储后再试。');
    // 非发送准备路径仍保留既有会话降级。
  }
}
