import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each test creates its own temp SQLite file, so files can run in parallel,
    // but cap workers to stay light on small machines.
    maxWorkers: 2,
    testTimeout: 20_000,
  },
});
