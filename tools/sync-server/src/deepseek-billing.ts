/** Public-price snapshot only; vendor per-request invoice rounding/assignment is unverified. */
export const DEEPSEEK_PRICE_VERSION = 'deepseek-flash-cny-2026-10-02';
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_CONTEXT_TOKENS = 1_048_576;
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 16_384;
export const DEEPSEEK_PRICE_CONFIRMED_AT = '2026-10-02T00:00:00.000Z';
export const DEFAULT_DEEPSEEK_PRICE_UNTIL = '2026-10-03T16:00:00.000Z';

export interface DeepSeekPriceConfig {
  validFrom?: string;
  validUntil?: string;
}
export type DeepSeekPricePeriod = 'peak' | 'offpeak';
export interface DeepSeekUsage {
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

const HOLIDAYS_2026 = [
  ['01-01', '01-03'],
  ['02-15', '02-23'],
  ['04-04', '04-06'],
  ['05-01', '05-05'],
  ['06-19', '06-21'],
  ['09-25', '09-27'],
  ['10-01', '10-07'],
] as const;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function localDate(at: number): Date {
  if (!Number.isSafeInteger(at)) throw new Error('price-unavailable');
  const date = new Date(at + BEIJING_OFFSET);
  if (date.getUTCFullYear() !== 2026) throw new Error('price-unavailable');
  return date;
}

function peakDay(date: Date): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const monthDay = date.toISOString().slice(5, 10);
  return !HOLIDAYS_2026.some(([from, until]) => monthDay >= from && monthDay <= until);
}

export function deepSeekPriceAt(at: number, config: DeepSeekPriceConfig = {}) {
  const from = Date.parse(config.validFrom ?? DEEPSEEK_PRICE_CONFIRMED_AT);
  const until = Date.parse(config.validUntil ?? DEFAULT_DEEPSEEK_PRICE_UNTIL);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || from >= until || at < from || at >= until)
    throw new Error('price-unavailable');
  const date = localDate(at);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const period: DeepSeekPricePeriod =
    peakDay(date) && ((minute >= 540 && minute < 720) || (minute >= 840 && minute < 1080)) ? 'peak' : 'offpeak';
  return { version: DEEPSEEK_PRICE_VERSION, period, holidayVersion: 'china-2026-official-v1' };
}

/** Check every actual price boundary, including two crossings with equal endpoint periods. */
export function deepSeekPriceForInterval(startedAt: number, endedAt: number, config: DeepSeekPriceConfig = {}) {
  if (endedAt < startedAt) throw new Error('price-boundary');
  const price = deepSeekPriceAt(startedAt, config);
  deepSeekPriceAt(endedAt, config);
  const firstDay = Math.floor((startedAt + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET;
  for (let midnight = firstDay; midnight <= endedAt; midnight += DAY) {
    if (!peakDay(localDate(midnight))) continue;
    for (const hour of [9, 12, 14, 18]) {
      const boundary = midnight + hour * 60 * 60 * 1000;
      if (startedAt < boundary && boundary <= endedAt) throw new Error('price-boundary');
    }
  }
  return price;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid-usage');
  return value;
}

export function validateDeepSeekUsage(value: unknown, maxOutputTokens: number): DeepSeekUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-usage');
  const raw = value as Record<string, unknown>;
  const usage: DeepSeekUsage = {
    promptTokens: count(raw.prompt_tokens),
    cacheHitTokens: count(raw.prompt_cache_hit_tokens),
    cacheMissTokens: count(raw.prompt_cache_miss_tokens),
    completionTokens: count(raw.completion_tokens),
    totalTokens: count(raw.total_tokens),
  };
  if (raw.completion_tokens_details !== undefined) {
    if (
      raw.completion_tokens_details === null ||
      typeof raw.completion_tokens_details !== 'object' ||
      Array.isArray(raw.completion_tokens_details)
    )
      throw new Error('invalid-usage');
    const reasoning = (raw.completion_tokens_details as Record<string, unknown>).reasoning_tokens;
    if (reasoning !== undefined) usage.reasoningTokens = count(reasoning);
  }
  if (
    usage.promptTokens !== usage.cacheHitTokens + usage.cacheMissTokens ||
    usage.totalTokens !== usage.promptTokens + usage.completionTokens ||
    usage.totalTokens > DEEPSEEK_CONTEXT_TOKENS ||
    usage.completionTokens > maxOutputTokens ||
    (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.completionTokens)
  )
    throw new Error('invalid-usage');
  return usage;
}

export function quoteDeepSeekUsage(usage: DeepSeekUsage, period: DeepSeekPricePeriod): bigint {
  const [hit, miss, output] = period === 'peak' ? [40n, 2000n, 8000n] : [20n, 1000n, 4000n];
  return (
    BigInt(usage.cacheHitTokens) * hit + BigInt(usage.cacheMissTokens) * miss + BigInt(usage.completionTokens) * output
  );
}

export function requiredDeepSeekReserve(maxOutputTokens: number): bigint {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > DEEPSEEK_MAX_OUTPUT_TOKENS)
    throw new Error('invalid-max-tokens');
  return BigInt(DEEPSEEK_CONTEXT_TOKENS) * 2000n + BigInt(maxOutputTokens) * 8000n;
}
