/**
 * Memory Module Packs — shareable, versioned, signed curated memory sets.
 *
 * A MemoryPack wraps an ArchiveBundle with:
 *   - Provenance  – author, license, version, description, sourceUrl
 *   - Embedding metadata – model name / version / dimensions for compatibility
 *   - HMAC-SHA256 signature – trust / tamper detection
 *
 * Lifecycle:
 *   create  → sign  → distribute (JSON / file / marketplace)
 *   receive → verify → compatibility check → import → installed registry
 *   uninstall → memories detached and registry entry removed (safe rollback)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ArchiveBundle, RestoreResult } from "./memory-archive.js";

// ── Provenance ────────────────────────────────────────────────────────────────

/** Human-readable provenance metadata attached to a memory pack. */
export interface PackProvenance {
  /** Display name of the pack (e.g. "TypeScript Patterns Encyclopedia"). */
  name: string;
  /** Author or organisation (e.g. "Plures Team"). */
  author: string;
  /** Short description of the pack content. */
  description: string;
  /**
   * SPDX licence identifier (e.g. "MIT", "CC-BY-4.0", "AGPL-3.0",
   * "LicenseRef-Commercial").
   */
  license: string;
  /** Semantic version of this pack release (e.g. "1.0.0"). */
  version: string;
  /** Optional URL or URN where this pack was sourced from. */
  sourceUrl?: string;
  /** ISO 8601 creation timestamp (set automatically when the pack is created/exported). */
  createdAt: string;
}

// ── Embedding metadata ────────────────────────────────────────────────────────

/**
 * Embedding-model metadata carried in a pack so consumers can check
 * compatibility before importing.
 */
export interface PackEmbeddingMeta {
  /** Model name used when generating embeddings (e.g. "all-minilm-l6-v2"). */
  modelName: string;
  /** Optional model version / tag. */
  modelVersion?: string;
  /** Embedding vector dimensions. */
  dimensions: number;
}

// ── Pack ──────────────────────────────────────────────────────────────────────

/** A portable, signable memory module pack. */
export interface MemoryPack {
  /** Format version — always `"1"` for this schema. */
  packVersion: "1";
  /** Bundled memories with per-entry and bundle-level checksums. */
  bundle: ArchiveBundle;
  /** Human-readable provenance. */
  provenance: PackProvenance;
  /** Embedding model metadata for import-time compatibility checks. */
  embeddingMeta: PackEmbeddingMeta;
  /**
   * HMAC-SHA256 hex signature over the canonical JSON of
   * `{packVersion, bundle, provenance, embeddingMeta}`.
   * Absent when the pack has not been signed.
   */
  signature?: string;
}

// ── Result types ──────────────────────────────────────────────────────────────

/** Result returned after importing a memory pack. */
export interface PackImportResult extends RestoreResult {
  /** Provenance surfaced for display in UI / API responses. */
  provenance: PackProvenance;
  /**
   * `true` when the pack's embedding model matches the current model.
   * `false` when a mismatch is detected — embeddings may need recomputing.
   */
  embeddingCompatible: boolean;
  /** Non-fatal warning messages (e.g. model mismatch, missing signature). */
  warnings: string[];
}

/** Summary of an installed (imported) pack kept in the registry. */
export interface InstalledPackInfo {
  moduleId: string;
  provenance: PackProvenance;
  embeddingMeta: PackEmbeddingMeta;
  /** Unix epoch ms when the pack was installed in this session. */
  installedAt: number;
  /** Number of entries successfully restored on import. */
  entryCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively sort object keys for deterministic serialisation.
 * Used to produce a canonical signing payload that is stable across runtimes.
 */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      result[key] = sortKeysDeep(obj[key]);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Produce the canonical JSON string that is signed / verified.
 * The `signature` field is intentionally excluded so the payload is
 * identical whether computed before or after signing.
 */
function signingPayload(pack: MemoryPack): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _sig, ...rest } = pack;
  return JSON.stringify(sortKeysDeep(rest));
}

// ── Pack operations ───────────────────────────────────────────────────────────

/**
 * Add an HMAC-SHA256 signature to a pack using the supplied `signingKey`.
 *
 * The signature covers `{packVersion, bundle, provenance, embeddingMeta}`
 * serialised as deterministic (sorted-key) JSON so the payload is stable
 * across language runtimes and JSON serialisers.
 *
 * @returns A new `MemoryPack` object with the `signature` field populated.
 */
export function signPack(pack: MemoryPack, signingKey: string): MemoryPack {
  const payload = signingPayload(pack);
  const sig = createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
  return { ...pack, signature: sig };
}

/**
 * Verify the HMAC-SHA256 signature on a pack.
 *
 * Uses `timingSafeEqual` to prevent timing-oracle attacks.
 *
 * @returns `true` when the signature is valid; `false` when absent,
 *          malformed, or computed with a different key.
 */
export function verifyPackSignature(pack: MemoryPack, signingKey: string): boolean {
  if (!pack.signature) return false;
  const payload = signingPayload(pack);
  const expected = createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
  try {
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(pack.signature, "hex");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * Check whether a pack's embedding model is compatible with the active model.
 *
 * @param pack              The pack to check.
 * @param currentModelName  The model currently used by this deployment.
 * @returns Compatibility status and any non-fatal warning messages.
 */
export function checkPackCompatibility(
  pack: MemoryPack,
  currentModelName?: string,
): { compatible: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let compatible = true;

  if (currentModelName && pack.embeddingMeta.modelName !== currentModelName) {
    warnings.push(
      `Pack was created with embedding model "${pack.embeddingMeta.modelName}" ` +
        `but the current model is "${currentModelName}". ` +
        `Stored embeddings may need to be recomputed after import.`,
    );
    compatible = false;
  }

  return { compatible, warnings };
}

// ── PackRegistry ──────────────────────────────────────────────────────────────

/**
 * In-memory registry of installed memory packs.
 *
 * Tracks provenance and the original bundle so that entries can be
 * identified and removed during uninstall (safe rollback).
 */
export class PackRegistry {
  private readonly installed = new Map<
    string,
    { info: InstalledPackInfo; bundle: ArchiveBundle }
  >();

  /**
   * Record a successfully-imported pack in the registry.
   *
   * @param moduleId       Stable identifier for the pack module.
   * @param pack           The imported pack (provenance + embeddingMeta copied).
   * @param restoredCount  Number of entries actually restored from the bundle.
   */
  register(moduleId: string, pack: MemoryPack, restoredCount: number): void {
    this.installed.set(moduleId, {
      info: {
        moduleId,
        provenance: pack.provenance,
        embeddingMeta: pack.embeddingMeta,
        installedAt: Date.now(),
        entryCount: restoredCount,
      },
      bundle: pack.bundle,
    });
  }

  /**
   * Remove an installed pack from the registry and return its bundle
   * (needed to enumerate entry IDs for uninstall / rollback).
   *
   * @returns The pack's `ArchiveBundle`, or `undefined` if not found.
   */
  unregister(moduleId: string): ArchiveBundle | undefined {
    const entry = this.installed.get(moduleId);
    if (!entry) return undefined;
    this.installed.delete(moduleId);
    return entry.bundle;
  }

  /** Return `InstalledPackInfo` for all installed packs. */
  list(): InstalledPackInfo[] {
    return Array.from(this.installed.values()).map((e) => e.info);
  }

  /** Return the `InstalledPackInfo` for a specific pack, or `undefined`. */
  get(moduleId: string): InstalledPackInfo | undefined {
    return this.installed.get(moduleId)?.info;
  }

  /** Return the raw bundle for a specific pack (needed for rollback). */
  getBundle(moduleId: string): ArchiveBundle | undefined {
    return this.installed.get(moduleId)?.bundle;
  }
}
