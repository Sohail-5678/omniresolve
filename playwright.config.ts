import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3219);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start --port ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { DEFAULT_MODE: "replay", GROQ_API_KEY: "", GROQ_API_KEY_2: "", GEMINI_API_KEY: "" },
      },
});
