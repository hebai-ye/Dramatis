import { describe, expect, it } from 'vitest';
import type { TokenCounter } from '../token/estimate.js';
import { applyBudget } from './budget.js';
import type { PromptBlock } from './types.js';

/** 让每个字符都算一个 token，测试里的数字就是字符数。 */
const counter: TokenCounter = { name: 'test', count: (text) => text.length };

function history(sequence: number, length: number): PromptBlock {
  return {
    id: `history:${String(sequence)}`,
    kind: 'history',
    label: `第 ${String(sequence)} 条`,
    content: 'x'.repeat(length),
    priority: 300,
    droppable: true,
    sequence,
  };
}

function memory(id: string, score: number, length: number): PromptBlock {
  return {
    id: `memory:${id}`,
    kind: 'memory',
    label: id,
    content: 'x'.repeat(length),
    priority: 300 + Math.round(score * 200),
    droppable: true,
    score,
  };
}

const system: PromptBlock = {
  id: 'system',
  kind: 'system',
  label: '规则',
  content: 'x'.repeat(50),
  priority: 1000,
  droppable: false,
};

describe('applyBudget', () => {
  it('预算充裕时不动任何块', () => {
    const blocks = [system, history(0, 10), history(1, 10)];
    const { blocks: kept, report } = applyBudget(blocks, { maxTokens: 10_000, counter });

    expect(kept).toHaveLength(3);
    expect(report.stages).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(report.fits).toBe(true);
  });

  it('第一级先丢最旧的历史', () => {
    const blocks = [system, history(0, 100), history(1, 100), history(2, 100)];
    const { blocks: kept, report } = applyBudget(blocks, { maxTokens: 250, counter });

    expect(report.stages).toEqual(['drop-history']);
    expect(kept.map((block) => block.id)).toEqual(['system', 'history:1', 'history:2']);
  });

  it('历史丢完仍超预算时，才开始丢低分记忆', () => {
    const blocks = [system, history(0, 100), memory('low', 0.1, 100), memory('high', 0.9, 100)];
    const { blocks: kept, report } = applyBudget(blocks, { maxTokens: 220, counter });

    expect(report.stages).toEqual(['drop-history', 'drop-memory']);
    expect(kept.map((block) => block.id)).toEqual(['system', 'memory:high']);
  });

  it('第三级压缩关系描述而不是丢弃', () => {
    const relationship: PromptBlock = {
      id: 'relationship',
      kind: 'relationship',
      label: '关系',
      content: 'x'.repeat(200),
      compressed: 'x'.repeat(20),
      priority: 400,
      droppable: true,
    };

    const { blocks: kept, report } = applyBudget([system, relationship], { maxTokens: 100, counter });

    expect(report.stages).toEqual(['compress-relationship']);
    expect(report.dropped).toEqual([]);
    expect(report.compressed).toEqual(['relationship']);
    expect(kept[1]?.content).toHaveLength(20);
  });

  it('第四级压缩人设描述', () => {
    const persona: PromptBlock = {
      id: 'persona',
      kind: 'persona',
      label: '角色',
      content: 'x'.repeat(200),
      compressed: 'x'.repeat(20),
      priority: 700,
      droppable: true,
    };

    const { report } = applyBudget([system, persona], { maxTokens: 100, counter });

    expect(report.stages).toEqual(['compress-persona']);
  });

  it('兜底阶段保证一定产出，不会因为超长而失败', () => {
    const blocks = [system, history(0, 500), memory('a', 0.5, 500), { ...system, id: 'extra', droppable: true }];
    const { report } = applyBudget(blocks, { maxTokens: 60, counter });

    expect(report.stages).toContain('drop-lowest-priority');
    expect(report.usedTokens).toBeLessThanOrEqual(60);
  });

  it('不可丢弃的块永远保留', () => {
    const blocks = [system, history(0, 500)];
    const { blocks: kept } = applyBudget(blocks, { maxTokens: 10, counter });

    expect(kept.some((block) => block.id === 'system')).toBe(true);
  });

  it('maxTokens 为 0 时也不抛异常', () => {
    expect(() => applyBudget([system, history(0, 10)], { maxTokens: 0, counter })).not.toThrow();
  });
});
