/**
 * @internal
 * Test-only helpers for the PluresLM plugin.
 *
 * This module is intentionally NOT listed in the package.json `exports` map so
 * it cannot be imported by name from the public package entrypoint
 * (`@plures/plureslm`). Tests reference it via a direct source path:
 *   `import { _setIngestState } from "../../src/test-helpers.js";`
 */

import type { PluresDBBackend } from "./pluresdb-backend.js";
import { ingestState } from "./ingest-state.js";
import { _archive } from "./archive-state.js";
import { _packRegistry } from "./pack-state.js";

/**
 * Inject backend dependencies for the document ingestion API.
 * Used in unit tests to set up module state without running the full plugin.
 */
export function _setIngestState(
  db: PluresDBBackend | null,
  embedText: ((text: string) => Promise<number[]>) | null,
): void {
  ingestState.db = db;
  ingestState.embedText = embedText;
}

/**
 * Reset the module-level MemoryArchive singleton used by the archive API.
 * Call in afterEach to prevent module state from leaking between tests.
 */
export function _resetArchive(): void {
  for (const id of _archive.listModules()) {
    _archive.dropModule(id);
  }
}

/**
 * Reset the module-level PackRegistry singleton used by the pack API.
 * Call in afterEach to prevent module state from leaking between tests.
 */
export function _resetPackRegistry(): void {
  for (const { moduleId } of _packRegistry.list()) {
    _packRegistry.unregister(moduleId);
  }
}
