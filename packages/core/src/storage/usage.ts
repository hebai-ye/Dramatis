import type { ConversationId, InstanceId, RoomId } from '../model/ids.js';
import { newId, nowIso } from '../model/ids.js';
import type { ProviderPrice } from '../model/provider.js';
import type { EntityStore } from '../platform/entity-store.js';
import { matchesWhere } from '../platform/entity-store.js';

/**
 * 用量账单（ROADMAP P3-7 / T7）。
 *
 * 为什么单开一个集合，而不是把用量挂在任务或消息上：
 *
 * 1. **任务记录会被清掉。** 重抽与改归属都会 `clearTurn`（任务幂等键必须让位），
 *    而钱已经花了——账单跟着任务走就会凭空少一截。
 * 2. **一次调用未必对应一条消息。** 生成前的意图调用、后台的一轮分析都没有自己的消息。
 * 3. **消息会被删。** 用户删掉一条回复，不等于那次调用没花钱。
 *
 * 所以这里是一份**只增不改的流水**：每发生一次模型调用就写一条，与剧情数据解耦。
 * 归档一条对话不回滚账单（时间线可以当作没发生过，钱不行）；只有整个世界被删掉时，
 * 才由仓储层把它的账单一起清掉。
 */
export const USAGE_COLLECTION = 'usageRecords';

/**
 * 一次模型调用的用途。
 *
 * `memory` 与 `affect` 是旧版队列留下的两类任务（现在合并成 `analysis`），
 * 老库里可能还有它们的账单，所以保留这两个取值。
 */
export type UsageCategory =
  | 'generation'
  | 'intent'
  | 'analysis'
  /** 分层摘要（P1-5）：场景场记与章节回顾。 */
  | 'summary'
  | 'memory'
  | 'affect'
  | 'admin';

export interface UsageRecord {
  id: string;
  /** 属于哪个世界；跨世界的总账按它分。没有世界时（例如还没开对话）为 null。 */
  roomId: RoomId | null;
  conversationId: ConversationId | null;
  turnId: string | null;
  category: UsageCategory;
  /** 用了哪个模型。**只记模型名**——baseUrl 与密钥不进口袋。 */
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** 生成类调用才有：这一轮是谁在说话，按角色统计要用。 */
  speakerInstanceId: InstanceId | null;
  speakerName: string;
  /**
   * 记账时的单价快照（每百万 token）。
   *
   * 存快照而不是查询时现取：单价会改、配置会删，而历史账单不该跟着变。
   * 没配单价就是 null——**不编一个假价格去算钱**（P3-7 的原则）。
   */
  price: ProviderPrice | null;
  createdAt: string;
  /**
   * 与 `createdAt` **恒等**（顺序 68）。
   *
   * 账单是只增不改的流水，本来没有「最后修改时间」这回事；这个字段存在的唯一理由是
   * 让记录进 `updatedAt` 索引，好让 `since` 能按时间只取一小段，而不是把整个世界的
   * 账单读出来再逐条比。**它不参与同步**——`usageRecords` 不在 `SYNC_COLLECTIONS`
   * 白名单里（账单是本机的东西），所以盖这个章不会改变任何同步行为。
   */
  updatedAt: string;
}

export interface RecordUsageInput {
  roomId?: RoomId | null;
  conversationId?: ConversationId | null;
  turnId?: string | null;
  category: UsageCategory;
  model: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  speakerInstanceId?: InstanceId | null;
  speakerName?: string;
  price?: ProviderPrice | null;
  /** 记录时间，缺省取当下。测试与补录用得上。 */
  at?: string;
}

export interface UsageFilter {
  roomId?: RoomId;
  conversationId?: ConversationId;
  turnId?: string;
  category?: UsageCategory;
  /** 只要这个时刻（含）之后的记录。 */
  since?: string;
}

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  /**
   * 按单价换算出的花费；**一次都没配单价时是 null**，而不是 0——
   * 0 会被读成「不要钱」。
   */
  cost: number | null;
  /** 有单价、真正参与换算的调用条数。用它说明「这个数只覆盖了一部分调用」。 */
  pricedCalls: number;
  /** 参与换算的币种；混用多种币种时不参与换算的那部分被排除，这里取最常见的一种。 */
  currency: string | null;
}

export interface UsageGroup<TKey> {
  key: TKey;
  /** 人类可读的分组名（角色名、模型名）；与 key 相同时可省略。 */
  label: string;
  totals: UsageTotals;
}

export interface UsageSummary {
  total: UsageTotals;
  byCategory: Array<UsageGroup<UsageCategory>>;
  /** 按说话人分（只对生成类调用有意义，其余归到「（非生成）」不列出）。 */
  bySpeaker: Array<UsageGroup<string>>;
  byModel: Array<UsageGroup<string>>;
  firstAt: string | null;
  lastAt: string | null;
}

/** 负数、NaN、Infinity 一律按 0 记：账单里出现这些只可能是上游数据有问题。 */
export function sanitizeTokens(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokens: 0,
    cost: null,
    pricedCalls: 0,
    currency: null,
  };
}

function costOf(record: UsageRecord): number | null {
  const price = record.price;
  if (price === null) return null;
  return (
    (record.promptTokens / 1_000_000) * price.inputPerMillion +
    (record.completionTokens / 1_000_000) * price.outputPerMillion
  );
}

function addInto(totals: UsageTotals, record: UsageRecord): void {
  totals.calls += 1;
  totals.promptTokens += record.promptTokens;
  totals.completionTokens += record.completionTokens;
  totals.tokens = totals.promptTokens + totals.completionTokens;

  const cost = costOf(record);
  if (cost === null || record.price === null) return;
  totals.cost = (totals.cost ?? 0) + cost;
  totals.pricedCalls += 1;
  totals.currency = totals.currency ?? record.price.currency;
}

/**
 * 分组的排序：token 多的在前，**并列时按 key 定序**。
 *
 * 并列必须有确定的次序（顺序 68）：`summary()` 不再先把流水排序，分组是边遍历边
 * 累计出来的，并列的分组谁先谁后就跟着记录的到达顺序走。没有这条 tie-break，
 * 同一份账在「按索引下推读」和「整表读」两条路径上可能给出顺序不同的分组列表。
 * 代价只是一次字符串比较，换来的是「汇总与输入顺序无关」这条可测的性质。
 */
function byTokensDesc<TKey>(left: UsageGroup<TKey>, right: UsageGroup<TKey>): number {
  const diff = right.totals.tokens - left.totals.tokens;
  if (diff !== 0) return diff;
  const leftKey = String(left.key);
  const rightKey = String(right.key);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * 把一批流水汇总成「给用户看的数字」。
 *
 * 纯函数：不碰存储、不看时间，方便测试也方便将来换后端聚合。
 *
 * **与输入顺序无关**（顺序 68）：`total` 与各分组都是累加，`firstAt` / `lastAt` 取极值，
 * 分组的并列次序由 `byTokensDesc` 兜住。所以调用方不必先排序——那正是 `summary()`
 * 之前白付一次 O(N log N) 的原因。
 */
export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const total = emptyTotals();
  const categories = new Map<UsageCategory, UsageTotals>();
  const speakers = new Map<string, { label: string; totals: UsageTotals }>();
  const models = new Map<string, UsageTotals>();

  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const record of records) {
    addInto(total, record);

    const category = categories.get(record.category) ?? emptyTotals();
    addInto(category, record);
    categories.set(record.category, category);

    if (record.category === 'generation') {
      const key = record.speakerInstanceId ?? record.speakerName;
      const speaker = speakers.get(key) ?? { label: record.speakerName, totals: emptyTotals() };
      addInto(speaker.totals, record);
      speakers.set(key, speaker);
    }

    const model = models.get(record.model) ?? emptyTotals();
    addInto(model, record);
    models.set(record.model, model);

    if (firstAt === null || record.createdAt < firstAt) firstAt = record.createdAt;
    if (lastAt === null || record.createdAt > lastAt) lastAt = record.createdAt;
  }

  return {
    total,
    byCategory: [...categories.entries()].map(([key, totals]) => ({ key, label: key, totals })).sort(byTokensDesc),
    bySpeaker: [...speakers.entries()]
      .map(([key, value]) => ({ key, label: value.label, totals: value.totals }))
      .sort(byTokensDesc),
    byModel: [...models.entries()].map(([key, totals]) => ({ key, label: key, totals })).sort(byTokensDesc),
    firstAt,
    lastAt,
  };
}

export interface UsageLedger {
  /** 记一笔。tokens 会被清洗成非负整数；两者都是 0 也照样记（调用发生过）。 */
  record(input: RecordUsageInput): Promise<UsageRecord>;
  /**
   * 按时间正序返回；`limit` 取最近的 N 条。
   *
   * 「时间正序」的完整定义是 `createdAt` 升序，**同一毫秒的并列按 id 升序**（顺序 68）。
   * 后者是为了让「按索引下推读」与「整表读」两条路径给出逐条相同的结果——底下拿到的
   * 顺序本来就不同（索引序 vs 主键序），只按时间排的话并列那几条会飘。
   */
  list(filter?: UsageFilter, limit?: number): Promise<UsageRecord[]>;
  /**
   * 汇总。**不保证也不依赖任何顺序**（顺序 68）——它读流水时不做排序，
   * 结果与记录的到达顺序无关。
   */
  summary(filter?: UsageFilter): Promise<UsageSummary>;
  /** 世界被彻底删除时一并清账，返回删掉的条数。 */
  removeByRoom(roomId: RoomId): Promise<number>;
}

export function createUsageLedger(store: EntityStore): UsageLedger {
  function whereOf(filter: UsageFilter): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (filter.roomId !== undefined) where.roomId = filter.roomId;
    if (filter.conversationId !== undefined) where.conversationId = filter.conversationId;
    if (filter.turnId !== undefined) where.turnId = filter.turnId;
    if (filter.category !== undefined) where.category = filter.category;
    return where;
  }

  /**
   * 读一批流水，**不排序**（顺序 68）。
   *
   * 两条路径，结果必须逐条一致（单测直接对账）：
   *
   * 1. `since` 给了、后端也实现了 `listSince` → 走 `updatedAt` 索引，只读「这个时刻
   *    （含）之后」的那一段。这里能按 `updatedAt` 下推，靠的是一条不变量：
   *    **账单的 `updatedAt` 恒等于 `createdAt`**（见 `record()` 与仓储迁移 11）。
   * 2. 否则整表读（带 `where` 时后端自己会走房间索引），`since` 逐条过滤。
   */
  async function read(filter: UsageFilter): Promise<UsageRecord[]> {
    const where = whereOf(filter);
    const since = filter.since;

    if (since !== undefined && store.listSince !== undefined) {
      const rows = await store.listSince<UsageRecord>(USAGE_COLLECTION, since, { inclusive: true });
      return rows.filter((record) => matchesWhere(record, where));
    }

    const rows = await store.list<UsageRecord>(USAGE_COLLECTION, { where });
    return since === undefined ? rows : rows.filter((record) => record.createdAt >= since);
  }

  /**
   * `createdAt` 升序；同一毫秒按 id 升序。
   *
   * 不交给存储层的 `orderBy`（那只是一次稳定排序，并列时沿用底层顺序），
   * 而是在这里显式定死——这是「下推读与整表读逐条一致」能成立的前提。
   */
  function byTimeThenId(left: UsageRecord, right: UsageRecord): number {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }

  async function list(filter: UsageFilter = {}, limit?: number): Promise<UsageRecord[]> {
    const records = (await read(filter)).sort(byTimeThenId);
    if (limit === undefined || records.length <= limit) return records;
    return records.slice(records.length - limit);
  }

  return {
    async record(input: RecordUsageInput): Promise<UsageRecord> {
      const createdAt = input.at ?? nowIso();
      const created: UsageRecord = {
        id: newId(),
        roomId: input.roomId ?? null,
        conversationId: input.conversationId ?? null,
        turnId: input.turnId ?? null,
        category: input.category,
        model: input.model,
        promptTokens: sanitizeTokens(input.promptTokens),
        completionTokens: sanitizeTokens(input.completionTokens),
        speakerInstanceId: input.speakerInstanceId ?? null,
        speakerName: input.speakerName ?? '',
        price: input.price ?? null,
        createdAt,
        // 只增不改的流水没有「最后修改时间」，所以就是创建时间（顺序 68）。
        updatedAt: createdAt,
      };
      await store.put(USAGE_COLLECTION, created);
      return created;
    },

    list,

    async summary(filter: UsageFilter = {}): Promise<UsageSummary> {
      /*
       * 顺序 68：汇总只要合计，不需要顺序。以前它走 `list()`，于是每次调用都白付
       * 一次 O(N log N) 排序——而这条路径在长对话里每轮要走好几遍（后台队列每取
       * 一条任务就重算一次熔断账单）。
       */
      return summarizeUsage(await read(filter));
    },

    async removeByRoom(roomId: RoomId): Promise<number> {
      const records = await store.list<UsageRecord>(USAGE_COLLECTION, { where: { roomId } });
      for (const record of records) {
        await store.remove(USAGE_COLLECTION, record.id);
      }
      return records.length;
    },
  };
}
