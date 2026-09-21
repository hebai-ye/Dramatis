/**
 * 新对话的「记忆附件」（顺序 27b）。
 *
 * 用户的原话：*「用户打开新对话时可将原对话的重要记忆作为特殊附件存入角色卡内，
 * 以此来在新对话中与角色互动……角色卡的记忆附件应怎么样才不算臃肿……类似于文件夹，
 * 当用户与角色的对话提及记忆关键词后 AI 可以在记忆附件中搜索相关记忆，
 * 而当用户只是日常聊天时则不会触及记忆以此节省 token」*。
 *
 * 这一版把那个构想落成**三层**，常驻的部分只有索引：
 *
 * ```
 * ① 关系现状   一句话：他此刻怎么看待你            ≤ 60 字
 * ② 时间线索引 每章一行：标题 + 一句话 + 关键词    ≤ 600 字
 * ③ 记忆索引   每条印象一行：关键词 + 半句话        ≤ 1000 字
 * ```
 *
 * **为什么是索引而不是正文**（用实测数字）：一次 300 轮的对话攒下 ~590 条记忆，
 * 全文约 4.7 万字（≈2.4 万 token），不可能全带；合并成印象之后仍有几千字；
 * 压成三层索引大约是 1,600 字（≈800 token）——这是能接受的常驻成本。
 * 正文留给 27c：**对话里出现关键词时才把对应的两三条展开**。
 *
 * 三个设计约束：
 *
 * 1. **它是纯函数**：只按输入拼装、裁剪，不调模型、不碰库。生成索引的词靠启发式
 *    （参与者名、地点、引号里的词、摘要里的高频短词），够用且免费；将来换成模型生成
 *    也只改这一个函数。
 * 2. **超预算从最不重要的开始丢**：时间线从最早的章开始丢，记忆索引从重要度最低的开始丢，
 *    并且**丢了要如实记在 `stats.dropped` 里**——用户看到「这条线带了 40/59 条记忆」，
 *    比看到一份静悄悄缩水的附件强。
 * 3. **附件里不放原文**：只放「关键词 + 半句话」。要读全文得回库里取（27c 的检索）。
 */

import type { Card } from '../model/card.js';
import type { ConversationId, EventId } from '../model/ids.js';
import type { Relationship } from '../model/instance.js';

/** 挂在 `Card.extensions` 上的键（角色卡是本机/同步的实体，附件跟着它走）。 */
export const ATTACHMENT_EXTENSION_KEY = 'dramatis.memoryAttachment';

export interface AttachmentTimelineLine {
  chapterId: string;
  /** 章标题（没有标题时用「第 N 章」）。 */
  label: string;
  /** 一句话概括（来自章节回顾，已经压过一道）。 */
  line: string;
  keywords: string[];
  at: string;
}

export interface AttachmentMemoryLine {
  memoryId: EventId;
  /** 关键词：命中它才值得展开正文（顺序 27c 用）。 */
  keywords: string[];
  /** 半句话：让模型一眼看出这条大概是关于什么的。 */
  line: string;
  importance: number;
}

export interface MemoryAttachment {
  version: 1;
  /** 这份附件是从哪条对话带过来的。 */
  fromConversationId: ConversationId;
  fromConversationTitle: string;
  builtAt: string;
  /** ① 关系现状：一句话。 */
  relation: string;
  /** ② 时间线索引。 */
  timeline: AttachmentTimelineLine[];
  /** ③ 记忆索引。 */
  memories: AttachmentMemoryLine[];
  stats: {
    chapters: number;
    impressions: number;
    chars: number;
    /** 因为超出预算被丢掉的条数（如实记，别静悄悄缩水）。 */
    dropped: { timeline: number; memories: number };
  };
}

export interface BuildAttachmentInput {
  fromConversationId: ConversationId;
  fromConversationTitle: string;
  builtAt?: string;
  /** 这个角色对玩家的关系边；没有就写「还没建立起明确的看法」。 */
  relationship?: Pick<Relationship, 'trust' | 'affinity' | 'fear' | 'respect' | 'tension'> | null;
  chapters: readonly { id: string; title: string; summary: string; at: string; keywords?: readonly string[] }[];
  /** 印象（合并出来的粗粒度记忆）；没有印象时调用方传高重要度的那几条。 */
  impressions: readonly {
    id: EventId;
    summary: string;
    importance: number;
    participants?: readonly string[];
    location?: string;
  }[];
  budgets?: Partial<{ relation: number; timeline: number; memories: number }>;
  /** 三条索引之外还要收进关键词表的词（例如世界书里的地名、玩家名字）。 */
  extraKeywords?: readonly string[];
}

const DEFAULT_BUDGET = { relation: 60, timeline: 600, memories: 1000 } as const;

/**
 * 关键词表（启发式，够用且免费）。
 *
 * 三处来源：① 调用方给的额外词（参与者名、地点、世界书词条）；
 * ② 文本里成对引号中的词（「货栈」「胡记院」这类专名通常就在引号里）；
 * ③ 摘要里出现两次以上的 2–4 字片段（「账房」「码头」这种高频词）。
 * 顺序即优先级，去重后最多 6 个。
 */
export function extractKeywords(text: string, extra: readonly string[] = []): string[] {
  const found: string[] = [];
  const push = (word: string): void => {
    const trimmed = word.trim();
    if (trimmed.length < 2 || trimmed.length > 8) return;
    if (!found.includes(trimmed)) found.push(trimmed);
  };

  for (const word of extra) push(word);
  for (const match of text.matchAll(/[「『“"]([^」』”"]{2,8})[」』”"]/g)) push(match[1] ?? '');

  // 高频 2–4 字片段：中文没有空格，就按定长窗口数频次，取出现两次以上的
  const counts = new Map<string, number>();
  for (let size = 4; size >= 2; size -= 1) {
    for (let index = 0; index + size <= text.length; index += 1) {
      const piece = text.slice(index, index + size);
      if (!/^[\p{Script=Han}]{2,4}$/u.test(piece)) continue;
      counts.set(piece, (counts.get(piece) ?? 0) + 1);
    }
  }
  const frequent = [...counts.entries()].filter(([, count]) => count >= 2).sort((left, right) => right[1] - left[1]);
  for (const [piece] of frequent) {
    if (found.length >= 6) break;
    // 已经被更长的词覆盖的短片段就不再重复收
    if (found.some((word) => word.includes(piece))) continue;
    push(piece);
  }

  return found.slice(0, 6);
}

/** 关系数值 → 一句话。用区间而不是精确值：附件要的是「大致怎么看他」。 */
export function describeRelation(
  relationship: Pick<Relationship, 'trust' | 'affinity' | 'fear' | 'respect' | 'tension'> | null | undefined,
): string {
  if (relationship === null || relationship === undefined) return '你们还没怎么打过交道。';
  const { trust, affinity, fear, tension } = relationship;
  const parts: string[] = [];
  if (affinity >= 0.5) parts.push('他挺亲近你');
  else if (affinity >= 0.15) parts.push('他对你有几分好感');
  else if (affinity <= -0.4) parts.push('他不太愿意见到你');

  if (trust >= 0.5) parts.push('信得过你');
  else if (trust <= -0.3) parts.push('防着你');

  if (fear >= 0.5) parts.push('也怕你');
  if (tension >= 0.5) parts.push('心里还梗着上次的事');
  if (parts.length === 0) parts.push('对你的态度还很平常');
  return `${parts.join('，')}。`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 索引那一行的写法：关键词在前、半句话在后，一眼看得出「要不要展开」。 */
function indexLine(keywords: readonly string[], text: string, halfChars = 40): string {
  const head = keywords.length === 0 ? '' : `${keywords.slice(0, 3).join('/')}｜`;
  return `${head}${clip(text.replace(/\s+/g, ' '), halfChars)}`;
}

/**
 * 生成附件。**超预算从最不重要的开始丢**：时间线丢最早的章，记忆索引丢重要度最低的。
 */
export function buildMemoryAttachment(input: BuildAttachmentInput): MemoryAttachment {
  const budget = { ...DEFAULT_BUDGET, ...input.budgets };
  const extra = [...(input.extraKeywords ?? [])];

  const relation = clip(describeRelation(input.relationship), budget.relation);

  const timelineAll: AttachmentTimelineLine[] = input.chapters.map((chapter) => {
    // 章标题本身就是最好的关键词（「雨夜」「货栈那一场」）——直接当额外词喂进去，
    // 否则短摘要里没有重复片段时一个关键词都抓不到
    const keywords = extractKeywords(`${chapter.title} ${chapter.summary}`, [
      chapter.title,
      ...(chapter.keywords ?? []),
      ...extra,
    ]);
    return {
      chapterId: chapter.id,
      label: chapter.title.trim() === '' ? '（未命名的一章）' : chapter.title,
      line: indexLine(keywords, chapter.summary, 48),
      keywords,
      at: chapter.at,
    };
  });

  const memoriesAll: AttachmentMemoryLine[] = [...input.impressions]
    // 重要度高的先留
    .sort((left, right) => right.importance - left.importance)
    .map((impression) => {
      const keywords = extractKeywords(impression.summary, [
        ...(impression.participants ?? []),
        ...(impression.location === undefined ? [] : [impression.location]),
        ...extra,
      ]);
      return {
        memoryId: impression.id,
        keywords,
        line: indexLine(keywords, impression.summary, 36),
        importance: impression.importance,
      };
    });

  const relationChars = relation.length;
  const timeline: AttachmentTimelineLine[] = [];
  let timelineChars = 0;
  // 时间线按时间正序保留**最早的**？不：这里按输入顺序（调用方按时间给），
  // 超预算时从**最早的**开始丢——最近的几章对新对话更有用
  for (const line of [...timelineAll].reverse()) {
    const cost = line.label.length + line.line.length + 4;
    if (timelineChars + cost > budget.timeline) continue;
    timeline.unshift(line);
    timelineChars += cost;
  }

  const memories: AttachmentMemoryLine[] = [];
  let memoryChars = 0;
  for (const line of memoriesAll) {
    const cost = line.line.length + 3;
    if (memoryChars + cost > budget.memories) continue;
    memories.push(line);
    memoryChars += cost;
  }

  return {
    version: 1,
    fromConversationId: input.fromConversationId,
    fromConversationTitle: input.fromConversationTitle,
    builtAt: input.builtAt ?? new Date().toISOString(),
    relation,
    timeline,
    memories,
    stats: {
      chapters: timeline.length,
      impressions: memories.length,
      chars: relationChars + timelineChars + memoryChars,
      dropped: {
        timeline: timelineAll.length - timeline.length,
        memories: memoriesAll.length - memories.length,
      },
    },
  };
}

/**
 * 附件 → 给模型看的那段文本（三层，短的）。
 *
 * 紧接在角色卡后面注入（27c 接装配），所以**每一行都要值得那几个 token**：
 * 关系一句话、时间线一节、记忆索引一节，都不展开正文。
 */
export function renderAttachment(attachment: MemoryAttachment): string {
  const lines = [`【你记得的事·索引】（来自「${attachment.fromConversationTitle}」）`, `· ${attachment.relation}`];
  if (attachment.timeline.length > 0) {
    lines.push('· 经过的几段：');
    for (const item of attachment.timeline) lines.push(`  - ${item.label}：${item.line}`);
  }
  if (attachment.memories.length > 0) {
    lines.push('· 还记着这些（提到相关的事时你会想起来）：');
    for (const item of attachment.memories) lines.push(`  - ${item.line}`);
  }
  return lines.join('\n');
}

/** 从角色卡里读附件（没有就是 null）。 */
export function readAttachment(card: Pick<Card, 'extensions'>): MemoryAttachment | null {
  const raw = card.extensions[ATTACHMENT_EXTENSION_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Partial<MemoryAttachment>;
  if (record.version !== 1 || typeof record.relation !== 'string') return null;
  return {
    version: 1,
    fromConversationId: (record.fromConversationId ?? '') as ConversationId,
    fromConversationTitle: typeof record.fromConversationTitle === 'string' ? record.fromConversationTitle : '',
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : '',
    relation: record.relation,
    timeline: Array.isArray(record.timeline) ? record.timeline : [],
    memories: Array.isArray(record.memories) ? record.memories : [],
    stats:
      record.stats === undefined
        ? { chapters: 0, impressions: 0, chars: record.relation.length, dropped: { timeline: 0, memories: 0 } }
        : record.stats,
  };
}

/** 把附件挂到角色卡上（返回新的卡，不改原对象）。 */
export function withAttachment(card: Card, attachment: MemoryAttachment): Card {
  return {
    ...card,
    extensions: { ...card.extensions, [ATTACHMENT_EXTENSION_KEY]: attachment },
  };
}
