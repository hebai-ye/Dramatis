import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PlanPage } from './plan/PlanPage';
import './styles.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('找不到 #root 挂载点');
}

// 布局规划页挂在 ?plan=1 上：它是设计阶段的工具，不该出现在产品流程里
const isPlanMode = new URLSearchParams(window.location.search).get('plan') === '1';

createRoot(container).render(<StrictMode>{isPlanMode ? <PlanPage /> : <App />}</StrictMode>);

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
