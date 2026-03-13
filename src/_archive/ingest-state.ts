import type { PluresDBBackend } from "./pluresdb-backend.js";

/**
 * @internal
 * Mutable singleton holding the active backend refs for the public document
 * ingestion API. Populated by register() and cleared by stop(). Using a plain
 * object (rather than two module-level `let` bindings) allows the state to be
 * written from sibling modules (e.g. src/test-helpers.ts) without requiring an
 * exported setter on the main package entrypoint.
 */
export const ingestState: {
  db: PluresDBBackend | null;
  embedText: ((text: string) => Promise<number[]>) | null;
} = {
  db: null,
  embedText: null,
};
