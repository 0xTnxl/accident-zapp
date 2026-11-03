import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against production builds, each served by Playwright for the length of the
 * run only. They use the system Chrome rather than downloading a browser.
 *
 *   pnpm --filter @accident/web build build:sim
 *   pnpm --filter @accident/web e2e
 *
 * Two builds are served:
 *  - `dist/` (live settings) on 4173: the computer game, which needs no backend, and the message
 *    friend mode shows when it has not been configured.
 *  - `dist-sim/` (simulation) on 4174: friend mode against a pretend chain and a tab-to-tab relay.
 */
const chrome = process.env.CHROME_PATH ?? '/usr/local/bin/chrome';
const launchOptions = { executablePath: chrome, args: ['--no-sandbox'] };
const device = { ...devices['Pixel 7'], launchOptions };

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', launchOptions },
  projects: [
    {
      name: 'live',
      testMatch: [
        'practice.spec.ts',
        'unconfigured.spec.ts',
        'analytics.spec.ts',
        'verify.spec.ts',
      ],
      use: { ...device, baseURL: 'http://127.0.0.1:4173' },
    },
    {
      name: 'sim',
      testMatch: ['friend.spec.ts', 'resilience.spec.ts'],
      use: { ...device, baseURL: 'http://127.0.0.1:4174' },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec vite preview --port 4173 --host 127.0.0.1 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm exec vite preview --outDir dist-sim --port 4174 --host 127.0.0.1 --strictPort',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
