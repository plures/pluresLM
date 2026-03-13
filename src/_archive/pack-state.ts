import { PackRegistry } from "./memory-pack.js";

/**
 * @internal
 * Module-level PackRegistry singleton shared by the public pack API
 * functions in src/index.ts and the test-reset helper in src/test-helpers.ts.
 */
export const _packRegistry = new PackRegistry();
