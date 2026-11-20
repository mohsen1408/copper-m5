// Module 5: the golden-set evaluation (npm run eval). Separate from the unit
// tests because it calls the real model and takes a few minutes.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 30 * 60 * 1000,
    // One question at a time, to stay under the model's rate limits.
    fileParallelism: false,
  },
});
