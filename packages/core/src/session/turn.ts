import type { Card } from '../model/card.js';
import {
  type ConversationId,
  type InstanceId,
  messageId,
  newId,
  nowIso,
  type RoomId,
  type SceneId,
} from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message, MessageUsage } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import { type AssembledPrompt, type AssembleInput, assemblePrompt } from '../prompt/assemble.js';
import type { ModelParams, ModelProvider } from '../provider/openai-compatible.js';
import { splitIntent } from '../render/intent.js';
import { normalizeActionBreaks, normalizeGreetingBreaks, stripLeadingMarkers } from '../render/segments.js';

/**
 * 角色消息落库前的清洗。
 *
 * 模型会把历史里的 `【名字】` 转写标记抄进自己的回复，而且一旦抄进历史，下一轮就抄得
 * 更多（真实长跑里从 1 个长到 5 个）。只在显示层剥掉只能解决观感，**历史里仍然留着**，
 * 于是下一轮继续学。真正该在这一步清掉：存储里没有标记，提示词里自然也没有。
 */
function sanitizeCharacterContent(content: string, speakerName: string): { content: string; intent: string | null } {
  const withoutMarkers = stripLeadingMarkers(content);
  const name = speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutSelfPrefix =
    name === '' ? withoutMarkers : withoutMarkers.replace(new RegExp(`^\\s*${name}\\s*[:：]\\s*`), '');
  // 意图单独收走：留在正文里会进历史，被后续回合学成正文的一部分
  const { intent, body } = splitIntent(withoutSelfPrefix);
  return { content: normalizeActionBreaks(body), intent };
}

export type TurnEvent =
  | { type: 'prompt'; prompt: AssembledPrompt }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  /**
   * `usage` 是这一次调用的真实用量。服务商没返回时是 null——
   * 宁可显示「未知」，也不要把启发式估算当成账单（P3-7）。
   */
  | { type: 'done'; text: string; usage: MessageUsage | null };

export interface RunTurnOptions {
  params?: ModelParams;
  signal?: AbortSignal;
  /** 装配完成后立刻回调，便于 UI 展示本次用了多少 token、丢掉了什么。 */
  onPrompt?: (prompt: AssembledPrompt) => void;
}

export function createTurnId(): string {
  return newId();
}

export function createPlayerMessage(input: {
  roomId: RoomId;
  /** 归属的对话；主对话与副对话各自记录，不能混。 */
  conversationId?: ConversationId | null;
  sceneId: SceneId | null;
  turnId: string;
  speakerName: string;
  content: string;
  /** 在场角色实例；留空表示所有人可见。 */
  audience?: InstanceId[];
  /** 未落盘时留空，由仓储层的 appendMessages 分配（P2-6：本机序号）。 */
  localSeq?: number;
  /** 未落盘时留空，由仓储层的 appendMessages 填上本机设备号。 */
  deviceId?: string;
}): Message {
  const now = nowIso();
  return {
    id: messageId(newId()),
    roomId: input.roomId,
    conversationId: input.conversationId ?? null,
    sceneId: input.sceneId,
    turnId: input.turnId,
    localSeq: input.localSeq ?? 0,
    deviceId: input.deviceId ?? '',
    role: 'player',
    speakerInstanceId: null,
    speakerName: input.speakerName,
    audience: input.audience ?? [],
    content: input.content,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function createCharacterMessage(input: {
  roomId: RoomId;
  conversationId?: ConversationId | null;
  sceneId: SceneId | null;
  turnId: string;
  speakerInstanceId: InstanceId;
  speakerName: string;
  content: string;
  /** 在场角色实例；留空表示只有说话者可见。 */
  audience?: InstanceId[];
  /** 未落盘时留空，由仓储层的 appendMessages 分配（P2-6：本机序号）。 */
  localSeq?: number;
  /** 未落盘时留空，由仓储层的 appendMessages 填上本机设备号。 */
  deviceId?: string;
}): Message {
  const sanitized = sanitizeCharacterContent(input.content, input.speakerName);
  const now = nowIso();

  return {
    id: messageId(newId()),
    roomId: input.roomId,
    conversationId: input.conversationId ?? null,
    sceneId: input.sceneId,
    turnId: input.turnId,
    localSeq: input.localSeq ?? 0,
    deviceId: input.deviceId ?? '',
    role: 'character',
    speakerInstanceId: input.speakerInstanceId,
    speakerName: input.speakerName,
    audience: input.audience ?? [input.speakerInstanceId],
    content: sanitized.content,
    ...(sanitized.intent === null ? {} : { intent: sanitized.intent, intentSource: 'declared' as const }),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** 用角色卡的开场白生成第一条消息，进入房间时立即可见。 */
export const MAX_AUTOMATIC_GREETING_LENGTH = 380;
const GREETING_FIELD_LABELS = new Set([
  '地点',
  '时间',
  '场景',
  '天气',
  '背景',
  '环境',
  '旁白',
  '动作',
  '说明',
  '备注',
  'location',
  'time',
  'scene',
  'setting',
  'weather',
  'narration',
  'note',
]);

function normalizeGreetingLine(line: string): string[] {
  // ST 卡常用的明确动作标记；只改自动开场，不猜无标记独白。
  const action = /^\s*(?:\*([^*\n]+)\*|（([^（）\n]+)）)\s*(.*)$/.exec(line);
  if (action !== null) {
    const rest = action[3]?.trim() ?? '';
    const body = (action[1] ?? action[2] ?? '').trim();
    return rest === '' ? [`# ${body}`] : [`# ${body}`, rest];
  }
  // 对白后面的显式动作也要单独断行；要求对白以句末标点或引号收住，
  // 避免把普通的星号表达式当成动作。
  const trailing = /^(.*[。！？.!?」』”])\s*(?:\*([^*\n]+)\*|（([^（）\n]+)）)\s*$/.exec(line);
  if (trailing === null) return [line];
  return [(trailing[1] ?? '').trim(), `# ${(trailing[2] ?? trailing[3] ?? '').trim()}`];
}

/**
 * 自动开场只取一段完整的开头；原卡保留全文，用户仍可在角色卡里阅读或编辑。
 * 优先在句末、引号闭合处或换行截，避免把动作与对白从半句中间切断。
 */
export function prepareAutomaticGreeting(content: string, speakerName: string, playerName: string): string {
  const expanded = normalizeGreetingBreaks(content.trim()).replace(/{{\s*(char|user)\s*}}/gi, (_match, name: string) =>
    name.toLowerCase() === 'char' ? speakerName : playerName,
  );
  const ownLines: string[] = [];
  let collectingOwnLines = true;
  for (const line of expanded.split(/\r?\n/)) {
    // 显式他人标签之后的无标签续行也归他人；遇到自身标签才恢复收集。
    // 这样「他人先说 → 自己再说」不会整条丢失，也不会冒领他人的台词/动作。
    const label = /^\s*(?:【([^】\n]{1,32})】|([\p{L}\p{N}_·.' -]{1,32})[:：])\s*(.*)$/u.exec(line);
    const named = (label?.[1] ?? label?.[2] ?? '').trim();
    const markedSpeech = label !== null && (named === speakerName || !GREETING_FIELD_LABELS.has(named.toLowerCase()));
    if (label !== null && markedSpeech) {
      collectingOwnLines = named === speakerName;
      if (collectingOwnLines) ownLines.push(...normalizeGreetingLine(label[3] ?? ''));
    } else if (collectingOwnLines) {
      ownLines.push(...normalizeGreetingLine(line));
    }
  }
  // 明确的第三人称动作后紧跟引号对白时，补出 # 给模型一个正确的历史样板。
  // 普通无标记独白不猜，仍由既有的引号渲染规则处理。
  const actionThenSpeech = ownLines.map((line, index) => {
    const next =
      ownLines
        .slice(index + 1)
        .find((item) => item.trim() !== '')
        ?.trim() ?? '';
    const trimmed = line.trim();
    return /^(?:他|她|它)[推拉走看伸拿放坐站笑点皱回转掀抿端靠摸敲望掏接抖低起停摆]/.test(trimmed) &&
      /^[「『“"]/.test(next)
      ? `# ${trimmed}`
      : line;
  });
  const normalized = normalizeActionBreaks(actionThenSpeech.join('\n').trim());
  if (normalized.length <= MAX_AUTOMATIC_GREETING_LENGTH) return normalized;

  const upper = Math.min(normalized.length, MAX_AUTOMATIC_GREETING_LENGTH + 80);
  const lower = Math.floor(MAX_AUTOMATIC_GREETING_LENGTH / 2);
  const candidates: number[] = [];
  for (let index = lower; index < upper; index += 1) {
    if (/[。！？；」』”\n]/.test(normalized[index] ?? '')) candidates.push(index + 1);
  }
  const balanced = (text: string): boolean =>
    (text.match(/「/g)?.length ?? 0) === (text.match(/」/g)?.length ?? 0) &&
    (text.match(/『/g)?.length ?? 0) === (text.match(/』/g)?.length ?? 0) &&
    (text.match(/“/g)?.length ?? 0) === (text.match(/”/g)?.length ?? 0);
  const boundary = [...candidates].reverse().find((index) => balanced(normalized.slice(0, index)));
  return `${normalized.slice(0, boundary ?? MAX_AUTOMATIC_GREETING_LENGTH).trimEnd()}……`;
}

export function createGreetingMessage(input: {
  card: Card;
  instance: CharacterInstance;
  room: Room;
  scene: Scene | null;
  /** 选择第几条开场白，0 为主开场白。 */
  greetingIndex?: number;
  /** 开场时的在场角色；留空表示所有人都可见。 */
  audience?: InstanceId[];
}): Message | null {
  const greetings = [input.card.firstMessage, ...input.card.alternateGreetings];
  const greeting = greetings[input.greetingIndex ?? 0] ?? input.card.firstMessage;
  if (greeting.trim() === '') return null;
  const content = prepareAutomaticGreeting(greeting, input.instance.displayName, input.room.playerName);
  if (content === '') return null;

  return createCharacterMessage({
    roomId: input.room.id,
    conversationId: input.scene?.conversationId ?? null,
    sceneId: input.scene?.id ?? null,
    turnId: createTurnId(),
    speakerInstanceId: input.instance.id,
    speakerName: input.instance.displayName,
    // 把开场白里的行内动作断到行首：它是对话记录的第一条，
    // 也是模型随后模仿的样板，格式从一开始就该是对的
    content,
    audience: input.audience ?? [input.instance.id],
  });
}

/**
 * 旁白式动作（LAYOUT「切换场景后产生一条旁白式动作」）。
 *
 * 它没有气泡、不属于任何角色，记录的是「谁跟谁去了哪里」。`audience` 留空
 * 表示所有人都能看到——包括当时不在场的人：换场这件事本身是公开的。
 */
export function createNarrationMessage(input: {
  roomId: RoomId;
  conversationId: ConversationId | null;
  sceneId: SceneId | null;
  turnId: string;
  content: string;
}): Message {
  const now = nowIso();
  return {
    id: messageId(newId()),
    roomId: input.roomId,
    conversationId: input.conversationId,
    sceneId: input.sceneId,
    turnId: input.turnId,
    localSeq: 0,
    deviceId: '',
    role: 'narration',
    speakerInstanceId: null,
    speakerName: '旁白',
    audience: [],
    content: input.content,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/**
 * 跑一个回合：装配 prompt → 调用模型 → 流式产出。
 *
 * M0 是单人对话，发言调度（设计文档 §3）在 M1 接入；
 * 这里保留多发言者也能复用的流式事件结构。
 */
export async function* runTurn(
  input: AssembleInput,
  provider: ModelProvider,
  options: RunTurnOptions = {},
): AsyncIterable<TurnEvent> {
  const prompt = assemblePrompt(input);
  options.onPrompt?.(prompt);
  yield { type: 'prompt', prompt };

  let full = '';
  let done = false;
  let usage: MessageUsage | null = null;

  for await (const event of provider.chat(prompt.messages, options.params ?? {}, options.signal)) {
    switch (event.type) {
      case 'reasoning':
        yield { type: 'reasoning', text: event.text };
        break;
      case 'text':
        full += event.text;
        yield { type: 'text', text: event.text };
        break;
      case 'done':
        done = true;
        usage =
          event.usage === null
            ? null
            : { promptTokens: event.usage.promptTokens ?? 0, completionTokens: event.usage.completionTokens ?? 0 };
        yield { type: 'done', text: full, usage };
        break;
    }
  }

  if (!done) {
    yield { type: 'done', text: full, usage };
  }
}
