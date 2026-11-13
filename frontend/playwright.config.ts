import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// One random password per run for the fictional accounts of the test API (never written anywhere).
process.env['E2E_PASSWORD'] ??= `E2e-${randomBytes(12).toString('base64url')}-9a`;

/**
 * End-to-end tests of the offline mode, against the production build (real service worker) and an isolated
 * API (temporary database). Run with `npm run e2e`. Uses the Chrome installed on the machine.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  timeout: 180_000,
  expect: { timeout: 25_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4311',
    channel: 'chrome',
    serviceWorkers: 'allow',
    viewport: { width: 1280, height: 900 },
    locale: 'fr-FR',
  },
  webServer: [
    { command: 'node e2e/backend.mjs', url: 'http://127.0.0.1:8011/api/sync/ping/', timeout: 120_000, reuseExistingServer: false },
    { command: 'node e2e/static-server.mjs', url: 'http://localhost:4311/', timeout: 30_000, reuseExistingServer: false },
  ],
});
