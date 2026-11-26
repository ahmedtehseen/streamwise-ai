import { defineConfig } from "vitest/config";

// Live evals call Gemini and Supabase, so they never run in the normal test suite.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 2 * 60 * 60 * 1000,
    fileParallelism: false
  }
});
