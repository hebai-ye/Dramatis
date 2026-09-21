/**
 * 记忆合并的「决定合并哪些」（顺序 27a 第一步）。
 *
 * 这一层必须先在单测里定死：它一旦挑错人，模型就会把「秦娘的账房事」压进
 * 「小满眼里的印象」，而那种错误在界面上几乎看不出来。
 */

import { describe, expect, it } from 'vitest';
import { eventId, instanceId, newId, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { applyConsolidation, buildConsolidationPrompt, isConsolidatable, planConsolidation } from './consolidate.js';

const AT = '2026-09-21T10:00:00.000Z';

function memory(overrides: Partial<MemoryEvent> & { at?: string } = {}): MemoryEvent {
  const { at, ...rest } = overrides;
  return {
    id: eventId(newId()),
    roomId: roomId(newId()),
    conversationId: null,
    sceneId: null,
    timeline: { worldTime: '第一日', sequence: 1 },
    location: '',
    participants: [],
    summary: '一句日常经过',
    observerId: null,
    perception: '',
    importance: 0.3,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: [],
    createdAt: at ?? AT,
    updatedAt: at ?? AT,
    deletedAt: null,
    supersededBy: null,
    supersedes: [],
    consolidatedAt: null,
    lastRecalledAt: null,
    recallCount: 0,
    ...rest,
  };
}

/** 造 n 条相隔一分钟的记忆（同一个视角）。 */
function series(count: number, overrides: Partial<MemoryEvent> = {}): MemoryEvent[] {
  return Array.from({ length: count }, (_, index) =>
    memory({
      ...overrides,
      summary: `第 ${String(index + 1)} 件小事`,
      at: new Date(Date.parse(AT) + index * 60_000).toISOString(),
    }),
  );
}

describe('记忆合并：决定合并哪些（顺序 27a）', () => {
  it('攒不够就不合并（低于阈值时一条都不动）', () => {
    // 显式给 batchSize，免得这条断言跟着默认值（现在是 20）一起变
    expect(planConsolidation(series(39), { threshold: 40, batchSize: 40 })).toEqual([]);
    expect(planConsolidation(series(40), { threshold: 40, batchSize: 40 }).length).toBe(1);
  });

  it('按视角分开：两个角色各攒一批，永远不混成一组', () => {
    const alpha = instanceId(newId());
    const beta = instanceId(newId());
    const alphaMemories = series(45, { observerId: alpha });
    const betaMemories = series(45, { observerId: beta });
    const observerOf = new Map([...alphaMemories, ...betaMemories].map((item) => [item.id, item.observerId] as const));

    const groups = planConsolidation([...alphaMemories, ...betaMemories], {
      // 阈值是**按视角**算的：每个角色各自要攒够 40 条
      threshold: 40,
      batchSize: 20,
      maxGroups: 4,
    });

    // 每人两道（20 条一批，剩下 5 条不够短，跳过）
    expect(groups).toHaveLength(4);
    expect(new Set(groups.map((group) => group.observerId))).toEqual(new Set([alpha, beta]));
    for (const group of groups) {
      expect(group.memoryIds).toHaveLength(20);
      // 一组之内只有一个视角——这是这一条测试真正要守住的东西
      const observers = new Set(group.memoryIds.map((id) => observerOf.get(id)));
      expect(observers.size).toBe(1);
      expect(observers.has(group.observerId)).toBe(true);
    }
  });

  it('重要度高的、钉住的、删掉的、已经合并过的一律不参与', () => {
    const baseline = series(40);
    const dirty = [
      ...baseline.slice(0, 10),
      ...series(10, { importance: 0.9 }),
      ...series(10, { pinned: true }),
      ...series(10, { deletedAt: AT }),
      ...series(10, { supersededBy: eventId(newId()) }),
    ];
    const groups = planConsolidation(dirty, { threshold: 40, batchSize: 100 });
    const picked = new Set(groups.flatMap((group) => group.memoryIds));
    // 只有那 10 条干净的能被挑中（不足 40 条 → 其实一组都不该出）
    expect(picked.size).toBe(0);

    const enough = [...dirty.slice(0, 10), ...series(30)];
    const groups2 = planConsolidation(enough, { threshold: 40, batchSize: 100 });
    const picked2 = groups2.flatMap((group) => group.memoryIds);
    expect(picked2.length).toBe(40); // 10 清白的 + 30 新的
    expect(picked2.every((id) => enough.some((item) => item.id === id && item.importance <= 0.4))).toBe(true);
  });

  it('先合并最旧的那一段（最近的记忆还在剧情里活着）', () => {
    const groups = planConsolidation(series(100), { threshold: 40, batchSize: 40, maxGroups: 1 });
    expect(groups).toHaveLength(1);
    const picked = new Set(groups[0]?.memoryIds);
    // 挑中的是**最早**的 40 条：第一条在、最后一条不在
    const all = series(100);
    void all;
    expect(groups[0]?.from).toBe(AT);
    expect(picked.size).toBe(40);
  });

  it('时间隔太远不放进同一批', () => {
    const first = series(20);
    // 第二批与第一批隔了两天
    const later = Array.from({ length: 20 }, (_, index) =>
      memory({ at: new Date(Date.parse(AT) + 2 * 24 * 3600_000 + index * 60_000).toISOString() }),
    );
    const groups = planConsolidation([...first, ...later], { threshold: 40, batchSize: 100, maxGroups: 2 });
    // 两段都够 20 条（≥ min(threshold,10)），所以是两组，而不是混成一组
    expect(groups).toHaveLength(2);
    expect(groups[0]?.memoryIds).toHaveLength(20);
    expect(groups[1]?.memoryIds).toHaveLength(20);
  });

  it('提示词里有原文、有「只输出 1–3 句」的硬要求，且按时间排序', () => {
    const batch = series(40);
    const groups = planConsolidation(batch, { threshold: 40, batchSize: 40 });
    const group = groups[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    const prompt = buildConsolidationPrompt(group, batch);
    expect(prompt).toContain('第 1 件小事');
    expect(prompt).toContain('1–3 句');
    expect(prompt).toContain('不要编细节');
    // 按时间升序：第 1 件在「第 40 件」之前
    expect(prompt.indexOf('第 1 件小事')).toBeLessThan(prompt.indexOf('第 40 件小事'));
  });

  it('isConsolidatable：判断本身是公开的、可解释的', () => {
    expect(isConsolidatable(memory(), 0.5)).toBe(true);
    expect(isConsolidatable(memory({ importance: 0.6 }), 0.5)).toBe(false);
    expect(isConsolidatable(memory({ pinned: true }), 0.5)).toBe(false);
    expect(isConsolidatable(memory({ importanceLocked: true }), 0.5)).toBe(false);
    expect(isConsolidatable(memory({ deletedAt: AT }), 0.5)).toBe(false);
    expect(isConsolidatable(memory({ consolidatedAt: AT }), 0.5)).toBe(false);
  });
});

describe('记忆合并：把结果落成印象（顺序 27a 第二步）', () => {
  function planFor(batch: MemoryEvent[]) {
    const group = planConsolidation(batch, { threshold: 40, batchSize: 40 })[0];
    if (group === undefined) throw new Error('这一批应当能合并');
    return group;
  }

  it('写出一条印象：带来源、视角跟着原组、重要度封顶 0.6', () => {
    const observer = instanceId(newId());
    const batch = series(40, { observerId: observer, importance: 0.3 });
    const group = planFor(batch);
    const id = eventId(newId());
    const result = applyConsolidation({
      group,
      memories: batch,
      reply: '这半个月我一直在替秦娘瞒着账房的事。',
      impressionId: id,
      now: '2026-09-22T00:00:00.000Z',
    });

    expect(result.impression?.id).toBe(id);
    expect(result.impression?.summary).toBe('这半个月我一直在替秦娘瞒着账房的事。');
    expect(result.impression?.observerId).toBe(observer);
    expect(result.impression?.supersedes).toHaveLength(40);
    expect(result.impression?.importance).toBeLessThanOrEqual(0.6);
    expect(result.impression?.importance).toBeGreaterThan(0.3);
  });

  it('原文一条都不删，只盖两个章（supersededBy / consolidatedAt）', () => {
    const batch = series(40);
    const group = planFor(batch);
    const id = eventId(newId());
    const result = applyConsolidation({ group, memories: batch, reply: '一句话印象。', impressionId: id });

    expect(result.originals).toHaveLength(40);
    for (const original of result.originals) {
      expect(original.supersededBy).toBe(id);
      expect(original.consolidatedAt).not.toBeNull();
      // 正文、重要度这些都不动
      expect(original.summary).not.toBe('');
      expect(original.deletedAt).toBeNull();
    }
  });

  it('模型说「没什么值得记」时不造印象，但原文档照样盖章（不然每轮都会再问一遍）', () => {
    const batch = series(40);
    const group = planFor(batch);
    const result = applyConsolidation({
      group,
      memories: batch,
      reply: '这段时间没有值得单独记住的事。',
    });
    expect(result.impression).toBeNull();
    expect(result.originals.every((item) => item.consolidatedAt !== null)).toBe(true);
    expect(result.originals.every((item) => item.supersededBy === null)).toBe(true);
    expect(result.note).toContain('没有值得单独记住');
  });

  it('代码围栏与超长输出会被清理（一条印象不该是两千字）', () => {
    const batch = series(40);
    const group = planFor(batch);
    const long = `\`\`\`text\n${'很长的一句话。'.repeat(200)}\n\`\`\`\n\n后面还有一段解释，不该进印象。`;
    const result = applyConsolidation({ group, memories: batch, reply: long });
    expect(result.impression?.summary.length).toBeLessThanOrEqual(400);
    expect(result.impression?.summary).not.toContain('```');
    expect(result.impression?.summary).not.toContain('后面还有一段解释');
  });

  it('这一组的原文不在库里时什么都不做（不造空印象）', () => {
    const batch = series(40);
    const group = planFor(batch);
    const result = applyConsolidation({ group, memories: [], reply: '一句话印象。' });
    expect(result.impression).toBeNull();
    expect(result.originals).toEqual([]);
  });
});
