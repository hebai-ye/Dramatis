import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  testMatch: '**/sw-lifecycle.browser.ts',
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: './sw/.local/results',
  use: {
    browserName: 'chromium',
    channel: process.env.SW_BROWSER_CHANNEL ?? 'msedge',
    serviceWorkers: 'allow',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      args: ['--disable-background-networking', '--disable-component-update', '--no-default-browser-check'],
    },
  },
});
