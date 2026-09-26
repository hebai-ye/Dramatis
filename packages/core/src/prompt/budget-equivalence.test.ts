/**
 * 审计 A12：预算守卫改成 O(n) 之后，输出必须与旧实现逐块一致。
 *
 * `legacyApplyBudget` 是改动前的实现原样抄过来的（只作对照，不导出）。
 */
import { describe, expect, it } from 'vitest';
import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import { applyBudget, structuralOverhead } from './budget.js';
import type { BudgetReport, BudgetStage, DroppedBlock, PromptBlock } from './types.js';

function legacyApplyBudget(
  blocks: PromptBlock[],
  options: { maxTokens: number; counter?: TokenCounter },
): { blocks: PromptBlock[]; report: BudgetReport } {
  const counter = options.counter ?? heuristicTokenCounter;
  const maxTokens = Math.max(0, Math.floor(options.maxTokens));
  let current = [...blocks];
  const dropped: DroppedBlock[] = [];
  const compressed: string[] = [];
  const stages: BudgetStage[] = [];
  const record = (stage: BudgetStage): void => {
    if (!stages.includes(stage)) stages.push(stage);
  };
  const drop = (block: PromptBlock, stage: BudgetStage): void => {
    dropped.push({ id: block.id, label: block.label, kind: block.kind, tokens: counter.count(block.content), stage });
    current = current.filter((candidate) => candidate.id !== block.id);
  };
  const used = (): number => current.reduce((sum, block) => sum + counter.count(block.content), 0);

  if (used() > maxTokens) {
    const history = current
      .filter((block) => block.kind === 'history' && block.droppable)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const block of history) {
      if (used() <= maxTokens) break;
      record('drop-history');
      drop(block, 'drop-history');
    }
  }
  if (used() > maxTokens) {
    const memories = current
      .filter(
        (block) =>
          (block.kind === 'memory' ||
            block.kind === 'attachment' ||
            block.kind === 'history-recall' ||
            block.kind === 'chapter') &&
          block.droppable,
      )
      .sort((a, b) => {
        const rank = (block: PromptBlock): number =>
          block.kind === 'chapter' ? 2 : block.kind === 'attachment' || block.kind === 'history-recall' ? 1 : 0;
        return rank(a) - rank(b) || (a.score ?? 0) - (b.score ?? 0);
      });
    for (const block of memories) {
      if (used() <= maxTokens) break;
      record('drop-memory');
      drop(block, 'drop-memory');
    }
  }
  const stage = (kind: PromptBlock['kind'], name: BudgetStage): void => {
    if (used() > maxTokens) {
      for (const block of current) {
        if (used() <= maxTokens) break;
        if (block.kind !== kind || block.compressed === undefined) continue;
        record(name);
        block.content = block.compressed;
        if (!compressed.includes(block.id)) compressed.push(block.id);
      }
    }
  };
  stage('relationship', 'compress-relationship');
  stage('persona', 'compress-persona');
  stage('system', 'compress-system');
  if (used() > maxTokens) {
    const candidates = current.filter((block) => block.droppable).sort((a, b) => a.priority - b.priority);
    for (const block of candidates) {
      if (used() <= maxTokens) break;
      record('drop-lowest-priority');
      drop(block, 'drop-lowest-priority');
    }
  }
  const usedTokens = used();
  return {
    blocks: current,
    report: { maxTokens, usedTokens, stages, dropped, compressed, fits: usedTokens <= maxTokens },
  };
}

/** 确定性伪随机，保证失败可复现。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const KINDS: PromptBlock['kind'][] = [
  'system',
  'worldbook',
  'persona',
  'relationship',
  'memory',
  'attachment',
  'chapter',
  'history-recall',
  'scene',
  'history',
  'instruction',
  'format',
  'player',
];

function randomBlocks(random: () => number, count: number): PromptBlock[] {
  return Array.from({ length: count }, (_, index) => {
    const kind = KINDS[Math.floor(random() * KINDS.length)] ?? 'history';
    const length = 1 + Math.floor(random() * 80);
    const content = '字'.repeat(length) + 'abc'.repeat(Math.floor(random() * 5));
    const withCompressed = random() < 0.5;
    return {
      id: `${kind}:${String(index)}`,
      kind,
      label: kind,
      content,
      priority: Math.floor(random() * 1000),
      droppable: random() < 0.8,
      ...(withCompressed ? { compressed: '字'.repeat(Math.max(1, Math.floor(length / 3))) } : {}),
      sequence: Math.floor(random() * count),
      score: random(),
    };
  });
}

function historyBlocks(count: number): PromptBlock[] {
  const blocks: PromptBlock[] = [
    { id: 'system', kind: 'system', label: '基本规则', content: '规则'.repeat(200), priority: 1000, droppable: false },
  ];
  for (let index = 0; index < count; index += 1) {
    blocks.push({
      id: `history:${String(index)}`,
      kind: 'history',
      label: '旅人',
      content: `第${String(index)}句话，`.repeat(4),
      priority: 300,
      droppable: true,
      sequence: index,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', speakerName: '旅人' },
    });
  }
  blocks.push({ id: 'player', kind: 'player', label: '旅人', content: '你好', priority: 1000, droppable: false });
  return blocks;
}

describe('预算守卫 O(n) 改写与旧实现等价（审计 A12）', () => {
  it('随机输入 300 组：保留的块、报告、压缩后的正文逐一相同', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = rng(seed);
      const blocks = randomBlocks(random, 5 + Math.floor(random() * 60));
      const total = blocks.reduce((sum, block) => sum + heuristicTokenCounter.count(block.content), 0);
      const maxTokens = Math.floor(total * random());

      const legacy = legacyApplyBudget(structuredClone(blocks), { maxTokens });
      const next = applyBudget(structuredClone(blocks), { maxTokens });
      expect(next.report).toEqual(legacy.report);
      expect(next.blocks).toEqual(legacy.blocks);
    }
  });

  it('3000 条历史的长对话：结果一致', () => {
    const legacy = legacyApplyBudget(historyBlocks(3000), { maxTokens: 20_000 });
    const next = applyBudget(historyBlocks(3000), { maxTokens: 20_000 });
    expect(next.report).toEqual(legacy.report);
    expect(next.blocks.map((block) => block.id)).toEqual(legacy.blocks.map((block) => block.id));
  });

  it('3000 条历史、要丢两千多块：远快于旧实现', () => {
    const started = performance.now();
    const result = applyBudget(historyBlocks(3000), { maxTokens: 8_000 });
    const elapsed = performance.now() - started;
    expect(result.report.dropped.length).toBeGreaterThan(2000);
    expect(result.report.fits).toBe(true);
    // 旧实现在这组输入上要数秒；新实现应在几十毫秒量级（给 CI 留足余量）
    expect(elapsed).toBeLessThan(500);
  });

  it('id 撞车的两块：只丢被选中的那一块（审计 B8 的防线）', () => {
    const blocks: PromptBlock[] = [
      { id: 'dup', kind: 'worldbook', label: 'a', content: '字'.repeat(50), priority: 1, droppable: true },
      { id: 'dup', kind: 'worldbook', label: 'b', content: '字'.repeat(50), priority: 2, droppable: true },
    ];
    const result = applyBudget(blocks, { maxTokens: 60 });
    expect(result.blocks.map((block) => block.label)).toEqual(['b']);
  });
});

describe('结构开销（审计 B12）', () => {
  it('不传 overhead 时口径不变；传了之后每条消息与小节标题都计入', () => {
    const blocks = historyBlocks(10);
    const plain = applyBudget(structuredClone(blocks), { maxTokens: 100_000 });
    const withOverhead = applyBudget(structuredClone(blocks), {
      maxTokens: 100_000,
      overhead: (block) => structuralOverhead(block),
    });
    const content = blocks.reduce((sum, block) => sum + heuristicTokenCounter.count(block.content), 0);
    expect(plain.report.usedTokens).toBe(content);
    // 11 条消息（10 历史 + 玩家）各 4，外加 system 小节标题
    expect(withOverhead.report.usedTokens).toBeGreaterThanOrEqual(content + 11 * 4);
  });
});
