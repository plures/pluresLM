/**
 * Optimization Trap Memory Schema for pluresLM.
 *
 * An optimization trap is a recorded instance where an AI agent's optimization
 * process led to (or risked leading to) an unsafe or misaligned recommendation.
 * Traps are stored as MemoryEntry records in the PluresDB backend, using a
 * `category: "optimization-trap"` marker and `trap:` prefixed tags for
 * structured metadata fields.
 *
 * Schema version follows semver. A bump to the major version indicates a
 * backward-incompatible change to the tag-encoding layout. Consumers should
 * always check `schemaVersion` before ingesting.
 */

import { createHash } from "node:crypto";
import type { MemoryEntry } from "./types.js";

// ── Schema version ────────────────────────────────────────────────────────────

/** Increment MAJOR on any breaking change to the tag-encoding layout. */
export const OPTIMIZATION_TRAP_SCHEMA_VERSION = "1.0.0";

/** Category string used to identify optimization-trap MemoryEntry records. */
export const OPTIMIZATION_TRAP_CATEGORY = "optimization-trap";

// ── Tag prefixes (stable across patch versions) ────────────────────────────────

const T_SCHEMA  = "trap:schema:";
const T_OUTCOME = "trap:outcome:";
const T_OBJ     = "trap:objective:";
const T_UNSAFE  = "trap:unsafe_pattern:";
const T_MISSING = "trap:missing_signals:";
const T_CTX     = "trap:context_sig:";
const T_GUARD   = "trap:guardrail:";

// ── Core schema ───────────────────────────────────────────────────────────────

/**
 * An optimization trap event.
 *
 * Trap records describe a historical moment where an optimization process
 * produced (or was at risk of producing) an unsafe recommendation, what
 * signals were absent, and what corrective guardrail was applied or advised.
 */
export interface OptimizationTrap {
  /** UUID generated at record time. */
  id: string;
  /** Schema version at record time — always {@link OPTIMIZATION_TRAP_SCHEMA_VERSION} for new records. */
  schemaVersion: string;
  /** The optimization objective in effect when the trap was triggered. */
  objective: string;
  /** Contextual identifiers / tags scoping the optimization run. */
  contextSignature: string[];
  /** Signals that were missing from the optimizer's context. */
  missingSignals: string[];
  /** The unsafe or misaligned recommendation pattern that was detected. */
  unsafeRecommendationPattern: string;
  /**
   * Whether the trap outcome was realized (the unsafe action was taken)
   * or avoided (the guardrail prevented it).
   */
  outcome: "realized" | "avoided";
  /** Optional human-readable description of how the outcome played out. */
  outcomeDescription?: string;
  /** The corrective guardrail that was applied or recommended. */
  correctiveGuardrail: string;
  /** Epoch-ms timestamp when this trap was recorded. */
  recordedAt: number;
}

// ── Export record (training / reinforcement pipeline) ─────────────────────────

/**
 * Flat export record for a single trap event.
 * Designed for downstream training and reinforcement-learning pipelines.
 */
export interface OptimizationTrapExportRecord {
  trap_id: string;
  schema_version: string;
  objective: string;
  context_signature: string[];
  missing_signals: string[];
  unsafe_recommendation_pattern: string;
  outcome: "realized" | "avoided";
  outcome_description?: string;
  corrective_guardrail: string;
  recorded_at: number;
}

// ── Codec ─────────────────────────────────────────────────────────────────────

/**
 * Encode an optimization trap into the tag set and content string used for
 * MemoryEntry persistence.
 *
 * @returns `{ content, tags, outcomeDescription }` ready for `storeContent()`.
 */
export function encodeOptimizationTrap(
  trap: Omit<OptimizationTrap, "id" | "schemaVersion" | "recordedAt">,
): { content: string; tags: string[]; outcomeDescription: string | undefined } {
  const tags: string[] = [
    OPTIMIZATION_TRAP_CATEGORY,
    `${T_SCHEMA}${OPTIMIZATION_TRAP_SCHEMA_VERSION}`,
    `${T_OUTCOME}${trap.outcome}`,
    `${T_OBJ}${trap.objective}`,
    `${T_UNSAFE}${trap.unsafeRecommendationPattern}`,
    `${T_MISSING}${JSON.stringify(trap.missingSignals)}`,
    `${T_CTX}${JSON.stringify(trap.contextSignature)}`,
    `${T_GUARD}${trap.correctiveGuardrail}`,
  ];

  // Combine objective and unsafe pattern for semantic search embedding
  const content = `${trap.objective}: ${trap.unsafeRecommendationPattern}`;
  return { content, tags, outcomeDescription: trap.outcomeDescription };
}

/**
 * Decode a MemoryEntry back to an {@link OptimizationTrap}.
 *
 * @returns The decoded trap, or `null` if the entry is not a valid trap record.
 */
export function decodeOptimizationTrap(
  entry: MemoryEntry | Omit<MemoryEntry, "embedding">,
): OptimizationTrap | null {
  if (entry.category !== OPTIMIZATION_TRAP_CATEGORY) return null;

  const tags = entry.tags ?? [];
  const find = (prefix: string): string | undefined => {
    const t = tags.find((tag) => tag.startsWith(prefix));
    return t !== undefined ? t.slice(prefix.length) : undefined;
  };

  const outcomeRaw = find(T_OUTCOME);
  if (!outcomeRaw || (outcomeRaw !== "realized" && outcomeRaw !== "avoided")) return null;

  const objective = find(T_OBJ);
  const unsafePattern = find(T_UNSAFE);
  const guardrail = find(T_GUARD);

  if (!objective || !unsafePattern || !guardrail) return null;

  let missingSignals: string[] = [];
  const missingRaw = find(T_MISSING);
  if (missingRaw) {
    try {
      missingSignals = JSON.parse(missingRaw) as string[];
    } catch {
      // ignore malformed JSON
    }
  }

  let contextSignature: string[] = [];
  const ctxRaw = find(T_CTX);
  if (ctxRaw) {
    try {
      contextSignature = JSON.parse(ctxRaw) as string[];
    } catch {
      // ignore malformed JSON
    }
  }

  const schemaVersion = find(T_SCHEMA) ?? OPTIMIZATION_TRAP_SCHEMA_VERSION;

  return {
    id: entry.id,
    schemaVersion,
    objective,
    contextSignature,
    missingSignals,
    unsafeRecommendationPattern: unsafePattern,
    outcome: outcomeRaw,
    outcomeDescription: (entry.outcome_evidence ?? undefined) as string | undefined,
    correctiveGuardrail: guardrail,
    recordedAt: entry.created_at,
  };
}

// ── Export utilities ──────────────────────────────────────────────────────────

/**
 * Convert an {@link OptimizationTrap} to a flat {@link OptimizationTrapExportRecord}.
 */
export function trapToExportRecord(trap: OptimizationTrap): OptimizationTrapExportRecord {
  const record: OptimizationTrapExportRecord = {
    trap_id: trap.id,
    schema_version: trap.schemaVersion,
    objective: trap.objective,
    context_signature: trap.contextSignature,
    missing_signals: trap.missingSignals,
    unsafe_recommendation_pattern: trap.unsafeRecommendationPattern,
    outcome: trap.outcome,
    corrective_guardrail: trap.correctiveGuardrail,
    recorded_at: trap.recordedAt,
  };
  if (trap.outcomeDescription !== undefined) {
    record.outcome_description = trap.outcomeDescription;
  }
  return record;
}

/**
 * Serialize a list of traps to JSONL format suitable for training / RL pipelines.
 *
 * Each line is a JSON-encoded {@link OptimizationTrapExportRecord}.
 */
export function trapsToJsonl(traps: OptimizationTrap[]): string {
  return traps.map((t) => JSON.stringify(trapToExportRecord(t))).join("\n");
}

/**
 * Compute a stable context fingerprint for similarity grouping.
 *
 * The fingerprint is a SHA-256 hex digest of the sorted, lowercased context
 * signature tokens. Two trap records with the same tokens (regardless of
 * insertion order) will produce the same fingerprint.
 */
export function contextFingerprint(contextSignature: string[]): string {
  const sorted = [...contextSignature].sort().map((s) => s.toLowerCase());
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}
