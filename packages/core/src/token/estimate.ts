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
 * 启发式估算：全角字符约 1 字符 1 token，其余约 4 字符 1 token。
 *
 * 窄字符部分向上取整，宁可高估也不低估——预算守卫宁愿多留余量。
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

  return wide + Math.ceil(narrow / 4);
}

export const heuristicTokenCounter: TokenCounter = {
  name: 'heuristic-cjk',
  count: estimateTokens,
};
