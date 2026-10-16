import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@data": fileURLToPath(new URL("./data", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/property/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
  },
});
