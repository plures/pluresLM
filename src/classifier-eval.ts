/**
 * Classifier evaluation utilities for pluresLM.
 *
 * Computes precision, recall, F1 on a labeled slice of ClassifierSignal records
 * and produces a drift score by comparing the outcome-label distribution of two
 * batches (e.g. current week vs previous week).
 *
 * All computations are deterministic and produce a versioned EvalReport so that
 * reports generated at different points in time can be compared reliably.
 */

import { CLASSIFIER_SIGNAL_SCHEMA_VERSION } from "./classifier-signal.js";
import type { ClassifierSignal } from "./classifier-signal.js";
import type { MemoryOutcome } from "./types.js";

// ── Eval report type ──────────────────────────────────────────────────────────

/** Quality statistics over a batch of signals. */
export interface QualityStats {
  total: number;
  passed: number;
  failed_noise: number;
  failed_duplicate: number;
  failed_category: number;
}

/**
 * Precision / recall / F1 for a specific outcome class, or macro-averaged.
 */
export interface ClassMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/** Per-class precision/recall/F1 for every outcome class observed. */
export type ClassBreakdown = Record<MemoryOutcome, ClassMetrics>;

/**
 * Drift score between two batches.
 *
 * Computed as the Jensen-Shannon divergence of the outcome-label distributions.
 * A score of 0 means no drift; 1 means maximum drift.
 */
export interface DriftResult {
  /** JS-divergence in [0, 1]. */
  score: number;
  reference_distribution: Record<string, number>;
  current_distribution: Record<string, number>;
}

/**
 * Full evaluation report for a batch of ClassifierSignal records.
 */
export interface ClassifierEvalReport {
  /** Matches CLASSIFIER_SIGNAL_SCHEMA_VERSION so reports are tied to a schema. */
  schema_version: string;
  total_signals: number;
  labeled_signals: number;
  label_distribution: Record<string, number>;
  /** Macro-averaged metrics across all outcome classes. */
  macro: ClassMetrics;
  /** Per-class breakdown. */
  per_class: Partial<ClassBreakdown>;
  quality_stats: QualityStats;
  /**
   * Jensen-Shannon drift score vs a reference batch.
   * null when no reference batch was provided.
   */
  drift: DriftResult | null;
  generated_at: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function outcomeFromSignal(signal: ClassifierSignal): MemoryOutcome | null {
  return signal.label?.outcome ?? null;
}

function buildDistribution(signals: ClassifierSignal[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const s of signals) {
    const label = outcomeFromSignal(s);
    if (label != null) {
      dist[label] = (dist[label] ?? 0) + 1;
    }
  }
  return dist;
}

/**
 * Normalise a frequency map to a probability distribution.
 * Returns an empty object for an empty map.
 */
function normalise(dist: Record<string, number>): Record<string, number> {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total === 0) return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(dist)) result[k] = v / total;
  return result;
}

/**
 * Jensen-Shannon divergence between two probability distributions.
 * Returns a value in [0, 1].
 */
function jsDivergence(p: Record<string, number>, q: Record<string, number>): number {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  let div = 0;
  for (const k of keys) {
    const pi = p[k] ?? 0;
    const qi = q[k] ?? 0;
    const m = (pi + qi) / 2;
    if (m === 0) continue;
    if (pi > 0) div += pi * Math.log2(pi / m);
    if (qi > 0) div += qi * Math.log2(qi / m);
  }
  // JSD is in [0, 1] (using log base-2)
  return Math.min(1, div / 2);
}

/**
 * Compute precision, recall, F1 for a single outcome class.
 *
 * @param signals   All labeled signals.
 * @param cls       The outcome class to evaluate.
 * @param predicted A function mapping a signal to its predicted outcome.
 */
function computeClassMetrics(
  signals: ClassifierSignal[],
  cls: MemoryOutcome,
  predicted: (s: ClassifierSignal) => MemoryOutcome | null,
): ClassMetrics {
  let tp = 0, fp = 0, fn = 0;

  for (const s of signals) {
    const truth = outcomeFromSignal(s);
    const pred = predicted(s);
    if (truth === cls && pred === cls) tp++;
    else if (truth !== cls && pred === cls) fp++;
    else if (truth === cls && pred !== cls) fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  return { precision, recall, f1 };
}

/**
 * Default predicted-outcome function used when no predictor is provided.
 *
 * We intentionally abstain on all signals by returning `null`, so that
 * precision/recall/F1 remain unset (null) unless the caller supplies a real
 * classifier predictor via the `predicted` parameter to `generateEvalReport`.
 *
 * This avoids using the ground-truth label as a proxy prediction, which would
 * make the evaluation self-referential and over-optimistic.
 */
function defaultPredictor(_signal: ClassifierSignal): MemoryOutcome | null {
  return null;
}

// ── Quality stats ─────────────────────────────────────────────────────────────

function computeQualityStats(signals: ClassifierSignal[]): QualityStats {
  let passed = 0, failedNoise = 0, failedDuplicate = 0, failedCategory = 0;
  for (const s of signals) {
    if (s.quality.overall) {
      passed++;
    } else {
      if (!s.quality.passes_noise_threshold) failedNoise++;
      if (s.quality.is_duplicate) failedDuplicate++;
      if (!s.quality.category_included) failedCategory++;
    }
  }
  return { total: signals.length, passed, failed_noise: failedNoise, failed_duplicate: failedDuplicate, failed_category: failedCategory };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a ClassifierEvalReport for a batch of ClassifierSignal records.
 *
 * @param signals           The signals to evaluate (typically the output of
 *                          `extractClassifierSignals`).
 * @param referenceSignals  An optional earlier batch used for drift detection.
 * @param predicted         Optional custom predictor function. Defaults to the
 *                          confidence-threshold self-consistency predictor.
 */
export function generateEvalReport(
  signals: ClassifierSignal[],
  referenceSignals?: ClassifierSignal[],
  predicted: (s: ClassifierSignal) => MemoryOutcome | null = defaultPredictor,
): ClassifierEvalReport {
  const qualityStats = computeQualityStats(signals);

  const labeledSignals = signals.filter((s) => s.label?.outcome != null);
  const labelDistribution = buildDistribution(labeledSignals);

  // Per-class metrics
  const classes = Object.keys(labelDistribution) as MemoryOutcome[];
  const perClass: Partial<ClassBreakdown> = {};
  const precisions: number[] = [];
  const recalls: number[] = [];
  const f1s: number[] = [];

  for (const cls of classes) {
    const metrics = computeClassMetrics(labeledSignals, cls, predicted);
    perClass[cls] = metrics;
    if (metrics.precision != null) precisions.push(metrics.precision);
    if (metrics.recall != null) recalls.push(metrics.recall);
    if (metrics.f1 != null) f1s.push(metrics.f1);
  }

  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const macro: ClassMetrics = {
    precision: avg(precisions),
    recall: avg(recalls),
    f1: avg(f1s),
  };

  // Drift calculation
  let drift: DriftResult | null = null;
  if (referenceSignals && referenceSignals.length > 0) {
    const refDist = normalise(buildDistribution(referenceSignals));
    const curDist = normalise(buildDistribution(labeledSignals));
    drift = {
      score: jsDivergence(refDist, curDist),
      reference_distribution: refDist,
      current_distribution: curDist,
    };
  }

  return {
    schema_version: CLASSIFIER_SIGNAL_SCHEMA_VERSION,
    total_signals: signals.length,
    labeled_signals: labeledSignals.length,
    label_distribution: labelDistribution,
    macro,
    per_class: perClass,
    quality_stats: qualityStats,
    drift,
    generated_at: Date.now(),
  };
}
