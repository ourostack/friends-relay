import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/**/*.d.ts",
        // Barrels: pure re-exports, nothing to cover.
        "src/index.ts",
        "src/client/index.ts",
        // Thin shebang entrypoint: all logic lives in server.ts / bootstrap.ts
        // (covered). Its only uncovered lines are the process.* wiring.
        "src/bin.ts",
      ],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
