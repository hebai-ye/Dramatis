import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { syncDevBackend } from './tools/sync-dev-backend.ts';

export default defineConfig({
  // 第二个插件只在开发 / 预览时提供「同步服务端」（同一份内核逻辑，存 JSON 文件）
  plugins: [react(), syncDevBackend()],
  server: {
    port: 5173,
  },
  optimizeDeps: {
    // core 以 TS 源码形式被消费，交给 Vite 编译而不是预打包
    exclude: ['@dramatis/core'],
  },
  ssr: {
    // 开发后端（sync-dev-backend）要用 vite 的模块加载器读 core，别当成外部依赖
    noExternal: ['@dramatis/core'],
  },
});
