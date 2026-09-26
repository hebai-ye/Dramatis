/**
 * Token 估算（设计文档 §4.6 预算守卫的度量函数）。
 *
 * 不引入 tokenizer 依赖：M0 只需要一个单调、保守的近似值。
 * 精确分词器可在 M2 通过 `TokenCounter` 注入替换，不影响调用方。
 */
export interface TokenCounter {
  readonly name: string;
  count(text: string): number;
}

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // 中日韩部首与标点
  [0x3041, 0x33ff], // 假名、注音、兼容字符
  [0x3400, 0x4dbf], // 中日韩扩展 A
  [0x4e00, 0x9fff], // 中日韩基本区
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // 中日韩兼容表意
  [0xff00, 0xff60], // 全角形式
  [0x20000, 0x2fa1f], // 扩展 B 及之后
];

function isWideScript(codePoint: number): boolean {
  for (const range of WIDE_RANGES) {
    const start = range[0];
    const end = range[1];
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

/**
 * 窄字符一个 token 抵几个字符（顺序 71 把它提成常量）。
 *
 * 4 是 CommonJS 时代流传下来的经验值（BPE 词表里英文平均约 4 字符一个 token），
 * 对散文够用，对短词密集的文本（对话体、JSON 键值、标记行）会**低估**——
 * 一个词在词表里便宜不到半个 token。这个数是本文件的默认口径，别处要改口径应该
 * 走 `token/calibrate.ts` 的校准报告，而不是在这里手改数字：没有真 tokenizer
 * 可对照时，凭感觉调除数会让英文侧凭空多丢历史。
 */
export const NARROW_CHARS_PER_TOKEN = 4;

/**
 * 启发式估算：全角字符约 1 字符 1 token，其余约 `NARROW_CHARS_PER_TOKEN` 字符 1 token。
 *
 * 窄字符部分向上取整，宁可高估也不低估——预算守卫宁愿多留余量。
 *
 * 这个口径**没有**跟真实服务商的分词器对齐过（离线环境装不了 tokenizer）。
 * 想知道它到底低估多少，用账单里配对的「估算 / 真实 promptTokens」算一次
 * `usageCalibration` 或 `calibrateCounts`（顺序 71）。
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (isWideScript(codePoint)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }

  return wide + Math.ceil(narrow / NARROW_CHARS_PER_TOKEN);
}

export const heuristicTokenCounter: TokenCounter = {
  name: 'heuristic-cjk',
  count: estimateTokens,
};
