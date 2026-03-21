import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // @plures/praxis bundles a Svelte-based ReactiveLogicEngine that has a
      // top-level import of svelte/internal/client.  PluresLM is a pure
      // Node.js package and does not use the Svelte reactive engine, so we
      // stub the module to avoid a missing-package error in tests.
      "svelte/internal/client": resolve(__dirname, "test/mocks/svelte-internal-client.ts"),
    },
  },
  test: {
    environment: "node",
    testTimeout: 30000,
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        // Force @plures/praxis through vitest's module resolver so that the
        // svelte/internal/client alias above is applied to its chunks.
        inline: ["@plures/praxis"],
      },
    },
  },
});
