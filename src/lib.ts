/**
 * Superlocalmemory library exports.
 */

import { MemoryDB } from "./memory-db.js";
import { DualEmbeddings, OllamaEmbeddings } from "./embeddings.js";
import { MemorySync } from "./sync.js";
import { parseMemoryMd, parseDailyFile, parseDailyDirectory, importMemories, verifyMigration } from "./migration.js";

export { MemoryDB } from "./memory-db.js";
export type { MemoryEntry, MemorySearchResult, ProfileData } from "./memory-db.js";

export { DualEmbeddings, OllamaEmbeddings } from "./embeddings.js";
export type { EmbeddingProvider } from "./embeddings.js";

export { MemorySync } from "./sync.js";
export type { SyncOptions } from "./sync.js";

const lib = {
  MemoryDB,
  DualEmbeddings,
  OllamaEmbeddings,
  MemorySync,
  parseMemoryMd,
  parseDailyFile,
  parseDailyDirectory,
  importMemories,
  verifyMigration,
};

export default lib;
