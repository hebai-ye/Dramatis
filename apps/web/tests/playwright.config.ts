import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  testMatch: '**/indexeddb.browser.ts',
  workers: 1,
  timeout: 20_000,
  use: {
    baseURL: 'http://127.0.0.1:6273',
    browserName: 'chromium',
    channel: process.env.Q7_BROWSER_CHANNEL ?? 'msedge',
    trace: 'retain-on-failure',
  },
});
