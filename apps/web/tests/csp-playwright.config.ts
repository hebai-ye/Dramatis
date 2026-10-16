import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  testMatch: '**/csp-*.browser.ts',
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: 'list',
  outputDir: './csp/.local/results',
  use: {
    baseURL: 'http://127.0.0.1:6289',
    browserName: 'chromium',
    channel: 'msedge',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'block',
  },
});
