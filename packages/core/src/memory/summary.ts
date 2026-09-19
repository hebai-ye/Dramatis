import type { ConversationId, RoomId, SceneId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import { extractJsonObject } from './extract.js';

/**
 * 分层摘要（ROADMAP P1-5）。
 *
 * 工作记忆是最近几十条原文，这是**唯一精确的那一层**。再往下压两层：
 *
 * ```
 * 轮（原文） → 场景摘要 → 章节摘要
 * ```
 *
 * 为什么要有它：长跑时上下文在 40 条历史处趋于平台（T4 五十回合长跑的数据），
 * 早期事实只能靠零散的记忆条目召回——那是**抽查**，不是叙述。场景摘要给的是
 * 「这一场戏到目前为止发生了什么」的连续线索，章节摘要给的是「前面几场戏发生过什么」。
 *
 * 两条硬规矩：
 *
 * 1. **被压出窗口的原文永不删除。** 摘要只读不写原文，它只是让 prompt 里的
 *    「已经过去的部分」有个便宜的载体。原文随时可以展开回想。
 * 2. **只压已经发生的部分。** 摘要的游标（`scene.recapUpToSeq`）记着它覆盖到哪一条，
 *    所以重跑、补写都不会把同一段话统计两遍。
 */

/** 攒够这么多轮就压一次。 */
export const SUMMARY_TURN_THRESHOLD = 8;
/** 或者攒够这么多 token（谁先到算谁）。 */
export const SUMMARY_TOKEN_THRESHOLD = 2400;
/** 攒够这么多场戏的摘要就往上滚成章节摘要。 */
export const CHAPTER_SCENE_THRESHOLD = 3;

/** 一章摘要最多覆盖这么多场戏——再多就再开一章。 */
export const CHAPTER_MAX_SCENES = 6;

export interface SceneSummaryInput {
  scene: Scene;
  cast: readonly { id: string; displayName: string }[];
  playerName: string;
  /** 这一场戏里**尚未被摘要覆盖**的消息，按时间正序。 */
  messages: readonly Message[];
  /** 上一版场景摘要；有就做滚动合并，而不是重新写一遍。 */
  previousSummary: string;
}

const SCENE_SYSTEM = [
  '你在给一出多角色戏做场记。把刚发生的对话压成简短的客观记述。',
  '只写发生了什么，不写谁的内心，不做评价，不预测接下来会怎样。',
  '只输出一个 JSON 对象，不要解释，不要写代码块标记。',
].join('\n');

const FIELD_GUIDE = [
  '字段要求：',
  '- summary：三到六句话，第三人称客观叙述。**必须保留**出现过的具体人名、称呼、数字、',
  '  物品、地点、答应过的事、以及还没解决的问题；这些是后面的戏要用的线索，压掉就找不回来了。',
  '- keyFacts：一句话一条的短句清单，只放「以后可能被问到」的硬信息（谁欠谁、东西在哪、',
  '  约定了什么、谁不知道什么）。没有就写空数组。',
  '- 不要编造对话里没有发生的事；不确定的宁可不写。',
].join('\n');

const FORMAT_HINT = ['输出格式：', '{"summary":"客观经过","keyFacts":["谁欠谁一坛酒","三十箱货在船舱夹层"]}'].join(
  '\n',
);

function renderMessages(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const name = message.role === 'player' ? `${message.speakerName}（玩家）` : message.speakerName;
      return `${name}：${message.content.replace(/\s*\n\s*/g, ' ')}`;
    })
    .join('\n');
}

export function buildSceneSummaryMessages(input: SceneSummaryInput): ChatMessage[] {
  const scene = input.scene;
  const cast = input.cast.map((member) => member.displayName).join('、');

  const context = [
    `地点：${scene.location.trim() === '' ? '未指定' : scene.location.trim()}`,
    scene.worldTime.trim() === '' ? null : `世界内时间：${scene.worldTime.trim()}`,
    cast === '' ? null : `这一场里有：${cast}`,
    `玩家扮演：${input.playerName}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    { role: 'system', content: SCENE_SYSTEM },
    {
      role: 'user',
      content: [
        context,
        '',
        input.previousSummary.trim() === ''
          ? '这是这一场戏的开头，还没有摘要。'
          : `这是此前的摘要，请把它和下面新增的部分**合并成一段**新的摘要（不要丢掉里面的事实）：\n${input.previousSummary.trim()}`,
        '',
        '新增的部分：',
        renderMessages(input.messages),
        '',
        FIELD_GUIDE,
        '',
        FORMAT_HINT,
      ].join('\n'),
    },
  ];
}

export interface ParsedSummary {
  summary: string;
  keyFacts: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readKeyFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '');
}

/**
 * 宽容解析：认 JSON 对象，也认「模型直接写了一段散文」。
 *
 * 摘要这种东西，模型不写 JSON 也照样有用——把整段当摘要收下，比丢掉整轮强。
 */
export function parseSummary(raw: string): ParsedSummary {
  const text = raw.trim();
  if (text === '') return { summary: '', keyFacts: [] };

  try {
    const parsed = extractJsonObject(text);
    const record = asRecord(parsed);
    if (record !== null) {
      const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
      if (summary !== '') {
        return { summary, keyFacts: readKeyFacts(record.keyFacts) };
      }
    }
  } catch {
    // 落到下面的兜底：当散文收
  }

  return { summary: stripCodeFence(text), keyFacts: [] };
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

export interface ChapterSummaryInput {
  title: string;
  /** 按时间正序的若干场戏摘要。 */
  scenes: readonly { title: string; location: string; summary: string }[];
  playerName: string;
}

const CHAPTER_SYSTEM = [
  '你在给一出多角色戏写分章回顾。把几场戏串成一条线索。',
  '只写发生了什么，不写谁的内心，不做评价。',
  '只输出一个 JSON 对象，不要解释，不要写代码块标记。',
].join('\n');

export function buildChapterSummaryMessages(input: ChapterSummaryInput): ChatMessage[] {
  const body = input.scenes
    .map((scene, index) => {
      const where = scene.location.trim() === '' ? '' : `（${scene.location.trim()}）`;
      return `${String(index + 1)}. ${scene.title}${where}\n${scene.summary.trim()}`;
    })
    .join('\n\n');

  return [
    { role: 'system', content: CHAPTER_SYSTEM },
    {
      role: 'user',
      content: [
        `玩家扮演：${input.playerName}`,
        `这一段叫：${input.title}`,
        '',
        '各场戏的摘要：',
        body,
        '',
        '要求：',
        '- summary：四到八句话，把这几场戏串成一条线。重点保留贯穿其中的东西：谁和谁的关系变了、',
        '  许下的承诺、还没了结的事、玩家反复追问的线索。',
        '- keyFacts：一句话一条，只放以后可能被问到的硬信息。',
        '',
        FORMAT_HINT,
      ].join('\n'),
    },
  ];
}

export interface PendingSummary {
  /** 还没被摘要覆盖的消息。 */
  messages: Message[];
  /** 这些消息涉及多少个回合。 */
  turns: number;
  tokens: number;
}

/**
 * 算出「从上次摘要到现在」攒了哪些内容。
 *
 * 游标是 `scene.recapUpToSeq`（消息在房间内单调递增的序号）。缺失或为 0 表示
 * 这一场还没有摘要——从头开始算。
 */
export function pendingSummary(
  scene: Scene,
  messages: readonly Message[],
  counter: TokenCounter = heuristicTokenCounter,
): PendingSummary {
  const cursor = scene.recapUpToSeq ?? 0;
  const scoped = messages.filter((message) => message.sceneId === scene.id && message.seq > cursor);

  const turns = new Set(scoped.map((message) => message.turnId)).size;
  const tokens = scoped.reduce((total, message) => total + counter.count(message.content), 0);

  return { messages: [...scoped], turns, tokens };
}

/** 轮数或 token 谁先到阈值就压一次。没有新内容当然不压。 */
export function shouldSummarizeScene(
  scene: Scene,
  messages: readonly Message[],
  options: { counter?: TokenCounter; turnThreshold?: number; tokenThreshold?: number } = {},
): boolean {
  const pending = pendingSummary(scene, messages, options.counter ?? heuristicTokenCounter);
  if (pending.messages.length === 0) return false;
  return (
    pending.turns >= (options.turnThreshold ?? SUMMARY_TURN_THRESHOLD) ||
    pending.tokens >= (options.tokenThreshold ?? SUMMARY_TOKEN_THRESHOLD)
  );
}

export interface ChapterCandidate {
  /** 还没有被任何章节摘要收录的、已经有摘要的场景。 */
  scenes: Scene[];
  /** 最后一章覆盖到哪一场（供界面显示）；没有章节时是 null。 */
  lastChapterSceneId: SceneId | null;
}

/**
 * 挑出该滚成章节的那几场戏。
 *
 * 只收「已经有摘要」的场景——没有摘要的场景说明它的原文还在窗口里，
 * 不需要（也不该）提前压成一句话。
 */
export function chapterCandidates(input: {
  scenes: readonly Scene[];
  /** 已经被章节摘要收录过的场景 id。 */
  coveredSceneIds: readonly SceneId[];
  /** 攒够几场滚一次。 */
  threshold?: number;
}): ChapterCandidate {
  const covered = new Set(input.coveredSceneIds);
  const ready = input.scenes
    .filter((scene) => (scene.recap ?? '').trim() !== '' && !covered.has(scene.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const threshold = input.threshold ?? CHAPTER_SCENE_THRESHOLD;
  return {
    scenes: ready.length >= threshold ? ready.slice(0, CHAPTER_MAX_SCENES) : [],
    lastChapterSceneId: covered.size === 0 ? null : ([...covered].at(-1) ?? null),
  };
}

/** 章节摘要的实体（P1-5 的第三层）。 */
export interface ChapterSummary {
  id: string;
  roomId: RoomId;
  conversationId: ConversationId | null;
  title: string;
  /** 这一章覆盖了哪几场戏。 */
  sceneIds: SceneId[];
  summary: string;
  keyFacts: string[];
  createdAt: string;
  /** 最后一次写入的时间（P2-6）。章节是只增不改的，所以它通常等于 createdAt。 */
  updatedAt: string;
  /** 软删除墓碑（P2-6）：归档一条对话时章节被收走，也是盖章。 */
  deletedAt: string | null;
}
