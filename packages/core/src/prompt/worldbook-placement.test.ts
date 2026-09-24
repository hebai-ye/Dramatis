import { describe, expect, it } from 'vitest';
import type { WorldBookMatch } from '../compat/sillytavern/worldbook.js';
import { createBlankCard, SelectiveLogic, type WorldBookEntry, type WorldBookPosition } from '../model/card.js';
import { createPersona } from '../model/persona.js';
import { createWorldFromCard } from '../session/setup.js';
import { createPlayerMessage } from '../session/turn.js';
import { assemblePrompt } from './assemble.js';

/**
 * 世界书的插入位置语义（顺序 60）。
 *
 * 这里量的是「落点」：同一个条目换一个 `position`，它出现在 prompt 的哪一段。
 * 匹配那一层（scanDepth / 递归 / group）的单测在
 * `compat/sillytavern/worldbook.test.ts`。
 */
function fixtures() {
  const persona = createPersona({ name: '旅人', description: '跑码头的行商' });
  const card = createBlankCard({
    name: '秦娘',
    description: '客栈老板娘，记账一绝。',
    personality: '爽利，嘴上不饶人，心里有数。',
    scenario: '码头边的老客栈。',
  });
  // 沿用产品里的同一套建世界逻辑，避免手写字段形状漂移
  const world = createWorldFromCard(card, persona);
  return { card, persona, room: world.room, scene: world.scene, instance: world.instance };
}

function entry(position: WorldBookPosition, depth = 4): WorldBookEntry {
  return {
    id: `entry-${position}-${String(depth)}`,
    title: '位置探针',
    keys: [],
    secondaryKeys: [],
    content: '这段设定应该出现在被指定的位置上。',
    constant: true,
    selective: true,
    selectiveLogic: SelectiveLogic.AND_ANY,
    order: 100,
    position,
    depth,
    probability: 100,
    useProbability: true,
    disabled: false,
    caseSensitive: false,
    matchWholeWords: false,
    scanDepth: null,
    preventRecursion: true,
    excludeRecursion: false,
    group: '',
    extensions: {},
  };
}

function match(position: WorldBookPosition, depth = 4): WorldBookMatch {
  return { entry: entry(position, depth), matchedKeys: [], reason: 'constant', round: 1 };
}

function historyLines(...contents: string[]) {
  return contents.map((content, index) => {
    const { room, scene } = fixtures();
    return createPlayerMessage({
      roomId: room.id,
      sceneId: scene.id,
      turnId: `turn-${String(index)}`,
      speakerName: room.playerName,
      content,
    });
  });
}

const PROBE = '这段设定应该出现在被指定的位置上。';

describe('世界书落点：人设前后（顺序 60）', () => {
  it('before_char 落进人设之前，default/unknown 与它同一个位置', () => {
    for (const position of ['before_char', 'unknown'] as const) {
      const { card, instance, room, scene } = fixtures();
      const prompt = assemblePrompt({
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '嗨',
        worldBookMatches: [match(position)],
        budget: { maxTokens: 8000, reserveForReply: 1000 },
      });

      const system = prompt.messages[0]?.content ?? '';
      expect(system).toContain(PROBE);
      // 人设块的正文是卡上的 description
      expect(system.indexOf(PROBE)).toBeLessThan(system.indexOf('记账一绝'));
    }
  });

  it('after_char 落进人设之后、关系之前', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      worldBookMatches: [match('after_char')],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system.indexOf(PROBE)).toBeGreaterThan(system.indexOf('记账一绝'));
    // 关系块紧跟在人设后面，所以 after_char 必须排在它前面
    expect(system.indexOf(PROBE)).toBeLessThan(system.indexOf('信任'));
  });
});

describe('世界书落点：场景前后（顺序 60）', () => {
  it('before_an 落进「当前场景」之前，after_an 落在它之后', () => {
    const before = fixtures();
    const beforePrompt = assemblePrompt({
      card: before.card,
      instance: before.instance,
      room: before.room,
      scene: before.scene,
      history: [],
      playerInput: '嗨',
      worldBookMatches: [match('before_an')],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });
    const beforeSystem = beforePrompt.messages[0]?.content ?? '';
    expect(beforeSystem.indexOf(PROBE)).toBeLessThan(beforeSystem.indexOf('当前场景'));

    const after = fixtures();
    const afterPrompt = assemblePrompt({
      card: after.card,
      instance: after.instance,
      room: after.room,
      scene: after.scene,
      history: [],
      playerInput: '嗨',
      worldBookMatches: [match('after_an')],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });
    const afterSystem = afterPrompt.messages[0]?.content ?? '';
    expect(afterSystem.indexOf(PROBE)).toBeGreaterThan(afterSystem.indexOf('当前场景'));
  });
});

describe('世界书落点：at_depth（顺序 60）', () => {
  it('不走 system 提示，而是插到历史倒数第 depth 条之前', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: historyLines('一句', '二句', '三句', '四句', '五句', '六句'),
      playerInput: '现在呢？',
      worldBookMatches: [match('at_depth', 2)],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    // 第一条 system 里不该有它
    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.messages[0]?.content).not.toContain(PROBE);

    // 历史 6 条、depth 2 → 插在第 5 条（「五句」）之前
    const inserted = prompt.messages.findIndex((message) => message.content.includes(PROBE));
    expect(prompt.messages[inserted]?.role).toBe('system');
    expect(prompt.messages[inserted + 1]?.content).toBe('五句');
    expect(prompt.messages[inserted - 1]?.content).toBe('四句');
    // 两条 system（大提示 + 插进来的那条），最后一条仍是玩家这一句
    expect(prompt.messages.filter((message) => message.role === 'system')).toHaveLength(2);
    expect(prompt.messages.at(-1)?.content).toBe('现在呢？');
  });

  it('depth 比历史还长时插在最前面；depth 为 0 时插在最后一条之后', () => {
    const deep = fixtures();
    const deepPrompt = assemblePrompt({
      card: deep.card,
      instance: deep.instance,
      room: deep.room,
      scene: deep.scene,
      history: historyLines('一句', '二句'),
      playerInput: '现在呢？',
      worldBookMatches: [match('at_depth', 99)],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });
    expect(deepPrompt.messages[1]?.content).toContain(PROBE);
    expect(deepPrompt.messages[2]?.content).toBe('一句');

    const shallow = fixtures();
    const shallowPrompt = assemblePrompt({
      card: shallow.card,
      instance: shallow.instance,
      room: shallow.room,
      scene: shallow.scene,
      history: historyLines('一句', '二句'),
      playerInput: '现在呢？',
      worldBookMatches: [match('at_depth', 0)],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });
    const last = shallowPrompt.messages;
    expect(last[last.length - 1]?.content).toBe('现在呢？');
    expect(last[last.length - 2]?.content).toContain(PROBE);
    expect(last[last.length - 2]?.role).toBe('system');
  });
});

describe('世界书落点：默认位置的提示词形状没变（顺序 60）', () => {
  it('默认位置的多条命中仍然只出现一个小节', () => {
    const { card, instance, room, scene } = fixtures();
    const second: WorldBookMatch = {
      entry: { ...entry('unknown'), id: 'entry-second', title: '第二条', content: '第二条设定的正文。' },
      matchedKeys: [],
      reason: 'constant',
      round: 1,
    };
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      worldBookMatches: [match('unknown'), second],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system.match(/### 世界设定/g)).toHaveLength(1);
    expect(system).toContain('【位置探针】');
    expect(system).toContain('【第二条】');
  });
});

describe('世界书落点：预算降级按 order 丢（顺序 60）', () => {
  it('同一次装配里，order 低的条目优先级更低（预算守卫先丢它）', () => {
    const { card, instance, room, scene } = fixtures();
    const low: WorldBookMatch = {
      entry: { ...entry('unknown'), id: 'entry-low', title: '低优先', order: 1, content: '低优先的正文。' },
      matchedKeys: [],
      reason: 'constant',
      round: 1,
    };
    const high: WorldBookMatch = {
      entry: { ...entry('unknown'), id: 'entry-high', title: '高优先', order: 900, content: '高优先的正文。' },
      matchedKeys: [],
      reason: 'constant',
      round: 1,
    };

    const blocksWith = (matches: WorldBookMatch[]) =>
      assemblePrompt({
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '嗨',
        worldBookMatches: matches,
        budget: { maxTokens: 8000, reserveForReply: 1000 },
      }).blocks.filter((block) => block.kind === 'worldbook');

    const both = blocksWith([low, high]);
    expect(both).toHaveLength(2);
    const priorityOf = (title: string): number =>
      both.find((block) => block.content.includes(`【${title}】`))?.priority ?? -1;
    expect(priorityOf('低优先')).toBeLessThan(priorityOf('高优先'));
    // 世界书的这一档整体仍然低于场景与人设（不会把场景挤掉）
    const scenePriority = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      worldBookMatches: [high],
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    }).blocks.find((block) => block.kind === 'scene')?.priority;
    expect(priorityOf('高优先')).toBeLessThan(scenePriority ?? 0);
  });
});
