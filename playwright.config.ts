import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "https://127.0.0.1:3100",
    // The local test server uses a disposable self-signed loopback certificate.
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm run build && node scripts/start-e2e-server.mjs",
    url: "https://127.0.0.1:3100",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "https://ci.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "ci-publishable-key",
    },
  },
});
