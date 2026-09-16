import type { WorldBookMatch } from '../compat/sillytavern/worldbook.js';
import type { Card } from '../model/card.js';
import type { ConversationModes } from '../model/conversation.js';
import { type InstanceId, PLAYER } from '../model/ids.js';
import type { Affect, CharacterInstance, TraitAxis } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import { ACTION_FORMAT_RULE } from '../render/segments.js';
import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import { applyBudget } from './budget.js';
import { selectHistoryFor } from './history.js';
import type { BudgetReport, ChatMessage, PromptBlock } from './types.js';

/**
 * 召回记忆的展示形态。
 *
 * M0 只需要渲染；真正的抽取与排序在 M2 实现。
 */
export interface PromptMemory {
  id: string;
  summary: string;
  /** 该视角下的观感、误解与情绪反应。 */
  perception?: string;
  /** 召回分数 0~1。 */
  score: number;
  worldTime?: string;
  observerName?: string;
}

export interface AssembleInput {
  card: Card;
  instance: CharacterInstance;
  room: Room;
  scene: Scene | null;
  history: Message[];
  playerInput: string;
  worldBookMatches?: WorldBookMatch[];
  memories?: PromptMemory[];
  /** 场景内的角色，用于让模型知道还有谁在场（P0-6）。 */
  cast?: readonly CharacterInstance[];
  /** 会话级对话模式：静默、是否必须等主角先开口（LAYOUT「输入区 · 加号」）。 */
  modes?: ConversationModes;
  budget: {
    /** 模型的上下文窗口。 */
    maxTokens: number;
    /** 为回复预留的空间。 */
    reserveForReply: number;
  };
  options?: AssembleOptions;
}

export interface AssembleOptions {
  /** 最多带入多少条历史消息，默认 40。 */
  historyLimit?: number;
  counter?: TokenCounter;
  /** 覆盖默认系统提示。 */
  systemPrompt?: string;
}

export interface AssembledPrompt {
  blocks: PromptBlock[];
  messages: ChatMessage[];
  report: BudgetReport;
  tokenEstimate: number;
  /** 本次装配按视角裁剪了多少历史，供检查器展示（P0-5）。 */
  historyStats: { total: number; visible: number };
}

/** 越大越不可丢弃。 */
const PRIORITY = {
  system: 1000,
  player: 1000,
  instruction: 900,
  persona: 700,
  scene: 600,
  worldbook: 500,
  relationship: 400,
  history: 300,
} as const;

/** 预算被榨干时仍要留下的最小空间，保证 prompt 不会退化成空。 */
const MIN_PROMPT_TOKENS = 256;

const TRAIT_LABELS: Record<TraitAxis, readonly [string, string]> = {
  extroversion: ['外向主动', '内向寡言'],
  aggression: ['强势好斗', '温和退让'],
  empathy: ['共情敏锐', '疏离冷淡'],
  playfulness: ['爱开玩笑', '正经严肃'],
  caution: ['谨慎多疑', '大胆冒进'],
};

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}……`;
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim() !== '') return value;
  }
  return '';
}

function formatScore(value: number): string {
  const clamped = Math.max(-1, Math.min(1, value));
  const sign = clamped >= 0 ? '+' : '-';
  return `${sign}${Math.abs(clamped).toFixed(2)}`;
}

/** 把特质轴翻译成人话，只保留偏离中性的部分，避免噪声。 */
function describeTraits(traits: CharacterInstance['traits']): string {
  const parts: string[] = [];
  for (const axis of Object.keys(TRAIT_LABELS) as TraitAxis[]) {
    const value = traits[axis];
    if (value >= 0.25) {
      parts.push(TRAIT_LABELS[axis][0]);
    } else if (value <= -0.25) {
      parts.push(TRAIT_LABELS[axis][1]);
    }
  }
  return parts.join('、');
}

/** 快变量接近中性时不写入 prompt，省下的 token 留给记忆。 */
function describeAffect(affect: Affect): string | null {
  const notable = Math.abs(affect.valence) >= 0.15 || affect.arousal >= 0.4;
  if (!notable) return null;

  const mood =
    affect.valence >= 0.5
      ? '心情很好'
      : affect.valence >= 0.15
        ? '心情不错'
        : affect.valence <= -0.5
          ? '情绪低落'
          : affect.valence <= -0.15
            ? '有些不快'
            : '情绪平稳';

  const energy = affect.arousal >= 0.7 ? '情绪激动' : affect.arousal >= 0.4 ? '略有起伏' : '比较平静';
  return `${mood}，${energy}`;
}

function defaultSystemPrompt(card: Card, playerName: string): string {
  return [
    `你正在参与的是一场多角色扮演对话。玩家扮演的是「${playerName}」。`,
    `你只扮演「${card.name}」这一个角色，始终以其身份说话与行动。`,
    '不要替玩家做决定，不要描写玩家的心理活动，不要以旁白解释角色动机。',
    '用第一人称和动作描写写作，像小说里的对话那样自然。',
    ACTION_FORMAT_RULE,
  ].join('\n');
}

/**
 * 会话级模式的指令（LAYOUT 的「对话模式」）。
 *
 * 模式只是开关，模型不知道就等于没开——所以它必须落到 prompt 里，
 * 和入场策略一样，是「界面上的设置真的生效」的那一步。
 */
function describeModes(modes: ConversationModes | undefined): string[] {
  if (!modes) return [];
  const lines: string[] = [];
  if (modes.playerFirst) {
    lines.push('本轮模式：只有玩家先开口，你才可以接话。玩家没说话就保持沉默，用动作推进即可。');
  }
  if (modes.silent) {
    lines.push('本轮模式（静默）：不要说话，只写动作与神态（每条用 `#` 起段），也不要替别人发言。');
  }
  return lines;
}

function buildPersonaBlock(card: Card, instance: CharacterInstance): PromptBlock {
  const parts = [`你现在扮演的是「${instance.displayName}」。`];
  if (card.description.trim() !== '') parts.push(card.description.trim());
  if (card.personality.trim() !== '') parts.push(`性格：${card.personality.trim()}`);

  const traits = describeTraits(instance.traits);
  if (traits !== '') parts.push(`性格倾向：${traits}`);

  const examples = truncate(card.exampleMessages, 1200);
  if (examples !== '') parts.push(`对话风格示例：\n${examples}`);

  const compressed = [
    `你现在扮演的是「${instance.displayName}」。`,
    truncate(firstNonEmpty(card.description, card.personality), 160),
  ]
    .filter((part) => part.trim() !== '')
    .join('\n');

  return {
    id: `persona:${instance.id}`,
    kind: 'persona',
    label: `角色：${instance.displayName}`,
    content: parts.join('\n\n'),
    priority: PRIORITY.persona,
    droppable: true,
    compressed,
  };
}

function buildRelationshipBlock(instance: CharacterInstance): PromptBlock | null {
  const lines: string[] = [];

  const mood = describeAffect(instance.affect);
  if (mood !== null) lines.push(`当前情绪：${mood}`);

  const towardPlayer = instance.relationships.find((relationship) => relationship.target === PLAYER);
  if (towardPlayer) {
    lines.push(
      `对玩家的态度：信任 ${formatScore(towardPlayer.trust)}、好感 ${formatScore(towardPlayer.affinity)}` +
        `、畏惧 ${formatScore(towardPlayer.fear)}、敬重 ${formatScore(towardPlayer.respect)}` +
        `、紧张感 ${formatScore(towardPlayer.tension)}`,
    );
  }

  if (lines.length === 0) return null;

  return {
    id: `relationship:${instance.id}`,
    kind: 'relationship',
    label: '关系与情绪状态',
    content: lines.join('\n'),
    priority: PRIORITY.relationship,
    droppable: true,
    compressed: lines.join('；'),
  };
}

/**
 * 场景块。
 *
 * 入场策略会被翻译成给模型的明确指令——这是「锁场」从 UI 落到
 * 实际行为的关键，光有开关而模型不知道，等于没有。
 */
function describePresence(presence: CharacterInstance['presence']): string {
  switch (presence) {
    case 'onstage':
      return '在场';
    case 'muted':
      return '在场但一直没说话';
    case 'offscreen':
      return '不在这场，人在别处';
    default:
      return '已离场';
  }
}

function buildSceneBlock(
  scene: Scene | null,
  cast: readonly CharacterInstance[],
  speakerId: InstanceId,
): PromptBlock | null {
  if (!scene) return null;

  const lines = [`地点：${scene.location.trim() === '' ? '未指定' : scene.location.trim()}`];
  if (scene.worldTime.trim() !== '') lines.push(`时间：${scene.worldTime.trim()}`);

  switch (scene.castPolicy) {
    case 'locked':
      lines.push('导演指令：本场景名单已锁定。不得引入任何新角色，也不要提及未在场角色进入场景。');
      break;
    case 'invite_only':
      lines.push('导演指令：只有玩家明确召唤的角色才能进入场景，不要自行引入其他角色。');
      break;
    case 'triggered':
      lines.push('导演指令：只有设定被触发的角色才能进入场景。');
      break;
    default:
      // open 策略不追加额外约束，角色可以自行入场
      break;
  }

  if (scene.summary.trim() !== '') lines.push(`场景摘要：${scene.summary.trim()}`);

  if (cast.length > 0) {
    const roster = cast
      .map(
        (member) =>
          `${member.displayName}（${member.id === speakerId ? '正在与你对话' : describePresence(member.presence)}）`,
      )
      .join('、');
    lines.push(`在场角色：${roster}`);
  }

  return {
    id: `scene:${scene.id}`,
    kind: 'scene',
    label: '当前场景',
    content: lines.join('\n'),
    priority: PRIORITY.scene,
    droppable: false,
  };
}

function buildWorldBookBlock(matches: WorldBookMatch[]): PromptBlock | null {
  if (matches.length === 0) return null;

  const body = matches
    .map(
      (match) =>
        `【${match.entry.title.trim() === '' ? '未命名条目' : match.entry.title.trim()}】\n${match.entry.content.trim()}`,
    )
    .join('\n\n');

  return {
    id: 'worldbook',
    kind: 'worldbook',
    label: '世界设定',
    content: body,
    priority: PRIORITY.worldbook,
    droppable: true,
  };
}

/**
 * 记忆块。
 *
 * M0 每条记忆独立成块，这样预算守卫可以按分数逐条丢弃；
 * 渲染时会合并到同一个「相关记忆」小节下。
 */
function buildMemoryBlocks(memories: PromptMemory[]): PromptBlock[] {
  return memories.map((memory) => {
    const parts: string[] = [];
    if (memory.worldTime !== undefined && memory.worldTime.trim() !== '') parts.push(`（${memory.worldTime.trim()}）`);
    parts.push(memory.summary.trim());
    if (memory.perception !== undefined && memory.perception.trim() !== '') {
      parts.push(`他当时的感觉：${memory.perception.trim()}`);
    }

    return {
      id: `memory:${memory.id}`,
      kind: 'memory',
      label: '相关记忆',
      content: parts.join(' '),
      priority: PRIORITY.history + Math.round(memory.score * 200),
      droppable: true,
      score: memory.score,
    };
  });
}

/**
 * 历史消息块。
 *
 * `prefixSpeaker` 在多角色场景下必开：对话消息的 assistant 角色分不出是谁说的，
 * 不标名字模型就会把几个角色混成一个声音。
 */
function buildHistoryBlocks(history: Message[], limit: number, prefixSpeaker: boolean): PromptBlock[] {
  const recent = history.slice(-limit);
  return recent.map((message, index) => ({
    id: `history:${message.id}`,
    kind: 'history',
    label: message.speakerName,
    content:
      prefixSpeaker && message.role !== 'player' ? `${message.speakerName}：${message.content}` : message.content,
    priority: PRIORITY.history,
    droppable: true,
    sequence: index,
    message: {
      role: message.role === 'player' ? 'user' : 'assistant',
      speakerName: message.speakerName,
    },
  }));
}

/** 把系统侧的所有块渲染成一条 system 消息，记忆合并到同一小节。 */
function renderSystemBlocks(blocks: PromptBlock[]): string {
  const sections: string[] = [];
  let memoryGroup: string[] = [];

  const flushMemory = (): void => {
    if (memoryGroup.length === 0) return;
    sections.push(`### 相关记忆\n${memoryGroup.map((item) => `- ${item}`).join('\n')}`);
    memoryGroup = [];
  };

  for (const block of blocks) {
    if (block.kind === 'memory') {
      memoryGroup.push(block.content.replace(/\s*\n\s*/g, ' '));
      continue;
    }
    flushMemory();
    sections.push(block.label.trim() === '' ? block.content : `### ${block.label}\n${block.content}`);
  }

  flushMemory();
  return sections.join('\n\n');
}

export function toChatMessages(blocks: PromptBlock[]): ChatMessage[] {
  const systemBlocks = blocks.filter((block) => block.kind !== 'history' && block.kind !== 'player');
  const historyBlocks = blocks.filter((block) => block.kind === 'history' && block.message !== undefined);
  const playerBlock = blocks.find((block) => block.kind === 'player');

  const messages: ChatMessage[] = [];

  const system = renderSystemBlocks(systemBlocks).trim();
  if (system !== '') messages.push({ role: 'system', content: system });

  for (const block of historyBlocks) {
    const ref = block.message;
    if (ref === undefined) continue;
    messages.push({ role: ref.role, content: block.content });
  }

  if (playerBlock) messages.push({ role: 'user', content: playerBlock.content });

  return messages;
}

/**
 * 按设计文档 §6 的顺序装配 prompt，并交给预算守卫降级。
 */
export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const options = input.options ?? {};
  const counter = options.counter ?? heuristicTokenCounter;
  const playerName = input.room.playerName.trim() === '' ? '玩家' : input.room.playerName.trim();

  const systemContent =
    options.systemPrompt ??
    (input.card.systemPrompt.trim() !== '' ? input.card.systemPrompt : defaultSystemPrompt(input.card, playerName));

  const blocks: PromptBlock[] = [
    {
      id: 'system',
      kind: 'system',
      label: '基本规则',
      content: systemContent,
      priority: PRIORITY.system,
      droppable: false,
    },
  ];

  const worldBookBlock = buildWorldBookBlock(input.worldBookMatches ?? []);
  if (worldBookBlock) blocks.push(worldBookBlock);

  blocks.push(buildPersonaBlock(input.card, input.instance));

  const relationshipBlock = buildRelationshipBlock(input.instance);
  if (relationshipBlock) blocks.push(relationshipBlock);

  blocks.push(...buildMemoryBlocks(input.memories ?? []));

  const cast = input.cast ?? [];
  const sceneBlock = buildSceneBlock(input.scene, cast, input.instance.id);
  if (sceneBlock) blocks.push(sceneBlock);

  // 多人同场时才需要标名字，单人场景标了只是浪费 token
  const onstageCount = cast.filter((member) => member.presence === 'onstage').length;
  const prefixSpeaker = onstageCount > 1;

  // 按视角裁剪：角色看不到自己不在场时发生的事（P0-5）
  const visibleHistory = selectHistoryFor(input.history, input.instance.id);
  blocks.push(...buildHistoryBlocks(visibleHistory, options.historyLimit ?? 40, prefixSpeaker));

  // 让发言者知道场上还有谁，否则多角色场景里模型会替别人说话
  const otherSpeakers = cast
    .filter((member) => member.id !== input.instance.id && member.presence === 'onstage')
    .map((member) => member.displayName);
  const othersClause = otherSpeakers.length === 0 ? '' : `场景中还有 ${otherSpeakers.join('、')}，不要替他们发言。`;

  blocks.push({
    id: 'instruction',
    kind: 'instruction',
    label: '本轮指令',
    content:
      `现在轮到你发言。请以「${input.instance.displayName}」的身份回应，保持角色不跳出。` +
      othersClause +
      '不要代替玩家行动，也不要描写玩家的内心想法。' +
      describeModes(input.modes)
        .map((line) => `\n${line}`)
        .join(''),
    priority: PRIORITY.instruction,
    droppable: false,
  });

  // 同一回合里第二名角色发言时 playerInput 为空——玩家的话已经在历史里了，
  // 再插一次会把同一句台词说两遍。
  if (input.playerInput.trim() !== '') {
    blocks.push({
      id: 'player',
      kind: 'player',
      label: playerName,
      content: input.playerInput,
      priority: PRIORITY.player,
      droppable: false,
    });
  }

  const available = Math.max(MIN_PROMPT_TOKENS, input.budget.maxTokens - input.budget.reserveForReply);
  const { blocks: kept, report } = applyBudget(blocks, { maxTokens: available, counter });

  return {
    blocks: kept,
    messages: toChatMessages(kept),
    report,
    tokenEstimate: report.usedTokens,
    historyStats: { total: input.history.length, visible: visibleHistory.length },
  };
}
