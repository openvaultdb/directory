// Playwright configuration for the cross-browse journey (CC0-1.0). The journey
// needs two running sites, so it is skipped unless MEANINGGRAPH_BASE_URL and
// OVDB_DIRECTORY_BASE_URL are both set (see journey.spec.mjs).
//
//   MEANINGGRAPH_BASE_URL=http://localhost:4321 \
//   OVDB_DIRECTORY_BASE_URL=http://localhost:4322 \
//   npm run test:journey
//
// JOURNEY_EXPECT_TIMEOUT_MS shortens how long an assertion waits (the self-test uses it).
// PLAYWRIGHT_CHANNEL=chrome runs the installed Google Chrome instead of the
// browser that `npx playwright install chromium` downloads.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: Number(process.env.JOURNEY_EXPECT_TIMEOUT_MS) || 10_000 },
  reporter: [['list']],
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
});
