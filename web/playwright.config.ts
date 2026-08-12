import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run build && npm run start:e2e",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 120_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});
