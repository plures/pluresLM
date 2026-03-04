/**
 * Tiered memory storage with archive + cold/offsite backend and selective attach.
 *
 * Tiers:
 *   hot  – fully indexed in the active PluresDB store (default)
 *   warm – in store but de-prioritised; vectors may be absent or compressed
 *   cold – exported bundle removed from the active store until re-attached
 *
 * Archive policy engine classifies memories by age, access frequency,
 * sensitivity tags, and utility (importance) score. Cold-tier bundles carry
 * per-entry SHA-256 checksums and a bundle-level checksum in the manifest so
 * that corruption is detected before entries are written back to the store.
 */

import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryTier } from "./types.js";

export type { MemoryTier };

// ── Policy ────────────────────────────────────────────────────────────────────

/** Policy thresholds used to classify memories into tiers. */
export interface ArchivePolicy {
  /** Move to warm tier after N days without access (default: 30). */
  warmAfterDays: number;
  /** Move to cold tier after N days without access (default: 90). */
  coldAfterDays: number;
  /**
   * Move to cold tier if access_count is strictly below this threshold and
   * the memory is already warm-eligible by age (default: 1).
   */
  coldBelowAccessCount: number;
  /**
   * Keep memories with importance_score >= this value in hot tier regardless
   * of age or access count (default: 0.8).
   */
  hotMinImportanceScore: number;
  /**
   * Memories with any of these tags are never auto-archived
   * (default: ["critical", "permanent", "sensitive"]).
   */
  sensitivityTags: string[];
}

export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  warmAfterDays: 30,
  coldAfterDays: 90,
  coldBelowAccessCount: 1,
  hotMinImportanceScore: 0.8,
  sensitivityTags: ["critical", "permanent", "sensitive"],
};

// ── Bundle types ──────────────────────────────────────────────────────────────

/** A single entry serialised inside an archive bundle (embedding stripped). */
export interface BundleEntry {
  /** Memory ID. */
  id: string;
  /** SHA-256 hex digest of the canonical JSON of `data`. */
  checksum: string;
  /** Serialised memory fields without the live embedding vector. */
  data: Omit<MemoryEntry, "embedding">;
}

/** Metadata written into the bundle manifest. */
export interface BundleManifest {
  bundleId: string;
  createdAt: number;
  entryCount: number;
  /** SHA-256 hex digest of the full serialised `entries` array. */
  bundleChecksum: string;
  /** Optional stable identifier for the task / project / context module. */
  moduleId?: string;
}

/** A cold-tier archive bundle — fully serialisable as JSON. */
export interface ArchiveBundle {
  manifest: BundleManifest;
  entries: BundleEntry[];
}

/** Result returned after a restore operation. */
export interface RestoreResult {
  /** Number of entries successfully verified and restored. */
  restored: number;
  /**
   * IDs of entries whose checksums did not match — indicates corruption.
   * These entries are NOT inserted into the store.
   */
  corrupted: string[];
}

/** Tier classification result for a set of memories. */
export interface ClassifyResult {
  hot: MemoryEntry[];
  warm: MemoryEntry[];
  cold: MemoryEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively sort object keys to produce a canonical representation.
 * Arrays preserve their element order; each element is canonicalised in turn.
 */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    // Preserve array order but canonicalise each element.
    return value.map((item) => sortKeysDeep(item)) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};

    for (const key of sortedKeys) {
      result[key] = sortKeysDeep(obj[key]);
    }

    return result as unknown as T;
  }

  // Primitives and null are returned as-is.
  return value;
}

/**
 * Compute a stable SHA-256 checksum of a `BundleEntry.data` object.
 * Deterministic JSON (recursively sorted keys) ensures reproducibility.
 */
export function checksumEntry(data: Omit<MemoryEntry, "embedding">): string {
  const canonical = JSON.stringify(sortKeysDeep(data));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Evaluate which storage tier a memory belongs in according to `policy`.
 *
 * Rules (evaluated in priority order):
 * 1. Sensitivity tag or importance_score >= hotMinImportanceScore → hot
 * 2. Age (since last activity) >= coldAfterDays → cold
 * 3. Age >= warmAfterDays AND access_count < coldBelowAccessCount → cold
 * 4. Age >= warmAfterDays → warm
 * 5. Default → hot
 */
export function evaluateTier(
  entry: Pick<MemoryEntry, "created_at" | "last_accessed_at" | "access_count" | "importance_score" | "tags">,
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
  nowMs: number = Date.now(),
): MemoryTier {
  // Guard: sensitivity tags or high importance always stay hot
  const sensitivitySet = new Set(policy.sensitivityTags);
  const hasSensitivityTag = (entry.tags ?? []).some((t) => sensitivitySet.has(t));
  if (hasSensitivityTag) return "hot";
  if ((entry.importance_score ?? 1.0) >= policy.hotMinImportanceScore) return "hot";

  const lastActivity = entry.last_accessed_at ?? entry.created_at;
  const ageDays = (nowMs - lastActivity) / (1000 * 60 * 60 * 24);

  if (ageDays >= policy.coldAfterDays) return "cold";

  if (
    ageDays >= policy.warmAfterDays &&
    entry.access_count !== undefined &&
    entry.access_count < policy.coldBelowAccessCount
  ) {
    return "cold";
  }

  if (ageDays >= policy.warmAfterDays) return "warm";

  return "hot";
}

// ── MemoryArchive ─────────────────────────────────────────────────────────────

/**
 * Manages tiered archival, bundle export/import, and selective attach/detach.
 *
 * A "module" is a named group of memories (identified by `moduleId`) that can
 * be selectively loaded into or removed from an active store. Detached modules
 * remain available as `ArchiveBundle` objects for re-attachment.
 *
 * This class is intentionally stateless w.r.t. PluresDBBackend — callers are
 * responsible for actually deleting / inserting entries in the DB; this class
 * handles classification, checksumming, bundle construction, and the module
 * registry.
 */
export class MemoryArchive {
  /** Registry of registered (detached) modules keyed by moduleId. */
  private readonly modules = new Map<string, ArchiveBundle>();

  // ── Policy evaluation ───────────────────────────────────────────────────────

  /**
   * Classify a list of memories according to `policy`.
   * Returns three groups; does NOT modify the store.
   */
  classifyMemories(
    entries: MemoryEntry[],
    policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
    nowMs: number = Date.now(),
  ): ClassifyResult {
    const hot: MemoryEntry[] = [];
    const warm: MemoryEntry[] = [];
    const cold: MemoryEntry[] = [];

    for (const e of entries) {
      const tier = evaluateTier(e, policy, nowMs);
      if (tier === "warm") warm.push(e);
      else if (tier === "cold") cold.push(e);
      else hot.push(e);
    }
    return { hot, warm, cold };
  }

  // ── Bundle export ───────────────────────────────────────────────────────────

  /**
   * Export a list of memories into a self-describing `ArchiveBundle`.
   *
   * Each entry receives an individual SHA-256 checksum and the whole
   * `entries` array is checksummed in the manifest so restoration can
   * detect tampering at both levels.
   *
   * Embeddings are stripped to keep bundles compact. They can be
   * recomputed on restore by the caller.
   *
   * @param entries  Memories to bundle.
   * @param moduleId Optional stable label for selective re-attach.
   */
  exportBundle(entries: Omit<MemoryEntry, "embedding">[], moduleId?: string): ArchiveBundle {
    const bundleId = `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = Date.now();

    const bundleEntries: BundleEntry[] = entries.map((e) => {
      const checksum = checksumEntry(e);
      return { id: e.id, checksum, data: e };
    });

    const bundleChecksum = createHash("sha256")
      .update(JSON.stringify(bundleEntries), "utf8")
      .digest("hex");

    const manifest: BundleManifest = {
      bundleId,
      createdAt,
      entryCount: bundleEntries.length,
      bundleChecksum,
      moduleId,
    };

    return { manifest, entries: bundleEntries };
  }

  // ── Bundle restore ──────────────────────────────────────────────────────────

  /**
   * Verify and restore entries from an `ArchiveBundle`.
   *
   * Integrity is checked at two levels:
   * 1. **Bundle checksum** — manifest.bundleChecksum vs re-computed hash of
   *    the full `entries` array. If this fails, the entire bundle is rejected.
   * 2. **Per-entry checksum** — entry.checksum vs re-computed hash of
   *    entry.data. Failed entries are recorded in `result.corrupted` and are
   *    NOT returned (no silent corruption).
   *
   * @returns Verified `MemoryEntry` objects (with empty `embedding: []`) and
   *          a `RestoreResult` summary.
   */
  restoreBundle(bundle: ArchiveBundle): { entries: MemoryEntry[]; result: RestoreResult } {
    const result: RestoreResult = { restored: 0, corrupted: [] };

    // 1. Bundle-level integrity check
    const actualBundleChecksum = createHash("sha256")
      .update(JSON.stringify(bundle.entries), "utf8")
      .digest("hex");

    if (actualBundleChecksum !== bundle.manifest.bundleChecksum) {
      result.corrupted = bundle.entries.map((e) => e.id);
      return { entries: [], result };
    }

    // 2. Per-entry integrity check
    const restoredEntries: MemoryEntry[] = [];
    for (const bundleEntry of bundle.entries) {
      const actualChecksum = checksumEntry(bundleEntry.data);
      if (actualChecksum !== bundleEntry.checksum) {
        result.corrupted.push(bundleEntry.id);
        continue;
      }
      restoredEntries.push({ ...bundleEntry.data, embedding: [] });
      result.restored++;
    }

    return { entries: restoredEntries, result };
  }

  // ── Selective attach / detach ───────────────────────────────────────────────

  /**
   * Package a group of memories into a named cold-tier module and register
   * it for later re-attachment.
   *
   * The caller is responsible for deleting the memories from the active store
   * after calling this method.
   *
   * @param entries  Memories to detach.
   * @param moduleId Stable identifier for the module (task / project / context).
   * @returns The `ArchiveBundle` created (for persistence / export to disk).
   */
  detach(entries: Omit<MemoryEntry, "embedding">[], moduleId: string): ArchiveBundle {
    const bundle = this.exportBundle(entries, moduleId);
    this.modules.set(moduleId, bundle);
    return bundle;
  }

  /**
   * Load a previously-detached module back into active memory.
   *
   * Returns verified entries ready to be inserted into the hot store via
   * `PluresDBBackend.storeRaw()`. Entries that fail checksum verification are
   * excluded and recorded in `result.corrupted`.
   *
   * @param moduleId The module to re-attach.
   * @returns Verified entries + restore summary; or `null` if the module is
   *          not registered.
   */
  attach(moduleId: string): { entries: MemoryEntry[]; result: RestoreResult } | null {
    const bundle = this.modules.get(moduleId);
    if (!bundle) return null;
    return this.restoreBundle(bundle);
  }

  /**
   * Register an externally-created bundle under a `moduleId`.
   * This is the entry point for bundles loaded from disk or received over the
   * network before calling `attach()`.
   */
  registerBundle(bundle: ArchiveBundle, moduleId: string): void {
    this.modules.set(moduleId, bundle);
  }

  /**
   * Remove a module from the registry (freeing its bundle from memory).
   * @returns `true` if the module existed, `false` otherwise.
   */
  dropModule(moduleId: string): boolean {
    return this.modules.delete(moduleId);
  }

  /** Return all registered module IDs. */
  listModules(): string[] {
    return Array.from(this.modules.keys());
  }

  /** Return the bundle for a registered module without removing it. */
  getBundle(moduleId: string): ArchiveBundle | undefined {
    return this.modules.get(moduleId);
  }
}
