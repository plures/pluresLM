/**
 * Public API handler functions exported from PluresLM.
 *
 * Each function operates on module-level singletons (ingestState, _archive,
 * _packRegistry) so they can be exercised in tests without a running plugin.
 */

import { ingestState } from "./ingest-state.js";
import { _archive } from "./archive-state.js";
import { _packRegistry } from "./pack-state.js";
import { DocumentProcessor } from "./document-processor.js";
import {
  DEFAULT_ARCHIVE_POLICY,
  type ArchiveBundle,
  type ArchivePolicy,
  type ClassifyResult,
  type RestoreResult,
} from "./memory-archive.js";
import {
  signPack,
  verifyPackSignature,
  checkPackCompatibility,
  type MemoryPack,
  type PackProvenance,
  type PackEmbeddingMeta,
  type PackImportResult,
  type InstalledPackInfo,
} from "./memory-pack.js";
import {
  OPTIMIZATION_TRAP_SCHEMA_VERSION,
  OPTIMIZATION_TRAP_CATEGORY,
  encodeOptimizationTrap,
  decodeOptimizationTrap,
  trapsToJsonl,
  contextFingerprint,
  type OptimizationTrap,
} from "./optimization-trap.js";
import {
  CLASSIFIER_SIGNAL_SCHEMA_VERSION,
  extractClassifierSignals,
  signalsToJsonl,
  type ClassifierSignal,
  type ClassifierExportOptions,
} from "./classifier-signal.js";
import { generateEvalReport, type ClassifierEvalReport } from "./classifier-eval.js";
import type {
  DocumentMetadata,
  DocumentSource,
  MemoryOutcome,
  TrainingFormat,
  TrainingStats,
} from "./types.js";

// ---------------------------------------------------------------------------
// Guard helper
// ---------------------------------------------------------------------------

function requireInitialised(): NonNullable<typeof ingestState.db> {
  if (!ingestState.db) throw new Error("pluresLM is not initialised");
  return ingestState.db;
}

// ============================================================================
// Document Ingestion API
// ============================================================================

/**
 * Ingest a document into PluresDB.
 * Processes `text` into semantic chunks, stores a parent document entry and
 * one chunk entry per chunk, all tagged with a common `document:<id>` source.
 */
export async function pluresLM_ingest_document(
  text: string,
  metadata: DocumentMetadata,
): Promise<{ documentId: string; chunkIds: string[] }> {
  const db = requireInitialised();

  const processor = new DocumentProcessor({
    embeddings: ingestState.embedText
      ? { embed: (t) => ingestState.embedText!(t), dimension: 0 /* not used by DocumentProcessor */ }
      : undefined,
  });

  const processed = await processor.processDocument(text, metadata);

  const metaTags = Object.entries(metadata ?? {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => `meta:${k}:${String(v)}`);

  // Store parent document entry first to get its assigned UUID
  const { entry: docEntry } = await db.storeContent(text, {
    source: "",
    category: "document",
    tags: metaTags,
  });

  const documentId = docEntry.id;
  const source = `document:${documentId}`;

  // Update the document entry's source to the canonical `document:<id>` form
  const { embedding: _emb, ...docNoEmbed } = docEntry;
  void _emb;
  await db.storeRaw({ ...docNoEmbed, source });

  // Store chunk entries with the canonical source
  const chunkIds: string[] = [];
  for (const chunk of processed.chunks) {
    const { entry } = await db.storeContent(chunk.text, {
      source,
      category: "document-chunk",
      tags: [`chunk:index:${chunk.chunkIndex}`],
    });
    chunkIds.push(entry.id);
  }

  return { documentId, chunkIds };
}

/**
 * List all top-level ingested documents.
 */
export async function pluresLM_list_sources(): Promise<DocumentSource[]> {
  const db = requireInitialised();

  const all = await db.listMemories();
  const docEntries = all.filter((e) => e.category === "document");

  const sources: DocumentSource[] = [];
  for (const doc of docEntries) {
    const docSource = `document:${doc.id}`;
    const chunks = all.filter((e) => e.category === "document-chunk" && e.source === docSource);

    // Reconstruct metadata from meta: tags
    const metadata: DocumentMetadata = {};
    for (const tag of doc.tags ?? []) {
      if (tag.startsWith("meta:")) {
        const rest = tag.slice(5);
        const colon = rest.indexOf(":");
        if (colon >= 0) {
          const key = rest.slice(0, colon);
          const val = rest.slice(colon + 1);
          (metadata as Record<string, string>)[key] = val;
        }
      }
    }

    // Derive title/summary from document content heuristically (no LLM in handlers)
    const lines = doc.content.split("\n").filter(Boolean);
    const title = lines[0]?.slice(0, 120) ?? "";
    const summary = lines.slice(1, 3).join(" ").slice(0, 250);

    sources.push({
      id: doc.id,
      title,
      summary,
      keyTopics: [],
      metadata,
      chunkCount: chunks.length,
      createdAt: doc.created_at,
    });
  }

  return sources;
}

/**
 * Delete an ingested document and all its chunks from the store.
 */
export async function pluresLM_delete_source(documentId: string): Promise<void> {
  const db = requireInitialised();

  const all = await db.listMemories();
  const docSource = `document:${documentId}`;
  const toDelete = all.filter((e) => e.source === docSource);

  for (const entry of toDelete) {
    await db.delete(entry.id);
  }
}

// ============================================================================
// Memory Archive API
// ============================================================================

/**
 * Classify all memories in the store according to the archive policy.
 */
export async function pluresLM_classify_memories(
  policy?: Partial<ArchivePolicy>,
): Promise<ClassifyResult> {
  const db = requireInitialised();

  const entries = await db.listMemories();
  return _archive.classifyMemories(entries, { ...DEFAULT_ARCHIVE_POLICY, ...(policy ?? {}) });
}

/**
 * Export a list of memory entries into an ArchiveBundle.
 */
export async function pluresLM_export_bundle(
  ids: string[],
  moduleId?: string,
): Promise<ArchiveBundle> {
  const db = requireInitialised();

  const entries = await db.getMemoriesByIds(ids);
  return _archive.exportBundle(entries, moduleId);
}

/**
 * Verify and restore entries from an ArchiveBundle into the active store.
 */
export async function pluresLM_restore_bundle(bundle: ArchiveBundle): Promise<RestoreResult> {
  const db = requireInitialised();

  const { entries, result } = _archive.restoreBundle(bundle);
  for (const entry of entries) {
    await db.storeRaw(entry);
  }
  return result;
}

/**
 * Detach a group of memories from the active store into a named cold module.
 */
export async function pluresLM_detach_module(
  ids: string[],
  moduleId: string,
): Promise<ArchiveBundle> {
  const db = requireInitialised();

  const entries = await db.getMemoriesByIds(ids);
  const bundle = _archive.detach(entries, moduleId);

  for (const id of ids) {
    await db.delete(id);
  }

  return bundle;
}

/**
 * Attach (restore) a previously-detached module back into the active store.
 * If `bundle` is provided it is registered first (enabling external cold storage).
 */
export async function pluresLM_attach_module(
  moduleId: string,
  bundle?: ArchiveBundle,
): Promise<RestoreResult | null> {
  const db = requireInitialised();

  if (bundle !== undefined) {
    _archive.registerBundle(bundle, moduleId);
  }

  const result = _archive.attach(moduleId);
  if (!result) return null;

  for (const entry of result.entries) {
    await db.storeRaw(entry);
  }
  return result.result;
}

// ============================================================================
// Memory Pack API
// ============================================================================

/**
 * Export selected memories as a distributable MemoryPack.
 */
export async function pluresLM_export_pack(
  ids: string[],
  provenance: Omit<PackProvenance, "createdAt">,
  embeddingMeta: PackEmbeddingMeta,
  opts: { signingKey?: string; moduleId?: string } = {},
): Promise<MemoryPack> {
  const db = requireInitialised();

  const entries = await db.getMemoriesByIds(ids);
  const bundle = _archive.exportBundle(entries, opts.moduleId);

  const fullProvenance: PackProvenance = {
    ...provenance,
    createdAt: new Date().toISOString(),
  };

  let pack: MemoryPack = {
    packVersion: "1",
    bundle,
    provenance: fullProvenance,
    embeddingMeta,
  };

  if (opts.signingKey) {
    pack = signPack(pack, opts.signingKey);
  }

  return pack;
}

/**
 * Verify the signature on a MemoryPack.
 */
export function pluresLM_verify_pack(pack: MemoryPack, signingKey: string): boolean {
  return verifyPackSignature(pack, signingKey);
}

/**
 * Import a MemoryPack into the active store.
 */
export async function pluresLM_import_pack(
  pack: MemoryPack,
  opts: {
    currentModelName?: string;
    currentDimensions?: number;
    currentModelVersion?: string;
    signingKey?: string;
    requireCompatibleModel?: boolean;
    requireSignature?: boolean;
  } = {},
): Promise<PackImportResult> {
  const db = requireInitialised();

  const warnings: string[] = [];

  // Signature check
  const hasSignature = pack.signature != null;
  if (opts.requireSignature) {
    if (!hasSignature) {
      throw new Error("requireSignature is set but the pack has no signature");
    }
    if (!opts.signingKey) {
      throw new Error("requireSignature is set but no signingKey was provided");
    }
  }
  if (hasSignature && opts.signingKey) {
    if (!verifyPackSignature(pack, opts.signingKey)) {
      if (opts.requireSignature) {
        throw new Error("Pack signature verification failed — pack may have been tampered with");
      }
      warnings.push("Pack signature verification failed — pack may have been tampered with");
    }
  } else if (hasSignature && !opts.signingKey) {
    warnings.push("Pack has a signature but no signingKey was provided for verification");
  } else if (!hasSignature) {
    warnings.push("Pack is unsigned — provenance cannot be cryptographically verified");
  }

  // Embedding compatibility check
  const compat = checkPackCompatibility(
    pack,
    opts.currentModelName,
    opts.currentDimensions,
    opts.currentModelVersion,
  );
  if (!compat.compatible && opts.requireCompatibleModel) {
    throw new Error(compat.warnings[0] ?? "Embedding model incompatibility");
  }
  warnings.push(...compat.warnings);

  // Restore entries
  const { entries, result } = _archive.restoreBundle(pack.bundle);
  for (const entry of entries) {
    await db.storeRaw(entry);
  }

  // Register pack only when at least one entry was restored
  const moduleId = pack.bundle.manifest.moduleId ?? `pack-${Date.now()}`;
  if (result.restored > 0) {
    _packRegistry.register(moduleId, pack, result.restored);
  } else {
    warnings.push(`Pack not registered because no entries were restored (not registered)`);
  }

  return {
    restored: result.restored,
    corrupted: result.corrupted,
    provenance: pack.provenance,
    embeddingCompatible: compat.compatible,
    warnings,
  };
}

/**
 * Uninstall (rollback) a previously-imported MemoryPack, removing all its
 * entries from the active store.
 */
export async function pluresLM_uninstall_pack(
  moduleId: string,
): Promise<{ removed: number; notFound: string[] } | null> {
  const db = requireInitialised();

  const bundle = _packRegistry.unregister(moduleId);
  if (!bundle) return null;

  let removed = 0;
  const notFound: string[] = [];

  for (const bundleEntry of bundle.entries) {
    const deleted = await db.delete(bundleEntry.id);
    if (deleted) {
      removed++;
    } else {
      notFound.push(bundleEntry.id);
    }
  }

  return { removed, notFound };
}

/**
 * List all installed (imported) MemoryPacks.
 */
export function pluresLM_list_packs(): InstalledPackInfo[] {
  return _packRegistry.list();
}

// ============================================================================
// Optimization Trap API
// ============================================================================

/**
 * Store an optimization trap record in the memory store.
 */
export async function pluresLM_store_optimization_trap(
  trap: Omit<OptimizationTrap, "id" | "schemaVersion" | "recordedAt">,
): Promise<OptimizationTrap> {
  const db = requireInitialised();

  const recordedAt = Date.now();
  const { content, tags, outcomeDescription } = encodeOptimizationTrap(trap);

  // Map trap outcome to MemoryOutcome
  const memoryOutcome: MemoryOutcome = trap.outcome === "avoided" ? "success" : "failure";

  const { entry } = await db.storeContent(content, {
    source: "agent",
    category: OPTIMIZATION_TRAP_CATEGORY,
    tags,
    outcome: memoryOutcome,
    outcome_evidence: outcomeDescription ?? undefined,
    outcome_timestamp: recordedAt,
  });

  return {
    id: entry.id,
    schemaVersion: OPTIMIZATION_TRAP_SCHEMA_VERSION,
    objective: trap.objective,
    contextSignature: trap.contextSignature,
    missingSignals: trap.missingSignals,
    unsafeRecommendationPattern: trap.unsafeRecommendationPattern,
    outcome: trap.outcome,
    outcomeDescription: trap.outcomeDescription,
    correctiveGuardrail: trap.correctiveGuardrail,
    recordedAt,
  };
}

/**
 * Find optimization traps similar to the given query.
 * Uses vector search when embedText is available; falls back to returning all
 * stored traps (filtered by category) when it is not.
 */
export async function pluresLM_find_similar_traps(
  query: string,
  limit = 10,
): Promise<OptimizationTrap[]> {
  const db = requireInitialised();

  if (ingestState.embedText) {
    const queryEmbedding = await ingestState.embedText(query);
    const results = await db.vectorSearch(queryEmbedding, limit, 0);
    return results
      .map((r) => decodeOptimizationTrap(r.entry))
      .filter((t): t is OptimizationTrap => t !== null);
  }

  // Fallback: list all trap memories
  const all = await db.listMemories();
  const traps = all
    .filter((e) => e.category === OPTIMIZATION_TRAP_CATEGORY)
    .map((e) => decodeOptimizationTrap(e))
    .filter((t): t is OptimizationTrap => t !== null);

  return traps.slice(0, limit);
}

/**
 * Export all stored optimization traps as JSONL.
 */
export async function pluresLM_export_optimization_traps(): Promise<string> {
  const db = requireInitialised();

  const all = await db.listMemories();
  const traps = all
    .filter((e) => e.category === OPTIMIZATION_TRAP_CATEGORY)
    .map((e) => decodeOptimizationTrap(e))
    .filter((t): t is OptimizationTrap => t !== null);

  return trapsToJsonl(traps);
}

/**
 * Compute a stable context fingerprint for a set of context signature tokens.
 */
export function pluresLM_trap_context_fingerprint(contextSignature: string[]): string {
  return contextFingerprint(contextSignature);
}

// ============================================================================
// Classifier Signal API
// ============================================================================

export { CLASSIFIER_SIGNAL_SCHEMA_VERSION } from "./classifier-signal.js";

/**
 * Export classifier training signals as JSONL.
 */
export async function pluresLM_export_classifier_signals(
  opts: ClassifierExportOptions = {},
): Promise<string> {
  const db = requireInitialised();

  const entries = await db.listAllMemoriesNoEmbedding();
  const signals = extractClassifierSignals(entries, opts);
  return signalsToJsonl(signals);
}

/**
 * Run classifier evaluation and return a report.
 */
export async function pluresLM_eval_classifier(
  opts: ClassifierExportOptions = {},
  referenceSignals?: ClassifierSignal[],
): Promise<ClassifierEvalReport> {
  const db = requireInitialised();

  const entries = await db.listAllMemoriesNoEmbedding();
  const signals = extractClassifierSignals(entries, opts);
  return generateEvalReport(signals, referenceSignals);
}

// ============================================================================
// Training Export API
// ============================================================================

/**
 * Record the outcome of a memory (success/failure/partial/unknown).
 */
export async function pluresLM_record_outcome(
  memoryId: string,
  outcome: MemoryOutcome,
  evidence?: string,
): Promise<boolean> {
  const db = requireInitialised();
  return db.updateOutcome(memoryId, outcome, evidence);
}

function outcomeScore(outcome: MemoryOutcome | undefined): number {
  if (outcome === "success") return 1.0;
  if (outcome === "failure") return 0.0;
  return 0.5; // partial, unknown, undefined
}

/**
 * Export training data in the requested format (sft, dpo, rlhf) as JSONL.
 * @param format Training format.
 * @param minConfidence Optional minimum confidence threshold (0-1).
 */
export async function pluresLM_export_training(
  format: TrainingFormat,
  minConfidence = 0,
): Promise<string> {
  const db = requireInitialised();

  const all = await db.listMemories();
  const lines: string[] = [];

  if (format === "sft") {
    for (const entry of all) {
      if (!entry.conversation_window?.length) continue;
      const conf = entry.confidence ?? 0.5;
      if (conf < minConfidence) continue;
      lines.push(
        JSON.stringify({
          messages: entry.conversation_window.map((w) => ({ role: w.role, content: w.content })),
        }),
      );
    }
  } else if (format === "dpo") {
    for (const entry of all) {
      if (!entry.chosen_approach || !entry.rejected_approach) continue;
      const prompt =
        entry.conversation_window?.[0]?.content ?? entry.content;
      lines.push(
        JSON.stringify({
          prompt,
          chosen: entry.chosen_approach,
          rejected: entry.rejected_approach,
        }),
      );
    }
  } else if (format === "rlhf") {
    for (const entry of all) {
      const conf = entry.confidence ?? 0.5;
      const reward = conf * outcomeScore(entry.outcome);
      lines.push(
        JSON.stringify({
          prompt: entry.content,
          response: entry.content,
          reward,
        }),
      );
    }
  }

  return lines.join("\n");
}

/**
 * Return aggregate statistics about training-ready memories in the store.
 */
export async function pluresLM_get_training_stats(): Promise<TrainingStats> {
  const db = requireInitialised();

  const all = await db.listMemories();

  let withOutcome = 0;
  let withConfidence = 0;
  let withConversationWindow = 0;
  let withChosenRejected = 0;
  const outcomeDist: Record<string, number> = {};
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const entry of all) {
    if (entry.outcome != null) {
      withOutcome++;
      outcomeDist[entry.outcome] = (outcomeDist[entry.outcome] ?? 0) + 1;
    }
    if (entry.confidence != null) {
      withConfidence++;
      confidenceSum += entry.confidence;
      confidenceCount++;
    }
    if (entry.conversation_window?.length) {
      withConversationWindow++;
    }
    if (entry.chosen_approach != null && entry.rejected_approach != null) {
      withChosenRejected++;
    }
  }

  return {
    total: all.length,
    with_outcome: withOutcome,
    with_confidence: withConfidence,
    with_conversation_window: withConversationWindow,
    with_chosen_rejected: withChosenRejected,
    outcome_distribution: outcomeDist,
    avg_confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
  };
}
