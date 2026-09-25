/**
 * 普通聊天模型的一轮生成上限。推理模型的 max_tokens 常把隐藏推理也计入；
 * 对它们不发硬上限，避免推理耗尽额度后正文为空。
 */
export function replyTokenLimit(model: string, reserveForReply: number): number | undefined {
  if (/(?:reason(?:er|ing)?|thinking|(?:^|[-_/])r1(?:$|[-_/])|(?:^|[-_/])o[134](?:$|[-_/]))/i.test(model)) {
    return undefined;
  }
  const reserve = Number.isFinite(reserveForReply) ? Math.floor(reserveForReply) : 512;
  return Math.min(512, Math.max(128, reserve));
}
