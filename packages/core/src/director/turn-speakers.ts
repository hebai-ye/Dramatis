import type { InstanceId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { IntentMode, IntentPlanEntry } from './intent-plan.js';
import type { ScheduleResult } from './scheduler.js';

export type TurnSpeakerSource = 'addressed' | 'planned' | 'rule';

export interface SelectedTurnSpeaker {
  instance: CharacterInstance;
  intent: string | null;
  mode: IntentMode;
  source: TurnSpeakerSource;
}

export type TurnSpeakerSelection =
  | { kind: 'ready'; speakers: SelectedTurnSpeaker[]; rejectedPlanEntries: number }
  | { kind: 'no-eligible-speaker'; speakers: []; rejectedPlanEntries: number }
  | { kind: 'too-many-addressed'; speakers: []; addressed: InstanceId[]; rejectedPlanEntries: number };

function uniqueNamedCast(cast: readonly CharacterInstance[]): CharacterInstance[] {
  return cast.filter(
    (instance) =>
      instance.presence === 'onstage' &&
      instance.deletedAt === null &&
      instance.displayName.trim() !== '' &&
      cast.filter((other) => other.displayName.trim() === instance.displayName.trim()).length === 1,
  );
}

function escapeRegExp(value: string): string {
  return [...value].map((char) => ('\\^$.*+?()[]{}|'.includes(char) ? `\\${char}` : char)).join('');
}

/**
 * 只有明确称呼才拥有强制发言权。句中叙述里出现姓名只是提及；
 * 曾因此把句首被问的 A 的动作写到句中 B 名下，所以这里故意不沿用宽松 mentions。
 */
export function directAddressees(playerInput: string, eligibleCast: readonly CharacterInstance[]): InstanceId[] {
  const unique = uniqueNamedCast(eligibleCast).sort(
    (a, b) => b.displayName.trim().length - a.displayName.trim().length,
  );
  const hits: Array<{ id: InstanceId; index: number }> = [];
  const leading = playerInput.trimStart();
  const leadingOffset = playerInput.length - leading.length;
  let offset = 0;
  while (offset < leading.length) {
    const member = unique.find((item) => leading.startsWith(item.displayName.trim(), offset));
    if (!member) break;
    const end = offset + member.displayName.trim().length;
    const next = leading[end] ?? '';
    if (next !== '' && !/^[\s，,、：:！!？?]$/.test(next)) break;
    hits.push({ id: member.id, index: leadingOffset + offset });
    if (next !== '、') break;
    offset = end + 1;
  }
  for (const member of unique) {
    const name = member.displayName.trim();
    const pattern = new RegExp(`@${escapeRegExp(name)}(?=$|[\\s，,。.!！?？、:：;；])`, 'gu');
    for (const match of playerInput.matchAll(pattern)) {
      hits.push({ id: member.id, index: match.index ?? 0 });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<InstanceId>();
  return hits
    .filter((hit) => {
      if (seen.has(hit.id)) return false;
      seen.add(hit.id);
      return true;
    })
    .map((hit) => hit.id);
}

/** 导演决定参与者，规则只在导演不可用时保底；上限永远不是需要凑满的配额。 */
export function selectTurnSpeakers(input: {
  playerInput: string;
  eligibleCast: readonly CharacterInstance[];
  schedule: ScheduleResult;
  plan: readonly IntentPlanEntry[] | null;
  maxSpeakers: 1 | 2 | 3;
  actionsOnly: boolean;
}): TurnSpeakerSelection {
  const eligible = input.eligibleCast.filter(
    (instance) => instance.presence === 'onstage' && instance.deletedAt === null,
  );
  if (eligible.length === 0) {
    return { kind: 'no-eligible-speaker', speakers: [], rejectedPlanEntries: 0 };
  }
  const addressed = directAddressees(input.playerInput, eligible);
  if (addressed.length > input.maxSpeakers) {
    return { kind: 'too-many-addressed', speakers: [], addressed, rejectedPlanEntries: 0 };
  }

  const planned = new Map<
    InstanceId,
    { instance: CharacterInstance; intent: string; mode: IntentMode; index: number }
  >();
  let rejectedPlanEntries = 0;
  for (const [index, entry] of (input.plan ?? []).entries()) {
    const matches = eligible.filter((item) => item.displayName.trim() === entry.name.trim());
    const instance = matches.length === 1 ? matches[0] : undefined;
    if (!instance || planned.has(instance.id)) {
      rejectedPlanEntries += 1;
      continue;
    }
    planned.set(instance.id, { instance, intent: entry.intent, mode: entry.mode, index });
  }

  const speakers: SelectedTurnSpeaker[] = [];
  for (const id of addressed) {
    const instance = eligible.find((item) => item.id === id);
    if (!instance) continue;
    const suggestion = planned.get(id);
    const keepIntent = suggestion !== undefined && suggestion.mode !== 'hold_back';
    speakers.push({
      instance,
      intent: keepIntent ? suggestion.intent : null,
      mode: input.actionsOnly
        ? 'hold_back'
        : suggestion?.mode === 'hold_back'
          ? 'reply'
          : (suggestion?.mode ?? 'reply'),
      source: 'addressed',
    });
  }

  const remaining = [...planned.values()]
    .filter((item) => !addressed.includes(item.instance.id))
    .sort((a, b) => Number(b.mode === 'cut_in') - Number(a.mode === 'cut_in') || a.index - b.index);
  for (const item of remaining) {
    if (speakers.length >= input.maxSpeakers) break;
    speakers.push({
      instance: item.instance,
      intent: item.intent,
      mode: input.actionsOnly ? 'hold_back' : item.mode,
      source: 'planned',
    });
  }

  if (speakers.length === 0) {
    const fallbackId =
      input.schedule.speakers.find((id) => eligible.some((item) => item.id === id)) ??
      [...input.schedule.scores]
        .filter((score) => eligible.some((item) => item.id === score.instanceId))
        .sort((a, b) => b.score - a.score)[0]?.instanceId ??
      eligible[0]?.id;
    const instance = eligible.find((item) => item.id === fallbackId);
    if (instance) {
      speakers.push({ instance, intent: null, mode: input.actionsOnly ? 'hold_back' : 'reply', source: 'rule' });
    }
  }
  return { kind: 'ready', speakers, rejectedPlanEntries };
}
