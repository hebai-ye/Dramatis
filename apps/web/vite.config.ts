import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  optimizeDeps: {
    // core 以 TS 源码形式被消费，交给 Vite 编译而不是预打包
    exclude: ['@dramatis/core'],
  },
});
