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

/**
 * 副对话的工具集（LAYOUT 待确认第 4 条：先只做三件）。
 *
 * 三件事都对应一种素材：角色卡、世界书、当前场景。刻意不多给——
 * 管理员的职责是「帮你起草素材」，不是「替你玩这个游戏」。
 */
export type AdminToolName =
  | 'upsert_character_card'
  | 'upsert_world_book'
  | 'upsert_persona'
  | 'delete_persona'
  | 'set_scene';

export const ADMIN_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'upsert_character_card',
      description:
        '起草或修改一张角色卡。改动只是草稿，用户点「采纳」之后才会进入素材库；' + '修改已有的卡时必须带上 cardId。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '修改已有角色卡时填它的 id；新建时留空' },
          name: { type: 'string', description: '角色名' },
          nickname: { type: 'string', description: '角色对玩家的自称，可留空' },
          description: { type: 'string', description: '外貌、身份、来头' },
          personality: { type: 'string', description: '性格' },
          scenario: { type: 'string', description: '出场场景设定' },
          firstMessage: { type: 'string', description: '开场白' },
          exampleMessages: { type: 'string', description: '对话风格示例' },
          systemPrompt: { type: 'string', description: '额外的人设指令，可留空' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        },
        required: ['name', 'description'],
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
        '并且 entries 是**整本替换**：原有条目要一并写回，不要只交新增的那几条。',
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
  summary: string;
}

export interface WorldBookDraft {
  kind: 'world-book';
  bookId: WorldBookId | null;
  book: WorldBook;
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

export type AdminToolParseResult = { ok: true; draft: AdminDraft } | { ok: false; error: string };

export interface AdminToolContext {
  /** 素材库里已有的卡与世界书，用来校验 cardId / bookId。 */
  knownCardIds?: readonly string[];
  knownBookIds?: readonly string[];
  /** 当前账户里的 Persona；删除时用 name 做二次确认。 */
  knownPersonas?: readonly Persona[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 取一段自由文本，容忍模型把多行内容写成数组。
 *
 * 真实模型验证里 `exampleMessages` 就被写成了字符串数组（其实是它更自然的表达）。
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
  const name = text(args.name);
  const description = longText(args.description);
  if (name === '') return { ok: false, error: 'name 不能为空' };
  if (description === '') return { ok: false, error: 'description 不能为空' };

  const rawId = text(args.cardId);
  const known = context.knownCardIds;
  if (rawId !== '' && known !== undefined && !known.includes(rawId)) {
    return { ok: false, error: `素材库里没有 id 为 ${rawId} 的角色卡；要新建就留空 cardId` };
  }

  const alternateGreetings = Array.isArray(args.alternateGreetings)
    ? args.alternateGreetings.map((item) => text(item)).filter((item) => item !== '')
    : [];
  const tags = Array.isArray(args.tags) ? args.tags.map((item) => text(item)).filter((item) => item !== '') : [];

  const overrides: Partial<Card> = {
    name,
    nickname: longText(args.nickname),
    description,
    personality: longText(args.personality),
    scenario: longText(args.scenario),
    firstMessage: longText(args.firstMessage),
    alternateGreetings,
    exampleMessages: longText(args.exampleMessages),
    systemPrompt: longText(args.systemPrompt),
    tags,
    source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: new Date().toISOString() },
  };
  // 只有修改已有卡时才覆盖 id：写成 `id: undefined` 会把新生成的 id 抹掉
  if (rawId !== '') overrides.id = asCardId(rawId);

  const card = createBlankCard(overrides);

  return {
    ok: true,
    draft: {
      kind: 'character-card',
      cardId: rawId === '' ? null : asCardId(rawId),
      card,
      summary: `${rawId === '' ? '新建' : '修改'}角色卡「${name}」`,
    },
  };
}

function parseWorldBookDraft(args: Record<string, unknown>, context: AdminToolContext): AdminToolParseResult {
  const name = text(args.name);
  if (name === '') return { ok: false, error: 'name 不能为空' };

  const rawId = text(args.bookId);
  const known = context.knownBookIds;
  if (rawId !== '' && known !== undefined && !known.includes(rawId)) {
    return { ok: false, error: `素材库里没有 id 为 ${rawId} 的世界书；要新建就留空 bookId` };
  }

  if (!Array.isArray(args.entries)) return { ok: false, error: 'entries 必须是数组' };

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
    entries.push(
      createWorldBookEntry({
        title: text(record.title) === '' ? (keys[0] ?? name) : text(record.title),
        keys,
        content,
        constant,
        order,
      }),
    );
  }

  const book: WorldBook = {
    id: rawId === '' ? asWorldBookId(newId()) : asWorldBookId(rawId),
    name,
    entries,
    extensions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };

  return {
    ok: true,
    draft: {
      kind: 'world-book',
      bookId: rawId === '' ? null : asWorldBookId(rawId),
      book,
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
export function parseAdminToolCall(call: ChatToolCall, context: AdminToolContext = {}): AdminToolParseResult {
  const name = call.function.name as AdminToolName;
  const parsed = parseJsonArguments(call.function.arguments);
  if (!parsed.ok) return { ok: false, error: parsed.error };

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
}
