import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  testMatch: '**/ui-*.browser.ts',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:6287',
    browserName: 'chromium',
    channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
