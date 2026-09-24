/**
 * 渲染计数（只在开发构建、且页面显式开启时才计）。
 *
 * 顺序 59 的验证要回答「每个 token 到底让哪些组件重渲染了」——React.Profiler 只给整棵子树的
 * 一次 commit，分不出是谁；所以让关键组件在渲染时各自记一笔。生产构建里 `import.meta.env.DEV`
 * 是常量 false，这段会被整个摇掉；开发构建里没人开 `window.__dramatisRenderCounts` 时也只是一次判断。
 *
 * 开法：`?profile=1`（见 main.tsx），或者在控制台 `window.__dramatisRenderCounts = {}`。
 */
declare global {
  interface Window {
    __dramatisRenderCounts?: Record<string, number>;
    __dramatisCommits?: Array<{ phase: string; actualDuration: number; at: number }>;
  }
}

export function countRender(name: string): void {
  if (!import.meta.env.DEV) return;
  const counts = window.__dramatisRenderCounts;
  if (counts === undefined) return;
  counts[name] = (counts[name] ?? 0) + 1;
}
