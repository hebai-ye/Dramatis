import { heuristicTokenCounter, type TokenCounter } from '../token/estimate.js';
import type { BudgetReport, BudgetStage, DroppedBlock, PromptBlock } from './types.js';

export interface BudgetOptions {
  maxTokens: number;
  counter?: TokenCounter;
  /**
   * 每块在正文之外还要占的 token（审计 B12）：消息结构、`### 标题`、分隔符等。
   *
   * 缺省 0——与只数正文的老口径逐字一致；`assemblePrompt` 会传 `structuralOverhead`。
   */
  overhead?: (block: PromptBlock) => number;
}

export interface BudgetResult {
  blocks: PromptBlock[];
  report: BudgetReport;
}

/**
 * 一条对话消息的结构开销（角色标记、分隔符），OpenAI 口径约 3–4 token。
 * 宁可高估：低估的代价是临界时被服务端 400 拒掉，高估只是少带一两条历史。
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * 一块在正文之外的结构开销（审计 B12）。
 *
 * - 历史与玩家这一句：各自是一条独立消息，付一条消息的开销；
 * - `at_depth` 的块：插进历史时自成一条 system 消息，同上，再加小节标题；
 * - 其余系统侧的块：并进那条大 system 消息，付 `### 标题` 与空行的开销。
 */
export function structuralOverhead(block: PromptBlock, counter: TokenCounter = heuristicTokenCounter): number {
  if (block.kind === 'history' || block.kind === 'player') return MESSAGE_OVERHEAD_TOKENS;
  const header = block.label.trim() === '' ? 0 : counter.count(`### ${block.label}`) + 1;
  if (block.placement === 'at_depth') return MESSAGE_OVERHEAD_TOKENS + header;
  return header + 1;
}

/**
 * 预算守卫（设计文档 §4.6）。
 *
 * 按时序依次降级：丢最旧的历史 → 丢低分记忆 → 压缩关系描述 →
 * 压缩人设描述 → 兜底丢弃优先级最低的块。
 *
 * 最后一级是为了兑现「任何情况下都要产出可用 prompt」这个承诺：
 * 前四级都不够时，宁可丢内容也不让整轮对话失败。
 *
 * 复杂度（审计 A12）：每块的 token 数只算一次并缓存，维护一个累计总量——丢块时减去、
 * 压缩时按差值调整。以前每丢一块都要把全部块重新数一遍、再 filter 一遍数组，
 * 3000 条历史超预算时是 O(n²)，会把主线程卡住数秒。输出与旧实现逐块一致。
 */
export function applyBudget(blocks: PromptBlock[], options: BudgetOptions): BudgetResult {
  const counter = options.counter ?? heuristicTokenCounter;
  const overheadOf = options.overhead ?? (() => 0);
  const maxTokens = Math.max(0, Math.floor(options.maxTokens));

  const current = [...blocks];
  const removed = new Set<PromptBlock>();
  const dropped: DroppedBlock[] = [];
  const compressed: string[] = [];
  const stages: BudgetStage[] = [];

  /** 每块的正文 token（缓存）；压缩时更新。 */
  const contentTokens = new Map<PromptBlock, number>();
  let total = 0;
  for (const block of current) {
    const tokens = counter.count(block.content);
    contentTokens.set(block, tokens);
    total += tokens + overheadOf(block);
  }

  const record = (stage: BudgetStage): void => {
    if (!stages.includes(stage)) stages.push(stage);
  };

  const drop = (block: PromptBlock, stage: BudgetStage): void => {
    if (removed.has(block)) return;
    const tokens = contentTokens.get(block) ?? counter.count(block.content);
    dropped.push({ id: block.id, label: block.label, kind: block.kind, tokens, stage });
    removed.add(block);
    total -= tokens + overheadOf(block);
  };

  const compress = (block: PromptBlock, stage: BudgetStage): void => {
    if (block.compressed === undefined) return;
    record(stage);
    const before = contentTokens.get(block) ?? counter.count(block.content);
    block.content = block.compressed;
    const after = counter.count(block.content);
    contentTokens.set(block, after);
    total += after - before;
    if (!compressed.includes(block.id)) compressed.push(block.id);
  };

  const alive = (): PromptBlock[] => current.filter((block) => !removed.has(block));
  const over = (): boolean => total > maxTokens;

  // 第 1 级：丢弃最旧的工作记忆原文
  if (over()) {
    const history = alive()
      .filter((block) => block.kind === 'history' && block.droppable)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const block of history) {
      if (!over()) break;
      record('drop-history');
      drop(block, 'drop-history');
    }
  }

  // 第 2 级：丢弃分数最低的召回记忆，然后才是前情提要
  //
  // 前情提要与召回记忆都是压缩过的东西，所以同一级里让位；但它是「叙述的连续性」，
  // 比零散条目更值钱，所以排在记忆之后（丢到第 3 级才开始动它）。
  // 提到才取回的远处原文（顺序 58）与附件展开同级：都是「被提起才带的补充」。
  if (over()) {
    const memories = alive()
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
      if (!over()) break;
      record('drop-memory');
      drop(block, 'drop-memory');
    }
  }

  // 第 3 级：压缩关系与情绪描述；第 4 级：压缩非发言者的人设描述；
  // 然后是默认系统提示——极小窗口下收成原有核心规则。
  // 自定义系统提示不带 compressed，绝不悄悄改写用户内容。
  const compressStage = (kind: PromptBlock['kind'], stage: BudgetStage): void => {
    if (!over()) return;
    for (const block of alive()) {
      if (!over()) break;
      if (block.kind !== kind || block.compressed === undefined) continue;
      compress(block, stage);
    }
  };
  compressStage('relationship', 'compress-relationship');
  compressStage('persona', 'compress-persona');
  compressStage('system', 'compress-system');

  // 兜底：按优先级从低到高丢弃，保证一定产出
  if (over()) {
    const candidates = alive()
      .filter((block) => block.droppable)
      .sort((a, b) => a.priority - b.priority);
    for (const block of candidates) {
      if (!over()) break;
      record('drop-lowest-priority');
      drop(block, 'drop-lowest-priority');
    }
  }

  const kept = alive();
  const usedTokens = total;

  return {
    blocks: kept,
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
