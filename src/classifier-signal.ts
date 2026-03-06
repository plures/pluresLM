/**
 * Classifier signal pipeline for pluresLM.
 *
 * Extracts deterministic, versioned feature vectors from MemoryEntry records
 * and applies quality gates so that downstream optimizers (pares-agens) receive
 * a stable, clean dataset.
 *
 * Schema version follows semver. A bump to the major version means the feature
 * vector layout has changed in a backward-incompatible way. Consumers should
 * always check `schema_version` before ingesting.
 */

import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryOutcome, MemoryPriority, ValidatedBy } from "./types.js";

// ── Schema version ────────────────────────────────────────────────────────────

/** Increment MAJOR on any breaking change to ClassifierFeatures layout. */
export const CLASSIFIER_SIGNAL_SCHEMA_VERSION = "1.0.0";

// ── Categorical encodings ─────────────────────────────────────────────────────

/**
 * Deterministic integer encoding for memory categories.
 * Unknown categories map to 0 so that new categories do not break old models.
 */
export const CATEGORY_ENCODING: Record<string, number> = {
  decision: 1,
  outcome: 2,
  constraint: 3,
  incident: 4,
  preference: 5,
  architecture_decision: 6,
  "architecture-decision": 6,
  entity: 7,
  explicit: 8,
  conversation: 9,
  document: 10,
  "document-chunk": 11,
  note: 12,
  reference: 13,
  insight: 14,
  task: 15,
  other: 16,
};

export const SOURCE_ENCODING: Record<string, number> = {
  conversation: 1,
  cron_output: 2,
  pr_merge: 3,
  web_search: 4,
  user_explicit: 5,
  agent: 6,
};

export const PRIORITY_ENCODING: Record<MemoryPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export const VALIDATED_BY_ENCODING: Record<ValidatedBy, number> = {
  human: 4,
  agent: 3,
  ci_result: 2,
  none: 1,
};

export const OUTCOME_ENCODING: Record<MemoryOutcome, number> = {
  success: 4,
  partial: 3,
  unknown: 2,
  failure: 1,
};

// ── Core types ────────────────────────────────────────────────────────────────

/**
 * Numeric feature vector extracted from a MemoryEntry.
 * All fields are deterministic and normalized to [0, 1] unless otherwise noted.
 */
export interface ClassifierFeatures {
  /** Normalised content length: min(content.length / 2000, 1.0). */
  content_length_norm: number;
  /** 1 if the entry has a non-null outcome. */
  has_outcome: 0 | 1;
  /** 1 if the entry has a confidence score. */
  has_confidence: 0 | 1;
  /** Confidence value; defaults to 0.5 when absent. */
  confidence: number;
  /** 1 if both chosen_approach and rejected_approach are set. */
  has_chosen_rejected: 0 | 1;
  /** 1 if conversation_window is non-empty. */
  has_conversation_window: 0 | 1;
  /** Number of turns in conversation_window, normalised by 20. */
  conversation_turn_count_norm: number;
  /** 1 if tools_used is non-empty. */
  has_tools: 0 | 1;
  /** Number of tools used, normalised by 10. */
  tool_count_norm: number;
  /** access_count normalised by 100. */
  access_count_norm: number;
  /** reinforcement_count normalised by 50. */
  reinforcement_count_norm: number;
  /** contradiction_count normalised by 50. */
  contradiction_count_norm: number;
  /** 1 if derived_from is non-empty. */
  has_derived_from: 0 | 1;
  /** Number of derivation sources, normalised by 10. */
  derived_from_count_norm: number;
  /** Deterministic integer encoding for category (see CATEGORY_ENCODING). */
  category_encoded: number;
  /** Deterministic integer encoding for source (see SOURCE_ENCODING). */
  source_encoded: number;
  /** Deterministic integer encoding for priority (see PRIORITY_ENCODING). */
  priority_encoded: number;
  /** Age in days since created_at, normalised by 365. */
  age_days_norm: number;
  /** Deterministic integer encoding for validated_by (see VALIDATED_BY_ENCODING). */
  validated_by_encoded: number;
  /** Encoded outcome value; 0 when absent. */
  outcome_encoded: number;
}

/** Ground-truth label carried in the signal payload. */
export interface ClassifierLabel {
  outcome: MemoryOutcome | null;
  validated_by: ValidatedBy | null;
  /** Confidence in the label itself (same as memory confidence). */
  confidence: number;
}

/** Per-signal quality assessment produced by the quality gate. */
export interface SignalQuality {
  /** False when confidence < min_confidence threshold. */
  passes_noise_threshold: boolean;
  /** True when this signal is a duplicate of another in the batch. */
  is_duplicate: boolean;
  /** True when the category passes the include/exclude filter. */
  category_included: boolean;
  /** True only when all quality checks pass. */
  overall: boolean;
}

/**
 * A single classifier-ready signal payload.
 *
 * The `schema_version` field lets downstream consumers detect breaking changes
 * to the feature layout without inspecting field names.
 */
export interface ClassifierSignal {
  schema_version: string;
  id: string;
  category: string;
  source: string;
  features: ClassifierFeatures;
  label: ClassifierLabel | null;
  quality: SignalQuality;
  created_at: number;
}

// ── Quality gate options ──────────────────────────────────────────────────────

/** Options controlling which signals pass the quality gate. */
export interface SignalQualityOptions {
  /**
   * Minimum confidence score required to pass the noise threshold.
   * Memories with no confidence score use DEFAULT_TRAINING_CONFIDENCE (0.5).
   * Default: 0.0 (all memories pass).
   */
  min_confidence?: number;
  /**
   * Minimum raw content length in characters.
   * Default: 10.
   */
  min_content_length?: number;
  /**
   * Whitelist of categories to include.
   * An empty array (default) includes all categories.
   */
  categories?: string[];
  /**
   * Categories to exclude.
   * Applied after the `categories` whitelist.
   */
  exclude_categories?: string[];
  /**
   * Remove duplicate signals (same SHA-256 of content) from the output batch.
   * Default: true.
   */
  dedupe?: boolean;
}

/** Options for `extractClassifierSignals`. */
export interface ClassifierExportOptions {
  quality?: SignalQualityOptions;
  /** When false (default) only labeled (has outcome) signals are exported. */
  include_unlabeled?: boolean;
  /** Reference timestamp used for age_days calculation. Defaults to Date.now(). */
  reference_ts?: number;
}

// ── Feature extraction ────────────────────────────────────────────────────────

const DEFAULT_CONFIDENCE = 0.5;
const CONTENT_LEN_NORM = 2000;
const TURN_COUNT_NORM = 20;
const TOOL_COUNT_NORM = 10;
const ACCESS_COUNT_NORM = 100;
const REINFORCE_NORM = 50;
const CONTRADICT_NORM = 50;
const DERIVED_FROM_NORM = 10;
const AGE_DAYS_NORM = 365;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Extract a deterministic ClassifierFeatures vector from a single MemoryEntry.
 *
 * @param entry          The source memory entry.
 * @param reference_ts   Timestamp used for age computation (default: Date.now()).
 */
export function extractFeatures(
  entry: MemoryEntry,
  reference_ts: number = Date.now(),
): ClassifierFeatures {
  const ageDays = Math.max(0, (reference_ts - entry.created_at) / 86_400_000);
  const confidence = entry.confidence ?? DEFAULT_CONFIDENCE;

  return {
    content_length_norm: clamp01(entry.content.length / CONTENT_LEN_NORM),
    has_outcome: entry.outcome != null ? 1 : 0,
    has_confidence: entry.confidence != null ? 1 : 0,
    confidence,
    has_chosen_rejected: entry.chosen_approach != null && entry.rejected_approach != null ? 1 : 0,
    has_conversation_window: entry.conversation_window && entry.conversation_window.length > 0 ? 1 : 0,
    conversation_turn_count_norm: clamp01((entry.conversation_window?.length ?? 0) / TURN_COUNT_NORM),
    has_tools: entry.tools_used && entry.tools_used.length > 0 ? 1 : 0,
    tool_count_norm: clamp01((entry.tools_used?.length ?? 0) / TOOL_COUNT_NORM),
    access_count_norm: clamp01((entry.access_count ?? 0) / ACCESS_COUNT_NORM),
    reinforcement_count_norm: clamp01((entry.reinforcement_count ?? 0) / REINFORCE_NORM),
    contradiction_count_norm: clamp01((entry.contradiction_count ?? 0) / CONTRADICT_NORM),
    has_derived_from: entry.derived_from && entry.derived_from.length > 0 ? 1 : 0,
    derived_from_count_norm: clamp01((entry.derived_from?.length ?? 0) / DERIVED_FROM_NORM),
    category_encoded: CATEGORY_ENCODING[entry.category] ?? 0,
    source_encoded: SOURCE_ENCODING[entry.source] ?? 0,
    priority_encoded: entry.priority != null ? (PRIORITY_ENCODING[entry.priority] ?? 0) : 0,
    age_days_norm: clamp01(ageDays / AGE_DAYS_NORM),
    validated_by_encoded: entry.validated_by != null ? (VALIDATED_BY_ENCODING[entry.validated_by] ?? 0) : 0,
    outcome_encoded: entry.outcome != null ? (OUTCOME_ENCODING[entry.outcome] ?? 0) : 0,
  };
}

/**
 * Build a ClassifierLabel from a MemoryEntry, or return null when insufficient
 * label data is present (no outcome and not validated by a human).
 */
export function extractLabel(entry: MemoryEntry): ClassifierLabel | null {
  const hasOutcome = entry.outcome != null;
  const isHumanValidated = entry.validated_by === "human";
  if (!hasOutcome && !isHumanValidated) return null;
  return {
    outcome: entry.outcome ?? null,
    validated_by: entry.validated_by ?? null,
    confidence: entry.confidence ?? DEFAULT_CONFIDENCE,
  };
}

// ── Content hash (for dedup) ──────────────────────────────────────────────────

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Quality gate ──────────────────────────────────────────────────────────────

function assessQuality(
  entry: MemoryEntry,
  seenHashes: Set<string>,
  opts: SignalQualityOptions,
): SignalQuality {
  const minConfidence = opts.min_confidence ?? 0.0;
  const minContentLength = opts.min_content_length ?? 10;
  const categories = opts.categories ?? [];
  const excludeCategories = opts.exclude_categories ?? [];
  const dedupe = opts.dedupe !== false; // default true

  const effectiveConfidence = entry.confidence ?? DEFAULT_CONFIDENCE;
  const passesNoise =
    effectiveConfidence >= minConfidence && entry.content.length >= minContentLength;

  const hash = contentHash(entry.content);
  let isDuplicate = false;
  if (dedupe) {
    if (seenHashes.has(hash)) {
      isDuplicate = true;
    } else {
      seenHashes.add(hash);
    }
  }

  let categoryIncluded = true;
  if (categories.length > 0) {
    categoryIncluded = categories.includes(entry.category);
  }
  if (excludeCategories.includes(entry.category)) {
    categoryIncluded = false;
  }

  const overall = passesNoise && !isDuplicate && categoryIncluded;

  return {
    passes_noise_threshold: passesNoise,
    is_duplicate: isDuplicate,
    category_included: categoryIncluded,
    overall,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract classifier-ready signal payloads from a collection of MemoryEntry records.
 *
 * Applies feature extraction, label extraction, and quality-gate filtering.
 * The returned array contains **all** signals (both passing and failing quality)
 * so that callers can inspect quality statistics before dropping failed signals.
 * Filter on `signal.quality.overall === true` to obtain the clean export set.
 *
 * @param entries    Source memory entries.
 * @param options    Feature extraction and quality-gate options.
 * @returns          Array of ClassifierSignal payloads ordered by `created_at` ascending.
 */
export function extractClassifierSignals(
  entries: MemoryEntry[],
  options: ClassifierExportOptions = {},
): ClassifierSignal[] {
  const qualityOpts = options.quality ?? {};
  const includeUnlabeled = options.include_unlabeled ?? false;
  const referenceTs = options.reference_ts ?? Date.now();

  const seenHashes = new Set<string>();
  const signals: ClassifierSignal[] = [];

  // Sort by created_at for deterministic ordering across calls
  const sorted = [...entries].sort((a, b) => a.created_at - b.created_at);

  for (const entry of sorted) {
    const label = extractLabel(entry);

    // Skip unlabeled entries when not explicitly requested
    if (!includeUnlabeled && label === null) continue;

    const features = extractFeatures(entry, referenceTs);
    const quality = assessQuality(entry, seenHashes, qualityOpts);

    signals.push({
      schema_version: CLASSIFIER_SIGNAL_SCHEMA_VERSION,
      id: entry.id,
      category: entry.category,
      source: entry.source,
      features,
      label,
      quality,
      created_at: entry.created_at,
    });
  }

  return signals;
}

/**
 * Serialize a classifier signal batch to JSONL (one signal per line).
 * Only signals that pass the quality gate are included.
 */
export function signalsToJsonl(signals: ClassifierSignal[]): string {
  return signals
    .filter((s) => s.quality.overall)
    .map((s) => JSON.stringify(s))
    .join("\n");
}
