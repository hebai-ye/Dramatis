import { Profiler, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PlanPage } from './plan/PlanPage';
import './styles.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('找不到 #root 挂载点');
}

const params = new URLSearchParams(window.location.search);
// 布局规划页挂在 ?plan=1 上：它是设计阶段的工具，不该出现在产品流程里
const isPlanMode = params.get('plan') === '1';
/*
 * 渲染剖析挂在 ?profile=1 上（只在开发构建里有效，顺序 59 的验证用）：
 * 根上套一层 Profiler 记每次 commit 的耗时，各关键组件各自记渲染次数（lib/render-count.ts），
 * 验证脚本读 `window.__dramatisCommits` / `window.__dramatisRenderCounts`。
 */
const isProfileMode = import.meta.env.DEV && params.get('profile') === '1';
if (isProfileMode) {
  window.__dramatisRenderCounts = {};
  window.__dramatisCommits = [];
}

const tree = isPlanMode ? <PlanPage /> : <App />;
createRoot(container).render(
  <StrictMode>
    {isProfileMode ? (
      <Profiler
        id="app"
        onRender={(_id, phase, actualDuration) => {
          window.__dramatisCommits?.push({ phase, actualDuration, at: performance.now() });
        }}
      >
        {tree}
      </Profiler>
    ) : (
      tree
    )}
  </StrictMode>,
);

/**
 * 注册 Service Worker（P2-2）。
 *
 * **只在生产构建里注册**：开发时它会把模块缓存住，改完代码刷新看不到变化，
 * 白白浪费一轮排查。离线可用是给用户的功能，不是开发时的便利。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败不影响使用：应用照常联网工作，只是没有离线外壳
    });
  });
}
