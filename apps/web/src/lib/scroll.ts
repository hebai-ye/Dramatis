/** 滚动容器是否贴着底部（默认 80px 内算贴着，审计 B17）。 */
export function isNearBottom(
  node: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 80,
): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}
