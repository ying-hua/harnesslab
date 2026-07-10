import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@harnesslab/core": path.resolve(root, "packages/core/src/index.ts"),
      "@harnesslab/adapter-claude-code": path.resolve(
        root,
        "packages/adapters/claude-code/src/index.ts",
      ),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "packages/**/src/**/*.test.ts"],
  },
});
