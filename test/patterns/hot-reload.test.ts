/**
 * Hot-reload tests
 *
 * These tests cover file-change detection and pattern reloading.
 * Depends on: plures/pluresLM#51 (YAML patterns)
 */

import { describe, it } from "vitest";

describe("hot-reload", () => {
  it.todo("detects new pattern file and loads it");
  it.todo("reloads modified pattern file on change");
  it.todo("removes deleted pattern from active set");
  it.todo("does not reload unchanged files");
});
