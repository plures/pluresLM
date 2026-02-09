/**
 * Superlocalmemory library exports.
 *
 * This file is intended for use by other projects importing the SQLite-backed
 * memory DB and embedding providers directly.
 */

import { MemoryDB } from "./memory-db.js";
import { DualEmbeddings, OpenAIEmbeddings, OllamaEmbeddings } from "./embeddings.js";
import { MemorySync } from "./sync.js";

export { MemoryDB } from "./memory-db.js";
export type { MemoryEntry, MemorySearchResult, ProfileData } from "./memory-db.js";

export { DualEmbeddings, OpenAIEmbeddings, OllamaEmbeddings } from "./embeddings.js";
export type { EmbeddingProvider } from "./embeddings.js";

export { MemorySync } from "./sync.js";
export type { SyncOptions } from "./sync.js";

/**
 * Convenience default export (tree-shakable in modern bundlers).
 */
const lib = {
  MemoryDB,
  DualEmbeddings,
  OpenAIEmbeddings,
  OllamaEmbeddings,
  MemorySync,
};

export default lib;
