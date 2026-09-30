import {
  type Card,
  createBlankCard,
  createWorldBookEntry,
  type WorldBook,
  type WorldBookEntry,
} from '../model/card.js';
import {
  cardId as asCardId,
  worldBookId as asWorldBookId,
  type CardId,
  newId,
  nowIso,
  type WorldBookId,
} from '../model/ids.js';
import type { Persona } from '../model/persona.js';
import type { CastPolicy, Scene } from '../model/room.js';
import type { ChatToolCall, ToolDefinition } from '../prompt/types.js';
import { asRecord, text } from '../util/json.js';

/**
 * 副对话的工具集（LAYOUT 待确认第 4 条：先只做素材那几件）。
 *
 * 现在**五件**：角色卡、世界书、玩家身份（建 / 删）、当前场景。每一件都对应一种素材，
 * 刻意不多给——管理员的职责是「帮你起草素材」，不是「替你玩这个游戏」。
 *
 * （原先只写了三件，后来加了 `upsert_persona` / `delete_persona`，注释没跟上；
 * 顺序 67 把注释、文案与这里的清单对齐。）
 */
export type AdminToolName =
  | 'upsert_character_card'
  | 'upsert_world_book'
  | 'upsert_persona'
  | 'delete_persona'
  | 'set_scene';

/*
 * 顺序 103：角色卡正文的长度口径。
 *
 * 来源是用户 2026-09-30 的实测：把角色卡的「人设」（description）压到 5 句话以内、
 * 「性格」（personality）压到 2～3 句话时，主对话的表现明显更好。原因与 178 轮长跑
 * 的失真一致——这两段每一轮都会被原样塞进提示词，卡上写得越长，角色越容易把注意力
 * 花在「说清自己是谁」上（自称与名字当主语的次数随轮次膨胀，见 docs/EVAL.md 第六十八节）。
 *
 * 口径只写三处、且都从这里取：管理员系统提示词（prompt.ts 的 SYSTEM_PROMPT）、
 * 工具参数说明（下面 ADMIN_TOOLS 里 description/personality 两行）、以及草稿摘要里的提醒。
 * **只提醒、不截断**：管理员是起草者，用户仍可以自己写长卡，硬砍会丢设定。
 */
export const CARD_DESCRIPTION_MAX_SENTENCES = 5;
export const CARD_PERSONALITY_MAX_SENTENCES = 3;

/** 给模型看的完整口径（prompt.ts 直接用这一段，别再抄一遍数字）。 */
export const CARD_LENGTH_GUIDE = [
  `起草角色卡时把正文写短：**人设（description）控制在 ${String(CARD_DESCRIPTION_MAX_SENTENCES)} 句话以内**，**性格（personality）控制在 2～${String(CARD_PERSONALITY_MAX_SENTENCES)} 句话以内**。`,
  '只留最能决定他「怎么说话、怎么做」的部分；身世细节、地方风物、历史事件放进世界书，需要时再触发。',
].join('\n');

const SENTENCE_SPLIT = /[。！？!?…\n\r]+/;

/** 数一段话里有几「句」：句末标点与换行都断句，连续标点只算一次；分号、逗号不断句。 */
export function countSentences(value: string): number {
  return value
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== '').length;
}

/** 草稿摘要里的长度提醒：返回空串表示两段都在口径内。 */
export function cardLengthNote(description: string, personality: string): string {
  const over: string[] = [];
  const descriptionSentences = countSentences(description);
  if (descriptionSentences > CARD_DESCRIPTION_MAX_SENTENCES) over.push(`人设 ${String(descriptionSentences)} 句`);
  const personalitySentences = countSentences(personality);
  if (personalitySentences > CARD_PERSONALITY_MAX_SENTENCES) over.push(`性格 ${String(personalitySentences)} 句`);
  if (over.length === 0) return '';
  return `${over.join('、')}，建议人设 ${String(CARD_DESCRIPTION_MAX_SENTENCES)} 句以内、性格 2～${String(CARD_PERSONALITY_MAX_SENTENCES)} 句`;
}

export const ADMIN_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'upsert_character_card',
      description:
        '起草或修改一张角色卡。改动只是草稿，用户点「采纳」之后才会进入素材库；' +
        '修改已有的卡时必须带上 cardId，而且**只需写要改的字段**：没提到的字段保持原样，' +
        '要清空某个字段就显式传空字符串（新建时必须给 name 与 description）。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '修改已有角色卡时填它的 id；新建时留空' },
          name: { type: 'string', description: '角色名' },
          nickname: { type: 'string', description: '角色对玩家的自称，可留空' },
          description: {
            type: 'string',
            description: `外貌、身份、来头；${String(CARD_DESCRIPTION_MAX_SENTENCES)} 句话以内，越短主对话越聚焦`,
          },
          personality: {
            type: 'string',
            description: `性格；2～${String(CARD_PERSONALITY_MAX_SENTENCES)} 句话以内`,
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_world_book',
      description:
        '起草或修改一本世界书（也就是世界卡）。关键词触发时才会插入提示词，' +
        'constant 为 true 的条目每轮都在。修改已有的书时必须带上 bookId，' +
        '并且 entries 是**整本替换**：原有条目要一并写回，不要只交新增的那几条。' +
        '（同名条目会保留它原有的插入位置、概率等设置，所以照原样传回来就是安全的。）',
      parameters: {
        type: 'object',
        properties: {
          bookId: { type: 'string', description: '修改已有世界书时填它的 id；新建时留空' },
          name: { type: 'string', description: '世界书的名字' },
          entries: {
            type: 'array',
            description: '条目列表',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                keys: { type: 'array', items: { type: 'string' }, description: '触发关键词' },
                content: { type: 'string', description: '命中后插入的设定正文' },
                constant: { type: 'boolean', description: '常驻条目，不需要关键词' },
                order: { type: 'number', description: '排序权重，默认 100' },
              },
              required: ['content'],
            },
          },
        },
        required: ['name', 'entries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_persona',
      description:
        '起草或修改一份玩家身份（Persona）。身份描述玩家在对话中是谁；' +
        '修改已有身份时必须带 personaId，改动先作为草稿等待用户采纳。',
      parameters: {
        type: 'object',
        properties: {
          personaId: { type: 'string', description: '修改已有身份时填它的 id；新建时留空' },
          name: { type: 'string', description: '玩家身份的名字' },
          description: { type: 'string', description: '外貌、来历、性格与扮演设定' },
        },
        required: ['name', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_persona',
      description:
        '申请彻底删除一份玩家身份。必须同时给出 personaId 与 confirmName（身份的当前名字）；' +
        '这里只会生成待确认删除草稿，用户点确认后才真正删除。',
      parameters: {
        type: 'object',
        properties: {
          personaId: { type: 'string', description: '要删除的身份 id' },
          confirmName: { type: 'string', description: '身份的当前名字，用于防止删错' },
        },
        required: ['personaId', 'confirmName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_scene',
      description:
        '设置当前场景：地点、世界内时间、场景设定或入场策略。**只写用户明确要求改的字段**，' +
        '没有提到的不要顺手改（尤其是 castPolicy：把锁定的场子改成 open 等于允许 AI 自行拉角色入场）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          location: { type: 'string' },
          worldTime: { type: 'string' },
          summary: { type: 'string', description: '场景设定，会写进提示词' },
          castPolicy: {
            type: 'string',
            enum: ['open', 'locked', 'invite_only', 'triggered'],
            description: '入场策略：locked 表示不允许 AI 引入新角色',
          },
        },
      },
    },
  },
];

export interface CharacterCardDraft {
  kind: 'character-card';
  /** 非空表示这是修改已有卡，而不是新建。 */
  cardId: CardId | null;
  card: Card;
  /**
   * 起草时那张卡/那本书的 `updatedAt`（顺序 86，审计 B6）；新建时为 null。
   *
   * 采纳发生在几分钟之后，中间用户完全可能自己改过这张卡。带着这个时刻，
   * 采纳路径就能发现「草稿是照旧版本起的」，从而拒绝覆盖而不是默默盖掉。
   */
  baseUpdatedAt: string | null;
  summary: string;
}

export interface WorldBookDraft {
  kind: 'world-book';
  bookId: WorldBookId | null;
  book: WorldBook;
  /** 同 `CharacterCardDraft.baseUpdatedAt`。 */
  baseUpdatedAt: string | null;
  summary: string;
}

export interface SceneDraft {
  kind: 'scene';
  patch: Partial<Scene>;
  summary: string;
}

export interface PersonaUpsertDraft {
  kind: 'persona-upsert';
  personaId: string | null;
  persona: Persona;
  previous: Persona | null;
  summary: string;
}

export interface PersonaDeleteDraft {
  kind: 'persona-delete';
  personaId: string;
  name: string;
  summary: string;
}

export type AdminDraft = CharacterCardDraft | WorldBookDraft | PersonaUpsertDraft | PersonaDeleteDraft | SceneDraft;

export type AdminToolParseResult =
  | {
      ok: true;
      draft: AdminDraft;
      /**
       * 模型多写的参数名（它自己发明的字段）。
       *
       * 顺序 67 之前这些是**静默丢掉**的：模型以为写进去了，用户看不到任何提示，
       * 下一轮它还会照着同一个错的形状再写一遍。现在原样回填给它——
       * 「未识别的参数：…」，让它自己改，比在界面上弹一句有用。
       */
      unknownArgs?: string[];
    }
  | { ok: false; error: string };

export interface AdminToolContext {
  /** 素材库里已有的卡与世界书，用来校验 cardId / bookId。 */
  knownCardIds?: readonly string[];
  knownBookIds?: readonly string[];
  /**
   * 素材库里的卡与世界书**本体**（顺序 86，审计 B6）。
   *
   * 只给 id 是不够的：「修改已有的卡」必须**以现有卡为底**做字段级合并，
   * 否则模型没提到的字段（开场白、示例对话、标签、`createdAt`、导入来源）会被
   * 空值覆盖——用户不会看到报错，只会发现自己的卡悄悄少了一半。
   */
  cards?: readonly Card[];
  worldBooks?: readonly WorldBook[];
  /** 当前账户里的 Persona；删除时用 name 做二次确认。 */
  knownPersonas?: readonly Persona[];
}

/**
 * 参数里到底有没有提这个字段。
 *
 * `undefined`（没写这个键）与 `null`（模型想表达「不变」）都算「没提」；
 * 只有真的给了字符串才算改——**显式空串表示清空**。这个区分是审计 B6 的核心：
 * 以前只要模型没写，字段就变成空值。
 */
function mentioned(args: Record<string, unknown>, key: string): boolean {
  return args[key] !== undefined && args[key] !== null;
}

/**
 * 取一段自由文本，容忍模型把多行内容写成数组。
 *
 * 模型把多行内容写成数组是很自然的表达（真实模型验证里出现过）。
 * 严格只认字符串的话，这段内容会被**静默丢掉**——用户看不到，也不会报错，
 * 这是最坏的一种失败方式。所以这里把数组按行拼回来，而不是挑剔它的形状。
 */
function longText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => text(item))
      .filter((item) => item !== '')
      .join('\n');
  }
  return text(value);
}

function parseJsonArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    if (!record) return { ok: false, error: '工具参数必须是一个 JSON 对象' };
    return { ok: true, value: record };
  } catch (error) {
    return { ok: false, error: `工具参数不是合法 JSON：${(error as Error).message}` };
  }
}

const CAST_POLICIES: readonly CastPolicy[] = ['open', 'locked', 'invite_only', 'triggered'];

function parseCardDraft(args: Record<string, unknown>, context: AdminToolContext): AdminToolParseResult {
  const rawId = text(args.cardId);
  const known = context.knownCardIds;
  // 以现有卡为底做合并：给了本体（cards）就有底，只给 id 时至少还能校验存在性
  const base = rawId === '' ? null : (context.cards?.find((card) => card.id === rawId) ?? null);
  if (rawId !== '' && base === null && known !== undefined && !known.includes(rawId)) {
    return { ok: false, error: `素材库里没有 id 为 ${rawId} 的角色卡；要新建就留空 cardId` };
  }

  /*
   * 名字与描述：新建时必填，修改时省略就沿用原值。
   * 「只改一个字段」不该要求模型把整张卡抄一遍——抄不全会丢内容，抄错了更糟。
   */
  const name = mentioned(args, 'name') ? text(args.name) : (base?.name ?? '');
  if (name === '') return { ok: false, error: 'name 不能为空' };
  const description = mentioned(args, 'description') ? longText(args.description) : (base?.description ?? '');
  if (description === '') return { ok: false, error: 'description 不能为空' };

  // 数组型字段：给了就整份替换（空数组 = 清空），没给就保持原样
  const tags = Array.isArray(args.tags)
    ? args.tags.map((item) => text(item)).filter((item) => item !== '')
    : (base?.tags ?? []);

  const pick = (key: string, fallback: string): string => (mentioned(args, key) ? longText(args[key]) : fallback);

  const patch: Partial<Card> = {
    name,
    nickname: pick('nickname', base?.nickname ?? ''),
    description,
    personality: pick('personality', base?.personality ?? ''),
    tags,
  };

  /*
   * 修改时整张卡**以原卡为底**合上去：没提到的字段（`createdAt`、`source`、
   * `extensions`……）原样留着。这就是审计 B6 的修法——
   * 以前无论新建还是修改都从一张空白卡起，模型没提到的字段会被空值覆盖。
   */
  const card: Card =
    base === null
      ? createBlankCard({
          ...patch,
          // 只有修改已有卡时才覆盖 id：写成 `id: undefined` 会把新生成的 id 抹掉
          ...(rawId === '' ? {} : { id: asCardId(rawId) }),
        })
      : { ...base, ...patch };

  /*
   * 顺序 103：两段正文超出长度口径时，只把事实写进草稿摘要，让用户（和下一次调用的模型）
   * 看得见，不截断内容。改的是「管理员起草时的口径」，用户自己写长卡仍然照收。
   */
  const lengthNote = cardLengthNote(card.description, card.personality);

  return {
    ok: true,
    draft: {
      kind: 'character-card',
      cardId: rawId === '' ? null : asCardId(rawId),
      card,
      baseUpdatedAt: base?.updatedAt ?? null,
      summary: `${rawId === '' ? '新建' : '修改'}角色卡「${name}」${lengthNote === '' ? '' : `（${lengthNote}）`}`,
    },
  };
}

function parseWorldBookDraft(args: Record<string, unknown>, context: AdminToolContext): AdminToolParseResult {
  const name = text(args.name);
  if (name === '') return { ok: false, error: 'name 不能为空' };

  const rawId = text(args.bookId);
  const known = context.knownBookIds;
  const base = rawId === '' ? null : (context.worldBooks?.find((book) => book.id === rawId) ?? null);
  if (rawId !== '' && base === null && known !== undefined && !known.includes(rawId)) {
    return { ok: false, error: `素材库里没有 id 为 ${rawId} 的世界书；要新建就留空 bookId` };
  }

  if (!Array.isArray(args.entries)) return { ok: false, error: 'entries 必须是数组' };

  /*
   * 同名条目复用旧记录（顺序 86，审计 B6）。
   *
   * 模型只能给 title/keys/content/constant/order 这五个字段，而一条条目还有插入位置、
   * 概率、分组、递归设置等十来项——那些是用户在界面上调过的。以前每次「改几个字」都会
   * 重新生成一批条目，这些设置连同条目 id 一起消失；而条目 id 还写进提示词块 id
   * （`worldbook:<书>:<条目>`），换一批等于把调试时的对照关系打散。
   * 同名就当作同一条：只覆盖模型明确给出的那五个字段。
   */
  const reusable = new Map<string, WorldBookEntry[]>();
  for (const entry of base?.entries ?? []) {
    const bucket = reusable.get(entry.title);
    if (bucket === undefined) reusable.set(entry.title, [entry]);
    else bucket.push(entry);
  }

  const entries: WorldBookEntry[] = [];
  for (const [index, item] of args.entries.entries()) {
    const record = asRecord(item);
    if (!record) return { ok: false, error: `entries[${String(index)}] 必须是对象` };

    const content = longText(record.content);
    if (content === '') return { ok: false, error: `entries[${String(index)}].content 不能为空` };

    const keys = Array.isArray(record.keys) ? record.keys.map((key) => text(key)).filter((key) => key !== '') : [];
    const constant = record.constant === true;
    if (!constant && keys.length === 0) {
      return {
        ok: false,
        error: `entries[${String(index)}] 既不是常驻条目又没有 keys：那它永远不会被插入`,
      };
    }

    const order = typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : 100;
    const title = text(record.title) === '' ? (keys[0] ?? name) : text(record.title);
    // 同一个标题在旧书里出现两次时，按顺序一对一认领，不会两条都套到同一条上
    const previous = reusable.get(title)?.shift() ?? null;
    entries.push(
      previous === null
        ? createWorldBookEntry({ title, keys, content, constant, order })
        : { ...previous, title, keys, content, constant, order },
    );
  }

  const now = nowIso();
  const book: WorldBook = {
    id: base?.id ?? (rawId === '' ? asWorldBookId(newId()) : asWorldBookId(rawId)),
    name,
    entries,
    // `extensions`（未识别字段）与 `createdAt` 是这本文档的历史，草稿不该把它们抹掉
    extensions: base?.extensions ?? {},
    createdAt: base?.createdAt ?? now,
    updatedAt: base?.updatedAt ?? now,
    deletedAt: null,
  };

  return {
    ok: true,
    draft: {
      kind: 'world-book',
      bookId: rawId === '' ? null : asWorldBookId(rawId),
      book,
      baseUpdatedAt: base?.updatedAt ?? null,
      summary: `${rawId === '' ? '新建' : '修改'}世界书「${name}」（${String(entries.length)} 条）`,
    },
  };
}

function parsePersonaUpsertDraft(args: Record<string, unknown>, context: AdminToolContext): AdminToolParseResult {
  const name = text(args.name);
  const description = longText(args.description);
  if (name === '') return { ok: false, error: 'name 不能为空' };
  if (description === '') return { ok: false, error: 'description 不能为空' };

  const rawId = text(args.personaId);
  const known = context.knownPersonas;
  const previous = rawId === '' ? null : (known?.find((persona) => persona.id === rawId) ?? null);
  if (rawId !== '' && known !== undefined && previous === null) {
    return { ok: false, error: `账户里没有 id 为 ${rawId} 的玩家身份；要新建就留空 personaId` };
  }

  const now = nowIso();
  const persona: Persona = {
    id: rawId === '' ? newId() : rawId,
    name,
    description,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
  };

  return {
    ok: true,
    draft: {
      kind: 'persona-upsert',
      personaId: rawId === '' ? null : rawId,
      persona,
      previous,
      summary: `${rawId === '' ? '新建' : '修改'}玩家身份「${name}」`,
    },
  };
}

function parsePersonaDeleteDraft(args: Record<string, unknown>, context: AdminToolContext): AdminToolParseResult {
  const personaId = text(args.personaId);
  const confirmName = text(args.confirmName);
  if (personaId === '') return { ok: false, error: 'personaId 不能为空' };
  if (confirmName === '') return { ok: false, error: 'confirmName 不能为空' };

  const known = context.knownPersonas;
  const persona = known?.find((item) => item.id === personaId) ?? null;
  if (known !== undefined && persona === null) {
    return { ok: false, error: `账户里没有 id 为 ${personaId} 的玩家身份` };
  }
  if (persona !== null && persona.name !== confirmName) {
    return { ok: false, error: `confirmName 与身份当前名字不一致；要删除请写「${persona.name}」` };
  }

  return {
    ok: true,
    draft: {
      kind: 'persona-delete',
      personaId,
      name: persona?.name ?? confirmName,
      summary: `彻底删除玩家身份「${persona?.name ?? confirmName}」（等待用户确认）`,
    },
  };
}

function parseSceneDraft(args: Record<string, unknown>): AdminToolParseResult {
  const patch: Partial<Scene> = {};

  if (typeof args.title === 'string') patch.title = args.title.trim();
  if (typeof args.location === 'string') patch.location = args.location.trim();
  if (typeof args.worldTime === 'string') patch.worldTime = args.worldTime.trim();
  if (typeof args.summary === 'string') patch.summary = args.summary.trim();

  if (args.castPolicy !== undefined) {
    const policy = text(args.castPolicy) as CastPolicy;
    if (!CAST_POLICIES.includes(policy)) {
      return { ok: false, error: `castPolicy 只能是 ${CAST_POLICIES.join(' / ')}` };
    }
    patch.castPolicy = policy;
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: '至少要给一个字段' };

  const parts: string[] = [];
  if (patch.title !== undefined) parts.push(`名字「${patch.title}」`);
  if (patch.location !== undefined) parts.push(`地点「${patch.location}」`);
  if (patch.worldTime !== undefined) parts.push(`时间「${patch.worldTime}」`);
  if (patch.summary !== undefined) parts.push('场景设定');
  if (patch.castPolicy !== undefined) parts.push(`入场策略 ${patch.castPolicy}`);

  return { ok: true, draft: { kind: 'scene', patch, summary: `设置当前场景：${parts.join('、')}` } };
}

/**
 * 把一次工具调用解析成结构化草稿。
 *
 * 返回的是结果而不是抛异常：**校验失败也是一条要回填给模型的工具结果**。
 * 模型看到「cardId 不存在」就会改用新建，这比在界面上弹一个错误有用得多。
 */
/**
 * 每件工具认得的参数（多出来的会在结果里回填给模型；顺序 67）。
 *
 * 顺序 90：`scenario` / `firstMessage` / `alternateGreetings` / `exampleMessages` /
 * `systemPrompt` 已从卡上删掉，这里也一并移出——模型若还在传，会作为「不认得的参数」
 * 回填给它，让它改掉；列在这里反而会让它以为这些字段仍然有效。
 */
const KNOWN_ARGS: Record<AdminToolName, readonly string[]> = {
  upsert_character_card: ['name', 'cardId', 'description', 'nickname', 'personality', 'tags'],
  upsert_world_book: ['name', 'bookId', 'entries'],
  upsert_persona: ['name', 'description', 'personaId'],
  delete_persona: ['personaId', 'confirmName'],
  set_scene: ['title', 'location', 'worldTime', 'summary', 'castPolicy'],
};

/** 世界书条目里认得的那几个键（条目里多写的也要说一声）。 */
const KNOWN_ENTRY_ARGS: readonly string[] = ['title', 'keys', 'content', 'constant', 'order'];

function unknownArgsOf(args: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(args)
    .filter((key) => !known.includes(key))
    .sort();
}

export function parseAdminToolCall(call: ChatToolCall, context: AdminToolContext = {}): AdminToolParseResult {
  const name = call.function.name as AdminToolName;
  const parsed = parseJsonArguments(call.function.arguments);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const result = ((): AdminToolParseResult => {
    switch (name) {
      case 'upsert_character_card':
        return parseCardDraft(parsed.value, context);
      case 'upsert_world_book':
        return parseWorldBookDraft(parsed.value, context);
      case 'upsert_persona':
        return parsePersonaUpsertDraft(parsed.value, context);
      case 'delete_persona':
        return parsePersonaDeleteDraft(parsed.value, context);
      case 'set_scene':
        return parseSceneDraft(parsed.value);
      default:
        return { ok: false, error: `没有名为 ${call.function.name} 的工具` };
    }
  })();

  if (!result.ok) return result;

  const extra = unknownArgsOf(parsed.value, KNOWN_ARGS[name] ?? []);
  if (name === 'upsert_world_book' && Array.isArray(parsed.value.entries)) {
    for (const [index, item] of parsed.value.entries.entries()) {
      const record = asRecord(item);
      if (record === null) continue;
      for (const key of unknownArgsOf(record, KNOWN_ENTRY_ARGS)) extra.push(`entries[${String(index)}].${key}`);
    }
  }

  return extra.length === 0 ? result : { ...result, unknownArgs: extra };
}
