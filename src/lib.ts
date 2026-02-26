/**
 * Plures LM library exports.
 */

import { PluresDBBackend } from "./pluresdb-backend.js";
import { DualEmbeddings, OllamaEmbeddings } from "./embeddings.js";
import { MemorySync } from "./sync.js";
import { parseMemoryMd, parseDailyFile, parseDailyDirectory, importMemories, verifyMigration } from "./migration.js";

export { PluresDBBackend } from "./pluresdb-backend.js";
export type { MemoryEntry, MemorySearchResult, ProfileData, DailySummary, StoreContentOpts } from "./types.js";

export { DualEmbeddings, OllamaEmbeddings } from "./embeddings.js";
export type { EmbeddingProvider } from "./embeddings.js";

export { MemorySync } from "./sync.js";
export type { SyncOptions } from "./sync.js";

export { ErrorCapture, ERROR_PATTERN_CATEGORY } from "./ops/error-capture.js";
export type { CaptureErrorOpts } from "./ops/error-capture.js";

export { RepoKnowledge, REPO_CONTEXT_CATEGORY } from "./ops/repo-knowledge.js";
export type { CaptureRepoContextOpts } from "./ops/repo-knowledge.js";

export { PreferenceTracker, PREFERENCE_CATEGORY } from "./ops/preference-tracker.js";
export type { CapturePreferenceOpts, PreferenceOverrideType } from "./ops/preference-tracker.js";

export { DelegationHelper } from "./ops/delegation-helper.js";
export type { DelegationHelperOpts } from "./ops/delegation-helper.js";

export { MemoryAPI, detectCategory, isTrivial, injectContext } from "./memory-api.js";
export { shouldCapture, DEFAULT_CAPTURE_QUALITY_CONFIG } from "./capture-quality.js";
export type { CaptureQualityConfig } from "./capture-quality.js";

export type {
  ErrorFixMemory,
  RepoContextMemory,
  PreferenceMemory,
  TemporalPatternMemory,
  DelegationTarget,
  DelegationDecision,
} from "./ops/types.js";

import { ErrorCapture } from "./ops/error-capture.js";
import { RepoKnowledge } from "./ops/repo-knowledge.js";
import { PreferenceTracker } from "./ops/preference-tracker.js";
import { DelegationHelper } from "./ops/delegation-helper.js";
import { MemoryAPI, detectCategory, isTrivial, injectContext } from "./memory-api.js";
import { shouldCapture } from "./capture-quality.js";

const lib = {
  PluresDBBackend,
  DualEmbeddings,
  OllamaEmbeddings,
  MemorySync,
  parseMemoryMd,
  parseDailyFile,
  parseDailyDirectory,
  importMemories,
  verifyMigration,
  ErrorCapture,
  RepoKnowledge,
  PreferenceTracker,
  DelegationHelper,
  MemoryAPI,
  detectCategory,
  isTrivial,
  injectContext,
  shouldCapture,
};

export default lib;
