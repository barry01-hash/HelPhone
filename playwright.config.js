import { defineConfig } from '@playwright/test'

export default defineConfig({
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' },
  },
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:vite',
    port: 3000,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    // Throttling runs in its own project: slow-network navigations need a much
    // larger timeout and would make the default suite crawl.
    { name: 'chromium', testIgnore: /throttling\.spec\.ts/, use: { browserName: 'chromium' } },
    {
      name: 'throttling',
      testMatch: /throttling\.spec\.ts/,
      timeout: 180_000,
      use: { browserName: 'chromium' },
    },
  ],
})
