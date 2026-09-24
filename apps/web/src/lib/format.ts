/**
 * 界面上那几个「给人看」的格式（顺序 65 收敛重复）。
 *
 * `formatTime` 原本在四处各写了一份（记忆面板 / 设置 / 用量 / 同步），差别只有
 * null 时显示什么；`formatBytes` 原本住在 `lib/storage.ts` 里——它跟存储没关系，
 * 谁要显示体积都得绕到那个模块去拿。两件都收在这里。
 */

/**
 * 「9月24日 23:16」那种短时间。
 *
 * `null` 或空串用 `fallback`（同步面板要写「还没同步过」，别处写空）；
 * 有值但解析不出来时给空串——写「Invalid Date」不如什么都不写。
 */
export function formatTime(iso: string | null, fallback = ''): string {
  if (iso === null || iso.trim() === '') return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 体积：B / KB / MB / GB，一位或两位小数（配额那行要用）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
