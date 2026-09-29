import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
