import { describe, expect, it } from 'vitest';
import {
  type Card,
  type CardSource,
  createBlankCard,
  createBlankWorldBook,
  createWorldBookEntry,
  DEFAULT_CARD_SYSTEM_PROMPT,
} from '../model/card.js';
import { newId } from '../model/ids.js';
import { createPersona } from '../model/persona.js';
import type { ChatToolCall } from '../prompt/types.js';
import { ADMIN_TOOLS, parseAdminToolCall } from './tools.js';

function call(name: string, args: unknown): ChatToolCall {
  return {
    id: newId(),
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

describe('工具声明', () => {
  it('只暴露约定好的五件工具', () => {
    expect(ADMIN_TOOLS.map((tool) => tool.function.name)).toEqual([
      'upsert_character_card',
      'upsert_world_book',
      'upsert_persona',
      'delete_persona',
      'set_scene',
    ]);
  });
});

describe('upsert_character_card', () => {
  it('新建时生成新 id，并带上全部人设字段', () => {
    const result = parseAdminToolCall(
      call('upsert_character_card', {
        name: '酒馆老板',
        description: '旧城东侧酒馆的老板',
        personality: '爽朗',
        firstMessage: '欢迎光临。',
        tags: ['酒馆', ''],
      }),
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.draft.kind).toBe('character-card');
    if (result.draft.kind !== 'character-card') return;

    expect(result.draft.cardId).toBeNull();
    expect(result.draft.card.name).toBe('酒馆老板');
    expect(result.draft.card.tags).toEqual(['酒馆']);
    expect(result.draft.card.id).toBeTruthy();
    expect(result.draft.card.systemPrompt).toBe(DEFAULT_CARD_SYSTEM_PROMPT);
  });

  it('修改已有卡时沿用传入的 id', () => {
    const existing = newId();
    const result = parseAdminToolCall(
      call('upsert_character_card', { cardId: existing, name: '老板', description: '改过的设定' }),
      { knownCardIds: [existing] },
    );

    if (!result.ok) throw new Error(result.error);
    if (result.draft.kind !== 'character-card') throw new Error('类型不对');
    expect(result.draft.card.id).toBe(existing);
    expect(result.draft.summary).toContain('修改');
  });

  it('引用不存在的卡时说清楚原因，而不是默默新建', () => {
    const result = parseAdminToolCall(
      call('upsert_character_card', { cardId: 'missing', name: '老板', description: 'x' }),
      { knownCardIds: [] },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('没有 id 为 missing 的角色卡');
  });

  it('缺字段与坏 JSON 都是可回填的错误', () => {
    const missing = parseAdminToolCall(call('upsert_character_card', { name: '只有名字' }));
    expect(missing.ok).toBe(false);

    const broken = parseAdminToolCall(call('upsert_character_card', '{不是 JSON'));
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error).toContain('不是合法 JSON');
  });

  it('多行字段被写成数组时按行拼回来，而不是静默丢掉', () => {
    // 真实模型验证里 exampleMessages 就是数组形态，丢掉它用户是看不见的
    const result = parseAdminToolCall(
      call('upsert_character_card', {
        name: '老周',
        description: ['摆渡人，五十多岁。', '白天撑船，天黑后停在东岸。'],
        exampleMessages: ['「河上今晚没人。」他慢慢说。', '「你要过河，等天亮。」'],
      }),
    );

    if (!result.ok) throw new Error(result.error);
    if (result.draft.kind !== 'character-card') throw new Error('类型不对');
    expect(result.draft.card.description).toBe('摆渡人，五十多岁。\n白天撑船，天黑后停在东岸。');
    expect(result.draft.card.exampleMessages).toBe('「河上今晚没人。」他慢慢说。\n「你要过河，等天亮。」');
  });

  it('多写的参数不再静默丢掉（顺序 67）', () => {
    const extra = parseAdminToolCall(
      call('upsert_character_card', { name: '秦娘', description: '货栈掌柜。', temper: '冷', age: 40 }),
    );

    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    expect(extra.unknownArgs).toEqual(['age', 'temper']);

    // 规矩写对了就一条也不提
    const clean = parseAdminToolCall(call('set_scene', { location: '旧城' }));
    expect(clean.ok && clean.unknownArgs).toBeUndefined();
  });
});

describe('upsert_world_book', () => {
  it('条目里多写的字段也点出来（带下标）', () => {
    const result = parseAdminToolCall(
      call('upsert_world_book', {
        name: '旧城',
        entries: [{ keys: ['旧城'], content: '城墙是青的。', colour: '青' }],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownArgs).toEqual(['entries[0].colour']);
  });

  it('把条目整理成可用的世界书', () => {
    const result = parseAdminToolCall(
      call('upsert_world_book', {
        name: '旧城设定',
        entries: [
          { keys: ['旧城', '城区'], content: '旧城分东西两半。', title: '旧城' },
          { content: '雨一直在下。', constant: true },
        ],
      }),
    );

    if (!result.ok) throw new Error(result.error);
    if (result.draft.kind !== 'world-book') throw new Error('类型不对');

    expect(result.draft.book.entries).toHaveLength(2);
    expect(result.draft.book.entries[0]?.keys).toEqual(['旧城', '城区']);
    expect(result.draft.book.entries[1]?.constant).toBe(true);
    // 标题缺省时用第一个关键词兜底，免得列表里全是「未命名条目」
    expect(result.draft.book.entries[0]?.title).toBe('旧城');
  });

  it('既非常驻又没有关键词的条目会被拦下来', () => {
    const result = parseAdminToolCall(
      call('upsert_world_book', { name: 'x', entries: [{ content: '永远不会被插入的设定' }] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('永远不会被插入');
  });

  it('entries 不是数组时报错', () => {
    expect(parseAdminToolCall(call('upsert_world_book', { name: 'x', entries: 'oops' })).ok).toBe(false);
  });
});

describe('玩家身份工具', () => {
  it('新建 Persona 草稿，修改时沿用旧 id 与创建时间', () => {
    const existing = createPersona({ name: '旅人', description: '四处漂泊' });
    const created = parseAdminToolCall(call('upsert_persona', { name: '沈砚', description: '旧信的主人' }));
    if (!created.ok) throw new Error(created.error);
    if (created.draft.kind !== 'persona-upsert') throw new Error('类型不对');
    expect(created.draft.personaId).toBeNull();
    expect(created.draft.persona.name).toBe('沈砚');

    const updated = parseAdminToolCall(
      call('upsert_persona', { personaId: existing.id, name: '沈砚', description: '旧信的主人' }),
      { knownPersonas: [existing] },
    );
    if (!updated.ok) throw new Error(updated.error);
    if (updated.draft.kind !== 'persona-upsert') throw new Error('类型不对');
    expect(updated.draft.persona.id).toBe(existing.id);
    expect(updated.draft.persona.createdAt).toBe(existing.createdAt);
    expect(updated.draft.previous?.name).toBe('旅人');
  });

  it('删除必须用当前名字二次确认', () => {
    const existing = createPersona({ name: '沈砚', description: '旧信的主人' });
    const wrong = parseAdminToolCall(call('delete_persona', { personaId: existing.id, confirmName: '旅人' }), {
      knownPersonas: [existing],
    });
    expect(wrong.ok).toBe(false);

    const right = parseAdminToolCall(call('delete_persona', { personaId: existing.id, confirmName: '沈砚' }), {
      knownPersonas: [existing],
    });
    if (!right.ok) throw new Error(right.error);
    expect(right.draft.kind).toBe('persona-delete');
  });
});

describe('set_scene', () => {
  it('只带上真正要改的字段', () => {
    const result = parseAdminToolCall(
      call('set_scene', { location: '旧城东侧的夜间酒馆', worldTime: '第三日 · 黄昏' }),
    );

    if (!result.ok) throw new Error(result.error);
    if (result.draft.kind !== 'scene') throw new Error('类型不对');

    expect(result.draft.patch).toEqual({ location: '旧城东侧的夜间酒馆', worldTime: '第三日 · 黄昏' });
  });

  it('入场策略必须是四种之一', () => {
    const good = parseAdminToolCall(call('set_scene', { castPolicy: 'locked' }));
    expect(good.ok).toBe(true);

    const bad = parseAdminToolCall(call('set_scene', { castPolicy: '随便' }));
    expect(bad.ok).toBe(false);
  });

  it('一个字段都不给就报错，避免产生空改动', () => {
    expect(parseAdminToolCall(call('set_scene', {})).ok).toBe(false);
  });
});

describe('未知工具', () => {
  it('明确回一句话告诉模型这个工具不存在', () => {
    const result = parseAdminToolCall(call('delete_world', { id: 'x' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('没有名为 delete_world 的工具');
  });
});

/*
 * 审计 B6：修改已有素材时**必须**以现有内容为底做字段级合并。
 * 以前无论新建还是修改都从一张空白卡起，模型没提到的字段全被空值覆盖：
 * 开场白、示例对话、标签、导入来源、创建时间……用户看不到报错，只会发现卡少了一半。
 */
describe('upsert_character_card · 审计 B6（改卡以现有卡为底）', () => {
  const IMPORTED: CardSource = {
    kind: 'png',
    spec: 'chara_card_v2',
    specVersion: '2.0',
    importedAt: '2026-01-01T00:00:00.000Z',
    fileName: 'boss.png',
  };

  function existingCard(): Card {
    return createBlankCard({
      name: '酒馆老板',
      nickname: '老板',
      description: '旧城东侧酒馆的老板',
      personality: '豪爽',
      scenario: '酒馆打烊后',
      firstMessage: '欢迎光临。',
      alternateGreetings: ['又来啦？'],
      exampleMessages: '「喝什么？」',
      tags: ['酒馆', '旧城'],
      systemPrompt: '说话短一点。',
      creator: '原作者',
      extensions: { custom: 1 },
      source: IMPORTED,
      createdAt: '2026-02-02T00:00:00.000Z',
      updatedAt: '2026-02-03T00:00:00.000Z',
    });
  }

  function edit(args: Record<string, unknown>, card: Card) {
    return parseAdminToolCall(call('upsert_character_card', { cardId: card.id, ...args }), { cards: [card] });
  }

  function draftCardOf(result: ReturnType<typeof parseAdminToolCall>): Card {
    if (!result.ok) throw new Error(result.error);
    if (result.draft.kind !== 'character-card') throw new Error('类型不对');
    return result.draft.card;
  }

  it('只写一个字段时，其余字段（开场白、示例、标签、来源、创建时间）全都保持原样', () => {
    const card = existingCard();

    const draft = draftCardOf(edit({ personality: '沉默' }, card));

    expect(draft.personality).toBe('沉默');
    expect(draft.firstMessage).toBe('欢迎光临。');
    expect(draft.alternateGreetings).toEqual(['又来啦？']);
    expect(draft.exampleMessages).toBe('「喝什么？」');
    expect(draft.tags).toEqual(['酒馆', '旧城']);
    expect(draft.nickname).toBe('老板');
    expect(draft.systemPrompt).toBe('说话短一点。');
    expect(draft.creator).toBe('原作者');
    expect(draft.extensions).toEqual({ custom: 1 });
    expect(draft.source).toEqual(IMPORTED);
    expect(draft.createdAt).toBe('2026-02-02T00:00:00.000Z');
    expect(draft.id).toBe(card.id);
  });

  it('省掉 name/description 也算改；但新建时它们仍然必填', () => {
    const card = existingCard();

    const draft = draftCardOf(edit({ scenario: '雨夜' }, card));

    expect(draft.scenario).toBe('雨夜');
    expect(draft.name).toBe('酒馆老板');
    expect(draft.description).toBe('旧城东侧酒馆的老板');

    expect(parseAdminToolCall(call('upsert_character_card', { name: '只有名字' })).ok).toBe(false);
  });

  it('显式空串表示清空，null 表示「没提」', () => {
    const card = existingCard();

    const draft = draftCardOf(edit({ firstMessage: '', nickname: null }, card));

    expect(draft.firstMessage).toBe('');
    expect(draft.nickname).toBe('老板');
  });

  it('数组字段：给了就整份替换（空数组 = 清空），没给就保持原样', () => {
    const card = existingCard();

    const draft = draftCardOf(edit({ tags: [] }, card));

    expect(draft.tags).toEqual([]);
    expect(draft.alternateGreetings).toEqual(['又来啦？']);
  });

  it('草稿带上下手时的版本号，采纳路径才知道它有没有过期', () => {
    const card = existingCard();

    const edited = edit({ personality: '沉默' }, card);
    if (!edited.ok || edited.draft.kind !== 'character-card') throw new Error('类型不对');
    expect(edited.draft.baseUpdatedAt).toBe('2026-02-03T00:00:00.000Z');

    const fresh = parseAdminToolCall(call('upsert_character_card', { name: '新人', description: 'x' }));
    if (!fresh.ok || fresh.draft.kind !== 'character-card') throw new Error('类型不对');
    expect(fresh.draft.baseUpdatedAt).toBeNull();
  });

  it('alternateGreetings 真的进了工具声明（以前只有参数名、schema 里没有）', () => {
    const tool = ADMIN_TOOLS.find((item) => item.function.name === 'upsert_character_card');
    const parameters = tool?.function.parameters as { properties?: Record<string, unknown> } | undefined;

    expect(Object.keys(parameters?.properties ?? {})).toContain('alternateGreetings');
  });
});

describe('upsert_world_book · 审计 B6（改书时保留历史与条目设置）', () => {
  it('保留创建时间与未识别字段；同名条目沿用原 id 与用户调过的设置', () => {
    const entry = createWorldBookEntry({ title: '旧城', keys: ['旧城'], content: '城墙是青的。' });
    // 用户在界面上调过的两项：插到深处、只在 60% 的时候插入
    entry.position = 'at_depth';
    entry.probability = 60;

    const book = createBlankWorldBook('旧城设定');
    book.entries = [entry];
    book.extensions = { custom: 'keep' };
    book.createdAt = '2026-02-02T00:00:00.000Z';
    book.updatedAt = '2026-02-03T00:00:00.000Z';

    const result = parseAdminToolCall(
      call('upsert_world_book', {
        bookId: book.id,
        name: '旧城设定',
        entries: [
          { title: '旧城', keys: ['旧城'], content: '城墙是青的，雨里有苔。' },
          { keys: ['码头'], content: '码头在东门外。' },
        ],
      }),
      { worldBooks: [book] },
    );

    if (!result.ok) throw new Error(result.error);
    if (result.draft.kind !== 'world-book') throw new Error('类型不对');
    const draft = result.draft.book;

    expect(draft.createdAt).toBe('2026-02-02T00:00:00.000Z');
    expect(draft.extensions).toEqual({ custom: 'keep' });
    expect(draft.entries[0]?.id).toBe(entry.id);
    expect(draft.entries[0]?.content).toBe('城墙是青的，雨里有苔。');
    expect(draft.entries[0]?.position).toBe('at_depth');
    expect(draft.entries[0]?.probability).toBe(60);
    // 新条目拿新 id，不会蹭到旧条目的身份
    expect(draft.entries[1]?.id).not.toBe(entry.id);
    expect(result.draft.baseUpdatedAt).toBe('2026-02-03T00:00:00.000Z');
  });
});
