import { extractJsonObject } from '../memory/extract.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { asRecord } from '../util/json.js';

/**
 * 生成前的意图（ROADMAP P1-6）。
 *
 * 这一步是**真的多一次调用**——预算从哪来见 `memory/turn-analysis.ts`：把记忆抽取与
 * 情绪推演合并成一次后台调用，腾出的那一格正好给它，总额仍是「每回合额外调用 ≤ 2」。
 *
 * 它做三件事：
 * 1. **决定谁开口**：规则调度器再准也读不懂「这句话其实是在刺秦娘」，导演调用能。
 * 2. **给出这一轮的打算**：把意图写进生成提示词，角色据此落笔（欲言又止、抢话、主动发起）。
 * 3. **把意图留在消息上**：用户能看到「他这一轮想做什么」，出戏时也好判断是谁的问题。
 *
 * 它给的是**建议而不是命令**：模型给的名字不在当前名单里就丢弃并退回规则调度，
 * 绝不让一个看不见的角色上台。
 */
export type IntentMode = 'reply' | 'cut_in' | 'hold_back' | 'initiate';

export interface IntentPlanEntry {
  name: string;
  intent: string;
  mode: IntentMode;
}

export interface IntentPlanInput {
  scene: Scene | null;
  cast: readonly CharacterInstance[];
  playerName: string;
  playerInput: string;
  /** 最近几条消息，按时间正序。不需要全量历史。 */
  recentMessages: readonly Message[];
  /** 最多让几个人开口，默认 1。 */
  maxSpeakers?: number;
}

const SYSTEM_PROMPT = [
  '你是这场多角色戏的导演。读刚发生的对话，判断这一轮谁最该开口、他此刻想做什么。',
  '只输出一个 JSON 对象，不要解释，不要写台词。',
].join('\n');

const MODE_GUIDE = [
  'mode 取四种之一：',
  '- reply：正常接话',
  '- cut_in：抢在别人之前插话，情绪上来了',
  '- hold_back：想说但没说出来（欲言又止），这一轮只做动作',
  '- initiate：没人问他，他主动开口或主动做点什么',
].join('\n');

export function buildIntentPlanMessages(input: IntentPlanInput): ChatMessage[] {
  const scene = input.scene;
  const maxSpeakers = Math.max(0, input.maxSpeakers ?? 1);

  const context = [
    `地点：${scene === null || scene.location.trim() === '' ? '未指定' : scene.location.trim()}`,
    `玩家扮演：${input.playerName}`,
    `在场角色：${input.cast.map((member) => member.displayName).join('、')}`,
  ].join('\n');

  const recent = input.recentMessages
    .map((message) => `${message.speakerName}：${message.content.replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        context,
        '',
        '刚发生的对话：',
        recent,
        '',
        `玩家刚说：${input.playerInput.trim() === '' ? '（什么也没说，只是做了个动作）' : input.playerInput.trim()}`,
        '',
        MODE_GUIDE,
        '',
        `最多让 ${String(maxSpeakers)} 个人开口；如果此刻没人该开口（冷场是合理的），speakers 给空数组。`,
        'speakers 的名字必须与「在场角色」里的完全一致。',
        '',
        '输出格式：',
        '{"speakers":[{"name":"角色名","intent":"他此刻想做什么，一句话","mode":"reply"}]}',
      ].join('\n'),
    },
  ];
}

const MODES: readonly IntentMode[] = ['reply', 'cut_in', 'hold_back', 'initiate'];

/** 宽松解析：认对象里的 speakers、认裸数组、认单个对象。 */
export function parseIntentPlan(raw: string): IntentPlanEntry[] {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    return [];
  }

  const record = asRecord(parsed);
  const list = Array.isArray(parsed)
    ? parsed
    : record !== null && Array.isArray(record.speakers)
      ? (record.speakers as unknown[])
      : record !== null && typeof record.name === 'string'
        ? [record]
        : [];

  const entries: IntentPlanEntry[] = [];
  for (const item of list) {
    const entry = asRecord(item);
    if (!entry) continue;

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') continue;

    const intent = typeof entry.intent === 'string' ? entry.intent.trim() : '';
    const rawMode = typeof entry.mode === 'string' ? (entry.mode.trim() as IntentMode) : 'reply';

    entries.push({ name, intent, mode: MODES.includes(rawMode) ? rawMode : 'reply' });
  }
  return entries;
}

export interface PlannedSpeaker {
  instance: CharacterInstance;
  intent: string;
  mode: IntentMode;
}

/**
 * 从计划里挑出真正可以开口的人。
 *
 * 三道闸，任何一道不过就丢：名字要能对上在场角色、presence 允许发言、
 * `hold_back` 不能真的开口（它只是「想说没说」，留给生成端去做动作）。
 */
export function pickPlannedSpeaker(
  plan: readonly IntentPlanEntry[],
  cast: readonly CharacterInstance[],
): PlannedSpeaker | null {
  for (const entry of plan) {
    if (entry.mode === 'hold_back') continue;
    const instance = cast.find((member) => member.presence === 'onstage' && member.displayName.trim() === entry.name);
    if (!instance) continue;
    return { instance, intent: entry.intent, mode: entry.mode };
  }
  return null;
}

/** 这一轮的意图是不是「只做动作」。 */
export function isHoldBack(mode: IntentMode): boolean {
  return mode === 'hold_back';
}
