import { heuristicTokenCounter, NARROW_CHARS_PER_TOKEN, type TokenCounter } from './estimate.js';

/**
 * 估算口径的校准（顺序 71）。
 *
 * `estimateTokens` 是一个**没有跟真实分词器对齐过**的启发式值：它按「窄字符 4 个算
 * 一个 token」估，而服务商的 BPE 词表对短词、JSON、标记行都更贵。审计（B12）报的就是
 * 这件事——真实 `promptTokens` 比估算高。但要调公式就得知道**高多少**，而这个数只能
 * 来自真实调用：一边是本地估算，一边是服务端回来的 `usage.promptTokens`。
 *
 * 所以这里只做两件事，都不猜：
 *
 * 1. **配对统计**：把「估算 / 真实」成对喂进来，算出比例与建议除数。数据从哪来有两条路——
 *    离线的合成样本（测试用），或者**账单里已经在攒的配对**（`UsageTotals.calibration`
 *    / `usageCalibration`，见 `storage/usage.ts`：每次生成都把装配时的 `tokenEstimate`
 *    和真实的 `promptTokens` 一起记下来，不存正文）。
 * 2. **按比例放大的计数器**：`counterFromCalibration()` 给出一个包住原计数器的 `TokenCounter`，
 *    让预算守卫按实测比例留余量——**不改默认口径**，要改是调用方显式换计数器的事。
 *
 * 没有可用样本时 `ratio` 是 null，除数建议保持默认：宁可维持现状，也不凭感觉调数字。
 */
export interface TokenPair {
  /** 本地估算的 token 数。 */
  estimated: number;
  /** 服务端回来的真实 prompt token 数。 */
  actual: number;
}

/** 一条带原文的样本：可以换一个计数器重算估算值。 */
export interface TokenSample {
  text: string;
  actual: number;
}

/** 单条样本的偏差明细：`deviation = actual / estimated - 1`，正数表示低估。 */
export interface CalibrationOutlier {
  index: number;
  estimated: number;
  actual: number;
  deviation: number;
  /** 原文前 80 个字符（空白折成空格），带原文的那条路才有。 */
  preview?: string;
}

export interface CalibrationReport {
  /** 参与统计的样本条数（估算与真实都 > 0 的才算，其余被丢掉）。 */
  samples: number;
  /** 这些样本的估算值之和。 */
  estimated: number;
  /** 这些样本的真实值之和。 */
  actual: number;
  /**
   * `actual / estimated`：1 表示估准，**大于 1 表示低估**（真实比估算多），
   * 小于 1 表示高估。没有可用样本时 null。
   */
  ratio: number | null;
  /** 建议的窄字符除数；没有样本时就是默认的 `NARROW_CHARS_PER_TOKEN`。 */
  suggestedNarrowDivisor: number;
  /** 偏差最大的几条（|deviation| 降序，并列按原下标升序）。 */
  worst: CalibrationOutlier[];
}

/** 除数建议的上下界：再小会把英文散文估成两倍，再大就等于没改。 */
export const MIN_NARROW_DIVISOR = 2;
export const MAX_NARROW_DIVISOR = 6;

/** 默认列出的偏差样本条数。 */
export const DEFAULT_WORST_LIMIT = 5;

/**
 * 真实 / 估算。任一不是正有限数就返回 null——账单里 0 token 的调用不少
 * （本地模型不回 usage、网页版那一轮没有 token），它们不能参与比例。
 */
export function ratioOf(estimated: number, actual: number): number | null {
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return null;
  if (estimated <= 0 || actual <= 0) return null;
  return actual / estimated;
}

/**
 * 要抵上 `ratio` 倍的估算，窄字符除数该换成多少：`NARROW_CHARS_PER_TOKEN / ratio`。
 *
 * 只对**字符主导**的估算是严格成立的（全角字符那部分不随除数变），所以它是一条
 * 「建议」而不是自动生效的配置，钳在 `[MIN_NARROW_DIVISOR, MAX_NARROW_DIVISOR]`，
 * 保留一位小数——再细就像真测过一样。
 */
export function suggestedNarrowDivisorFor(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return NARROW_CHARS_PER_TOKEN;
  const raw = NARROW_CHARS_PER_TOKEN / ratio;
  const clamped = Math.min(MAX_NARROW_DIVISOR, Math.max(MIN_NARROW_DIVISOR, raw));
  return Math.round(clamped * 10) / 10;
}

function previewOf(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 80);
}

/** 参与统计的一条：估算值、真实值、原下标，以及（可选）原文预览。 */
interface CalibrationEntry {
  estimated: number;
  actual: number;
  index: number;
  preview?: string;
}

/**
 * 汇总一批条目。**求和之后再除**，不是逐条取平均：token 数才是钱和预算的单位，
 * 一条两万 token 的提示词与一条二十 token 的标签不该等权重。
 */
function buildReport(entries: readonly CalibrationEntry[], worstLimit: number): CalibrationReport {
  const usable = entries.filter((entry) => ratioOf(entry.estimated, entry.actual) !== null);

  let estimated = 0;
  let actual = 0;
  for (const entry of usable) {
    estimated += entry.estimated;
    actual += entry.actual;
  }
  const ratio = ratioOf(estimated, actual);

  const worst: CalibrationOutlier[] = usable.map((entry) => ({
    index: entry.index,
    estimated: entry.estimated,
    actual: entry.actual,
    deviation: entry.actual / entry.estimated - 1,
    ...(entry.preview === undefined ? {} : { preview: entry.preview }),
  }));
  worst.sort((left, right) => {
    const diff = Math.abs(right.deviation) - Math.abs(left.deviation);
    return diff !== 0 ? diff : left.index - right.index;
  });

  return {
    samples: usable.length,
    estimated,
    actual,
    ratio,
    suggestedNarrowDivisor: suggestedNarrowDivisorFor(ratio),
    worst: worst.slice(0, Math.max(0, worstLimit)),
  };
}

/** 按配对样本算比例（账单里攒下来的那种：没有原文，只有两个数）。 */
export function calibrateCounts(
  pairs: readonly TokenPair[],
  worstLimit: number = DEFAULT_WORST_LIMIT,
): CalibrationReport {
  const entries: CalibrationEntry[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === undefined) continue;
    entries.push({ estimated: pair.estimated, actual: pair.actual, index });
  }
  return buildReport(entries, worstLimit);
}

/** 带原文的样本：用给定计数器（缺省启发式）估一遍，再算比例。 */
export function calibrateTokenCounter(
  samples: readonly TokenSample[],
  counter: TokenCounter = heuristicTokenCounter,
  worstLimit: number = DEFAULT_WORST_LIMIT,
): CalibrationReport {
  const entries: CalibrationEntry[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) continue;
    entries.push({
      estimated: counter.count(sample.text),
      actual: sample.actual,
      index,
      preview: previewOf(sample.text),
    });
  }
  return buildReport(entries, worstLimit);
}

/**
 * 按校准结果包一个计数器：估算值 × `ratio`，向上取整。
 *
 * 返回 null 表示**没有可用样本**（`ratio` 为 null）——调用方应当继续用原来的计数器，
 * 而不是拿一个没有依据的倍数去改预算。名字里带上倍数，方便日志里看出用了哪一档。
 */
export function counterFromCalibration(
  report: CalibrationReport,
  base: TokenCounter = heuristicTokenCounter,
): TokenCounter | null {
  const ratio = report.ratio;
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return null;
  const factor = Math.round(ratio * 100) / 100;
  return {
    name: `${base.name}-calibrated-x${String(factor)}`,
    count: (text: string): number => Math.ceil(base.count(text) * factor),
  };
}

/** 给人看的一行，便于把真机上的数贴进 EVAL。 */
export function formatCalibration(report: CalibrationReport): string {
  if (report.ratio === null) {
    return `还没有可用的配对样本：账单里既要有估算值、也要有服务端返回的 promptTokens（顺序 71）。`;
  }
  const percent = Math.round((report.ratio - 1) * 1000) / 10;
  const direction = percent >= 0 ? '低估' : '高估';
  return [
    `估算 ${String(report.estimated)} / 真实 ${String(report.actual)}`,
    `${direction} ${String(Math.abs(percent))}%`,
    `建议窄字符除数 ${String(NARROW_CHARS_PER_TOKEN)} → ${String(report.suggestedNarrowDivisor)}`,
    `样本 ${String(report.samples)} 条`,
  ].join('；');
}
