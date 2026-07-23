import { defineConfig } from "vitest/config";

// Manual integration suite that drives the MCP tools against a real GitHub
// repository. Deliberately separate from vitest.config.ts so neither the
// default `npm test` run nor CI ever picks it up. See CONTRIBUTING.md for
// the required setup.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.itest.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
