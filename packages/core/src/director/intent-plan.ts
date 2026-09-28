import { extractJsonObject } from '../memory/extract.js';
import type { InstanceId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { asRecord } from '../util/json.js';

/** 导演只建议当轮参与者；名单与 presence、至少一人均由纯选择器复核。 */
export type IntentMode = 'reply' | 'cut_in' | 'hold_back' | 'initiate';

export interface IntentPlanEntry {
  key?: string;
  name: string;
  intent: string;
  mode: IntentMode;
}

export interface IntentPlanInput {
  scene: Scene | null;
  cast: readonly CharacterInstance[];
  playerName: string;
  playerInput: string;
  recentMessages: readonly Message[];
  /** 旧调用点升级期间缺省为空；发送路径必须传真实上一条意图。 */
  lastIntentByInstance?: ReadonlyMap<InstanceId, string>;
  playerActionOnly?: boolean;
  actionsOnly?: boolean;
  maxSpeakers?: number;
}

const SYSTEM_PROMPT = [
  '你是多角色互动故事的一轮发言导演。你的工作是在当前场景中选出这一轮真正参与回应的角色，并按戏剧发生顺序安排他们；你不写台词，也不平均分配发言机会。',
  '',
  '只可选输入名单中的角色。角色的 presence 与场景名单都已由程序检查，但你仍必须照抄名单里的临时编号和显示名。玩家在句首以称呼叫到的人，或用 @显示名 直接叫到的人，必须在本轮参与；句中作为事件人物被提到，不等于被叫到。玩家问全场时，挑最有理由回应的一至数人，不必让全场轮流说话。玩家只做动作而没有台词时，判断谁会对动作作出有意义的反应。不要为了凑满人数而选人。',
  '',
  'mode 只能是 reply、cut_in、hold_back、initiate。reply 是正常接话；cut_in 是抢话；hold_back 是只用动作或神态回应、不说台词；initiate 是主动开启新的话头。hold_back 也占一个回应名额，因为程序仍会为他生成一条动作消息。输入要求只许动作时，所有入选者都必须用 hold_back。',
  '',
  'speakers 至少给一项、最多给输入指定的上限；每个角色最多出现一次。按建议的剧情顺序排列，同等条件下把 cut_in 排在普通接话之前。每项 intent 用一句中文写此刻想做什么，不写台词、不写其他角色的私有想法。只输出符合格式的 JSON 对象，不要代码围栏、注释或解释。即使你输出空项或错误项，程序也会独立执行保底选择。',
].join('\n');

export function buildIntentPlanMessages(input: IntentPlanInput): ChatMessage[] {
  const maxSpeakers = Math.min(3, Math.max(1, Math.floor(input.maxSpeakers ?? 1)));
  const location = input.scene?.location.trim() || '未指定';
  const cast =
    input.cast
      .map(
        (member, index) =>
          `C${String(index + 1)}｜${member.displayName}｜上一条意图：${input.lastIntentByInstance?.get(member.id) || '无'}｜激动程度：${member.affect.arousal.toFixed(2)}`,
      )
      .join('\n') || '无';
  const recent =
    input.recentMessages
      .slice(-8)
      .map((message) => `${message.speakerName}：${message.content.replace(/\s*\n\s*/g, ' ')}`)
      .join('\n') || '无';
  const user = [
    `地点：${location}`,
    `玩家扮演：${input.playerName}`,
    `本轮最多参与人数：${String(maxSpeakers)}`,
    `本轮回复形式：${input.actionsOnly === true ? '只许动作' : '允许台词与动作'}`,
    `玩家这次是否只有动作：${input.playerActionOnly === true ? '是' : '否'}`,
    '',
    '当前场景可发言名单（临时编号、显示名、上一条意图、情绪激动程度）：',
    cast,
    '',
    '最近 8 条对话，按发生顺序：',
    recent,
    '',
    '玩家本次输入：',
    input.playerInput.trim() || '（无台词，仅有动作）',
    '',
    '请选出本轮真正参与回应的角色。直接称呼的人必须在名单中；句中被提到的人无需因此发言。没有合适的第二人就只选一人。输出必须严格采用以下 JSON 形状，key 和 name 必须与上方同一人对应：',
    '{"speakers":[{"key":"C1","name":"秦娘","intent":"想确认玩家刚才所指的那件事","mode":"reply"}]}',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

const MODES: readonly IntentMode[] = ['reply', 'cut_in', 'hold_back', 'initiate'];

/** 宽松解析兼容旧记录：裸数组、代码围栏和没有临时编号的姓名条目仍可读取。 */
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
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const intent = typeof entry.intent === 'string' ? entry.intent.trim() : '';
    const rawMode = typeof entry.mode === 'string' ? (entry.mode.trim() as IntentMode) : 'reply';
    entries.push({
      ...(key === '' ? {} : { key }),
      name,
      intent,
      mode: MODES.includes(rawMode) ? rawMode : 'reply',
    });
  }
  return entries;
}

export interface PlannedSpeaker {
  instance: CharacterInstance;
  intent: string;
  mode: IntentMode;
}

export interface PlannedSpeakerPick {
  speakers: PlannedSpeaker[];
  rejectedEntries: number;
}

/** 编号和姓名必须指向同一位在场者；hold_back 仍需生成一条动作消息。 */
export function pickPlannedSpeakers(
  plan: readonly IntentPlanEntry[],
  eligibleCast: readonly CharacterInstance[],
  maxSpeakers: 1 | 2 | 3,
): PlannedSpeakerPick {
  const speakers: PlannedSpeaker[] = [];
  const seen = new Set<InstanceId>();
  let rejectedEntries = 0;
  for (const entry of plan) {
    const matches = eligibleCast.filter(
      (member) =>
        member.presence === 'onstage' && member.deletedAt === null && member.displayName.trim() === entry.name,
    );
    const instance = matches.length === 1 ? matches[0] : undefined;
    const expectedKey = instance === undefined ? '' : `C${String(eligibleCast.indexOf(instance) + 1)}`;
    if (!instance || (entry.key !== undefined && entry.key !== expectedKey) || seen.has(instance.id)) {
      rejectedEntries += 1;
      continue;
    }
    seen.add(instance.id);
    speakers.push({ instance, intent: entry.intent, mode: entry.mode });
  }
  // 先让抢话者前移，再截人数；否则导演超额时末尾的抢话者会被提前丢掉。
  const ordered = speakers.sort((a, b) => Number(b.mode === 'cut_in') - Number(a.mode === 'cut_in'));
  return { speakers: ordered.slice(0, maxSpeakers), rejectedEntries };
}

/** 兼容旧单人调用；新发送路径必须使用 pickPlannedSpeakers 与 selectTurnSpeakers。 */
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

export function isHoldBack(mode: IntentMode): boolean {
  return mode === 'hold_back';
}
