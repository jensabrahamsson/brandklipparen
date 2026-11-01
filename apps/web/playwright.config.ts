import { defineConfig } from "@playwright/test";
const e2ePort = Number.parseInt(process.env.E2E_PORT ?? "5173", 10);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
  },
  webServer: {
    command: `npx vite preview --port ${e2ePort} --strictPort`,
    port: e2ePort,
    reuseExistingServer: false,
  },
});
