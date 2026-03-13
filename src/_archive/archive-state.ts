import { MemoryArchive } from "./memory-archive.js";

/**
 * @internal
 * Module-level MemoryArchive singleton shared by the public archive API
 * functions in src/index.ts and the test-reset helper in src/test-helpers.ts.
 *
 * Exporting the instance (rather than creating it inline in index.ts) allows
 * test-helpers to clear registered modules between test runs without needing
 * a separate setter.
 */
export const _archive = new MemoryArchive();
