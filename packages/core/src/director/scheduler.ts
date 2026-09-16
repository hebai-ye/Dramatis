import type { InstanceId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';

/**
 * 发言调度 v1（ROADMAP P0-4，设计文档 §3.1）。
 *
 * 纯规则实现，**不调用任何模型**——这是刻意的：调度判定每次都要跑，
 * 用模型会让每回合的成本和延迟都翻倍。等真实对话流证明规则不够用时，
 * 再在 P1-6 引入意图先行。
 *
 * 输出包含完整的评分与理由，UI 可以直接展示「为什么是他接话」。
 * 一个说不清理由的调度器是无法调试的。
 */
export interface ScheduleCandidate {
  instance: CharacterInstance;
  /**
   * 距离上次发言经过了多少回合。
   * `0` 表示上一回合刚说过；`null` 或 `undefined` 表示从未发言。
   *
   * 之所以接受 `undefined`：`turnsSinceLastSpoke` 只返回说过话的人，
   * 调用方查不到时自然是 undefined。这里统一归一化，而不是指望
   * 每个调用点都记得补一个 `?? null`。
   */
  turnsSinceSpoke: number | null | undefined;
  /** 用于名字识别的别名，通常是角色卡的原始名字与昵称。 */
  aliases?: readonly string[];
}

export interface ScheduleInput {
  playerInput: string;
  candidates: readonly ScheduleCandidate[];
  /** 最多让几名角色接话，默认 1。 */
  maxSpeakers?: number;
  /**
   * 当前场景的名单。
   *
   * presence 与「在不在这场」是两件事：世界拆成多条对话之后，一个角色的
   * presence 可能是 onstage（他正在这个世界的某处），但并不在这条对话的场景里。
   * 只按 presence 过滤的话，场景外的角色会被调度上台——真实使用中踩到过。
   * 传了名单就以此为准，不在名单里的一律不接话。
   */
  cast?: readonly InstanceId[];
  /**
   * 上一条发言的角色。
   *
   * 玩家接着往下说时（「那你呢」「你还记得吗」这种，没点名），本该由同一个
   * 人接话——真实使用里 v1 会因为冷却惩罚换人，读起来像答非所问。
   * 只要玩家没有点名别人，就给他一个「延续」加成，压过冷却惩罚。
   */
  previousSpeakerId?: InstanceId | null;
  /** 注入随机源便于测试；默认 Math.random。 */
  random?: () => number;
}

export type ScoreReasonCode =
  | 'mentioned'
  | 'continuation'
  | 'extroversion'
  | 'cooldown'
  | 'fairness'
  | 'question'
  | 'jitter'
  | 'fallback';

export interface ScoreReason {
  code: ScoreReasonCode;
  label: string;
  delta: number;
}

export interface SpeakerScore {
  instanceId: InstanceId;
  displayName: string;
  score: number;
  reasons: ScoreReason[];
  selected: boolean;
  /** 被排除的原因；入选时为 null。 */
  excluded: string | null;
}

export interface ScheduleResult {
  speakers: InstanceId[];
  scores: SpeakerScore[];
  /**
   * 是否动用了兜底：所有角色都没到阈值，但场景里有人在场。
   * 没有兜底，单人场景会在冷却后陷入永远沉默。
   */
  fallback: boolean;
}

const MENTION_BONUS = 100;
const NEVER_SPOKE_BONUS = 30;
const FAIRNESS_PER_TURN = 8;
const FAIRNESS_CAP = 40;
const COOLDOWN_LAST_TURN = -45;
const COOLDOWN_SECOND_TURN = -18;
const EXTROVERSION_WEIGHT = 15;
const QUESTION_BONUS = 6;
const CONTINUATION_BONUS = 60;

/**
 * 这句话是不是「说给上一个人听」的。
 *
 * 判据故意做得窄：出现「你 / 您」且**没有**「你们 / 各位 / 大家」这类复数说法。
 * 「你还记得吗」是追问，该由同一个人接；「你们觉得呢」是在问全场，该轮换。
 * 这条判据替代不了 P1-6 的意图先行，但比「上一条是谁说的」这种瞎猜准得多。
 */
function looksAddressedToLast(text: string): boolean {
  if (!/[你您]/.test(text)) return false;
  return !/你们|各位|大家|诸位/.test(text);
}
const JITTER_RANGE = 6;
const MIN_SCORE = 0;

const PRESENCE_LABEL: Record<CharacterInstance['presence'], string | null> = {
  onstage: null,
  muted: '处于 muted：在场但不发言',
  offscreen: '处于 offscreen：不在场景中',
  absent: '处于 absent：已离场',
};

function isQuestion(text: string): boolean {
  return /[?？]/.test(text);
}

function mentions(text: string, names: readonly string[]): string | null {
  const haystack = text.toLowerCase();
  for (const name of names) {
    const needle = name.trim().toLowerCase();
    if (needle !== '' && haystack.includes(needle)) return name;
  }
  return null;
}

/**
 * 给所有候选打分并选出接话者。
 *
 * 评分是「可解释的加法」，每个加分项都会出现在 reasons 里，
 * 而不是一堆看不懂的权重相乘。
 */
export function scheduleSpeakers(input: ScheduleInput): ScheduleResult {
  const random = input.random ?? Math.random;
  const maxSpeakers = Math.max(1, input.maxSpeakers ?? 1);
  const question = isQuestion(input.playerInput);

  /**
   * 玩家有没有点名别人。
   *
   * 点了名就说明他在跟另一个人说话，「延续上一位」的加成必须让位给点名；
   * 没点名时默认他还在跟上一位说。
   */
  const mentionsOther = input.candidates.some(
    (candidate) =>
      candidate.instance.id !== input.previousSpeakerId &&
      mentions(input.playerInput, [candidate.instance.displayName, ...(candidate.aliases ?? [])]) !== null,
  );
  const continuing =
    input.previousSpeakerId !== null &&
    input.previousSpeakerId !== undefined &&
    !mentionsOther &&
    looksAddressedToLast(input.playerInput);

  const scores: SpeakerScore[] = input.candidates.map((candidate) => {
    const { instance } = candidate;
    const reasons: ScoreReason[] = [];

    const presenceIssue = PRESENCE_LABEL[instance.presence];
    if (presenceIssue !== null) {
      return {
        instanceId: instance.id,
        displayName: instance.displayName,
        score: 0,
        reasons,
        selected: false,
        excluded: presenceIssue,
      };
    }

    // 名单是更强的一道闸：presence 说的是「他在这个世界的状态」，
    // 名单说的是「他此刻在这场戏里」
    if (input.cast !== undefined && !input.cast.includes(instance.id)) {
      return {
        instanceId: instance.id,
        displayName: instance.displayName,
        score: 0,
        reasons,
        selected: false,
        excluded: '不在当前场景名单里',
      };
    }

    const names = [instance.displayName, ...(candidate.aliases ?? [])];
    const hit = mentions(input.playerInput, names);
    if (hit !== null) {
      reasons.push({ code: 'mentioned', label: `被点名（${hit}）`, delta: MENTION_BONUS });
    }

    const isPrevious = instance.id === input.previousSpeakerId;
    if (isPrevious && continuing) {
      reasons.push({
        code: 'continuation',
        label: '玩家在接着说给他听',
        delta: CONTINUATION_BONUS,
      });
    }

    const extroversion = instance.traits.extroversion * EXTROVERSION_WEIGHT;
    if (Math.abs(extroversion) >= 1) {
      reasons.push({
        code: 'extroversion',
        label: extroversion > 0 ? '性格外向，倾向主动接话' : '性格内向，倾向少说',
        delta: extroversion,
      });
    }

    const sinceSpoke = candidate.turnsSinceSpoke ?? null;

    // 玩家还在跟他说话时不算「抢话」：冷却惩罚在这里会让对话变成答非所问
    if (isPrevious && continuing) {
      // 不加冷却惩罚
    } else if (sinceSpoke === 0) {
      reasons.push({ code: 'cooldown', label: '上一回合刚发过言', delta: COOLDOWN_LAST_TURN });
    } else if (sinceSpoke === 1) {
      reasons.push({ code: 'cooldown', label: '两回合内发过言', delta: COOLDOWN_SECOND_TURN });
    }

    if (sinceSpoke === null) {
      reasons.push({ code: 'fairness', label: '还没说过话', delta: NEVER_SPOKE_BONUS });
    } else if (sinceSpoke >= 3) {
      const bonus = Math.min(sinceSpoke * FAIRNESS_PER_TURN, FAIRNESS_CAP);
      reasons.push({ code: 'fairness', label: `已经 ${sinceSpoke} 回合没说话`, delta: bonus });
    }

    if (question && hit === null) {
      reasons.push({ code: 'question', label: '玩家在提问，可能想听回应', delta: QUESTION_BONUS });
    }

    const jitter = random() * JITTER_RANGE;
    reasons.push({ code: 'jitter', label: '随机扰动（避免每次都是同一人）', delta: jitter });

    const score = reasons.reduce((total, reason) => total + reason.delta, 0);

    return {
      instanceId: instance.id,
      displayName: instance.displayName,
      score,
      reasons,
      selected: false,
      excluded: null,
    };
  });

  const eligible = scores.filter((score) => score.excluded === null);
  const ranked = [...eligible].sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));

  const speakers: InstanceId[] = [];
  for (const score of ranked) {
    if (speakers.length >= maxSpeakers) break;
    if (score.score < MIN_SCORE) continue;
    score.selected = true;
    speakers.push(score.instanceId);
  }

  // 兜底：有人在场却没人达到阈值时，让分数最高的人接话。
  // 否则单人场景在冷却惩罚后会永远沉默。
  let fallback = false;
  if (speakers.length === 0 && ranked.length > 0) {
    const top = ranked[0];
    if (top) {
      top.selected = true;
      top.reasons.push({ code: 'fallback', label: '无人达到阈值，由本场景最合适的人接话', delta: 0 });
      speakers.push(top.instanceId);
      fallback = true;
    }
  }

  return { speakers, scores, fallback };
}

/**
 * 从历史里推断每个角色的「距上次发言经过了几回合」。
 *
 * 回合数按 `turnId` 去重统计：同一回合里多名角色发言只算一个回合，
 * 否则多角色场景的冷却会被重复计算。
 */
export function turnsSinceLastSpoke(
  history: readonly { turnId: string; speakerInstanceId: InstanceId | null }[],
  currentTurnId: string,
): Map<InstanceId, number | null> {
  const turnOrder: string[] = [];
  for (const message of history) {
    if (!turnOrder.includes(message.turnId)) turnOrder.push(message.turnId);
  }
  const currentIndex = turnOrder.indexOf(currentTurnId);
  const totalTurns = currentIndex === -1 ? turnOrder.length : currentIndex;

  const lastSpokeAt = new Map<InstanceId, number>();
  for (const message of history) {
    if (message.speakerInstanceId === null) continue;
    const index = turnOrder.indexOf(message.turnId);
    const previous = lastSpokeAt.get(message.speakerInstanceId);
    if (previous === undefined || index > previous) {
      lastSpokeAt.set(message.speakerInstanceId, index);
    }
  }

  const result = new Map<InstanceId, number | null>();
  for (const [instanceId, index] of lastSpokeAt) {
    result.set(instanceId, Math.max(0, totalTurns - index - 1));
  }
  return result;
}
