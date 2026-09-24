/**
 * 解析外来 JSON 时的几个小工具（顺序 65 收敛重复）。
 *
 * 这些函数在兼容 SillyTavern 卡、世界书、模型返回的 JSON、同步请求体时**各写了一份**——
 * 七处 `asRecord`、两处 `str`、一处 `text`、一处 `toFinite`。它们要求的行为完全一样：
 * 「拿不准就退回默认值，绝不抛」，所以合成一份，改一处就都改到。
 *
 * 为什么单独一份而不是内联：宽松解析是**安全边界**（模型与第三方文件的形状不可信），
 * 写得越分散，越容易出现「这一路宽容、那一路严格」的漂移。
 */

/** 是普通对象（不是 null、不是数组）时给出来，否则 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 字符串就原样给它，别的给 `fallback`（默认空串）。**不 trim**。 */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 字符串就 trim 后给它，别的给 `fallback`（默认空串）。 */
export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * 有限数字就给它，否则 `fallback`（默认 0）。
 *
 * `NaN` 与 `±Infinity` 都当「没给」——JSON 里它们本来也不是合法数字，
 * 能被解析出来多半是上游自己算坏了，拿它做累加会污染整个数值。
 */
export function toFinite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
