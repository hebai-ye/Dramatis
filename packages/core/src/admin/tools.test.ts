import { describe, expect, it } from 'vitest';
import { newId } from '../model/ids.js';
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
  it('只暴露约定好的三件工具', () => {
    expect(ADMIN_TOOLS.map((tool) => tool.function.name)).toEqual([
      'upsert_character_card',
      'upsert_world_book',
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
});

describe('upsert_world_book', () => {
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
