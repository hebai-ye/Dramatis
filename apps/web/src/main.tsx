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
