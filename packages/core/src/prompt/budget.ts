import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import type { BudgetReport, BudgetStage, DroppedBlock, PromptBlock } from './types.js';

export interface BudgetOptions {
  maxTokens: number;
  counter?: TokenCounter;
}

export interface BudgetResult {
  blocks: PromptBlock[];
  report: BudgetReport;
}

function totalTokens(blocks: PromptBlock[], counter: TokenCounter): number {
  let total = 0;
  for (const block of blocks) {
    total += counter.count(block.content);
  }
  return total;
}

/**
 * 预算守卫（设计文档 §4.6）。
 *
 * 按时序依次降级：丢最旧的历史 → 丢低分记忆 → 压缩关系描述 →
 * 压缩人设描述 → 兜底丢弃优先级最低的块。
 *
 * 最后一级是为了兑现「任何情况下都要产出可用 prompt」这个承诺：
 * 前四级都不够时，宁可丢内容也不让整轮对话失败。
 */
export function applyBudget(blocks: PromptBlock[], options: BudgetOptions): BudgetResult {
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
    dropped.push({
      id: block.id,
      label: block.label,
      kind: block.kind,
      tokens: counter.count(block.content),
      stage,
    });
    current = current.filter((candidate) => candidate.id !== block.id);
  };

  const used = (): number => totalTokens(current, counter);

  // 第 1 级：丢弃最旧的工作记忆原文
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

  // 第 2 级：丢弃分数最低的召回记忆，然后才是前情提要
  //
  // 前情提要与召回记忆都是压缩过的东西，所以同一级里让位；但它是「叙述的连续性」，
  // 比零散条目更值钱，所以排在记忆之后（丢到第 3 级才开始动它）。
  // 提到才取回的远处原文（顺序 58）与附件展开同级：都是「被提起才带的补充」。
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

  // 第 3 级：压缩关系与情绪描述
  if (used() > maxTokens) {
    for (const block of current) {
      if (used() <= maxTokens) break;
      if (block.kind !== 'relationship' || block.compressed === undefined) continue;
      record('compress-relationship');
      block.content = block.compressed;
      if (!compressed.includes(block.id)) compressed.push(block.id);
    }
  }

  // 第 4 级：压缩非发言者的人设描述
  if (used() > maxTokens) {
    for (const block of current) {
      if (used() <= maxTokens) break;
      if (block.kind !== 'persona' || block.compressed === undefined) continue;
      record('compress-persona');
      block.content = block.compressed;
      if (!compressed.includes(block.id)) compressed.push(block.id);
    }
  }

  // 兜底：按优先级从低到高丢弃，保证一定产出
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
    report: {
      maxTokens,
      usedTokens,
      stages,
      dropped,
      compressed,
      fits: usedTokens <= maxTokens,
    },
  };
}
