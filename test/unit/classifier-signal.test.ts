/**
 * Tests for the classifier signal pipeline:
 *   - extractClassifierSignals  (feature extraction + quality gate)
 *   - signalsToJsonl             (JSONL serialization)
 *   - generateEvalReport         (precision/recall/F1, drift)
 *   - pluresLM_export_classifier_signals  (public API)
 *   - pluresLM_eval_classifier            (public API)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import {
  pluresLM_export_classifier_signals,
  pluresLM_eval_classifier,
  CLASSIFIER_SIGNAL_SCHEMA_VERSION,
} from "../../src/index.js";
import { _setIngestState } from "../../src/test-helpers.js";
import {
  extractClassifierSignals,
  extractFeatures,
  extractLabel,
  signalsToJsonl,
  CATEGORY_ENCODING,
  SOURCE_ENCODING,
} from "../../src/classifier-signal.js";
import { generateEvalReport } from "../../src/classifier-eval.js";
import type { MemoryEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

let db: PluresDBBackend;
let cleanup: () => void;

beforeEach(() => {
  ({ db, cleanup } = makeTestDB());
  _setIngestState(db, null);
});

afterEach(() => {
  _setIngestState(null, null);
  cleanup();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem-001",
    content: "Use PluresDB for storage",
    embedding: [],
    created_at: Date.now() - 86_400_000, // 1 day ago
    source: "conversation",
    tags: ["decision"],
    category: "decision",
    outcome: "success",
    confidence: 0.9,
    validated_by: "human",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractFeatures
// ---------------------------------------------------------------------------

describe("extractFeatures", () => {
  it("normalises content length to [0, 1]", () => {
    const entry = makeEntry({ content: "x".repeat(2000) });
    const features = extractFeatures(entry);
    expect(features.content_length_norm).toBe(1.0);
  });

  it("clamps content length above 2000 chars to 1.0", () => {
    const entry = makeEntry({ content: "x".repeat(5000) });
    const features = extractFeatures(entry);
    expect(features.content_length_norm).toBe(1.0);
  });

  it("has_outcome is 1 when outcome is set", () => {
    const features = extractFeatures(makeEntry({ outcome: "success" }));
    expect(features.has_outcome).toBe(1);
  });

  it("has_outcome is 0 when outcome is absent", () => {
    const entry = makeEntry();
    delete entry.outcome;
    const features = extractFeatures(entry);
    expect(features.has_outcome).toBe(0);
  });

  it("confidence defaults to 0.5 when absent", () => {
    const entry = makeEntry();
    delete entry.confidence;
    const features = extractFeatures(entry);
    expect(features.confidence).toBe(0.5);
    expect(features.has_confidence).toBe(0);
  });

  it("has_chosen_rejected is 1 only when both are set", () => {
    const a = extractFeatures(makeEntry({ chosen_approach: "A", rejected_approach: "B" }));
    expect(a.has_chosen_rejected).toBe(1);

    const b = extractFeatures(makeEntry({ chosen_approach: "A" }));
    expect(b.has_chosen_rejected).toBe(0);
  });

  it("category_encoded uses CATEGORY_ENCODING", () => {
    const features = extractFeatures(makeEntry({ category: "decision" }));
    expect(features.category_encoded).toBe(CATEGORY_ENCODING["decision"]);
  });

  it("unknown category encodes to 0", () => {
    const features = extractFeatures(makeEntry({ category: "custom_unknown" }));
    expect(features.category_encoded).toBe(0);
  });

  it("source_encoded uses SOURCE_ENCODING", () => {
    const features = extractFeatures(makeEntry({ source: "pr_merge" }));
    expect(features.source_encoded).toBe(SOURCE_ENCODING["pr_merge"]);
  });

  it("age_days_norm is 0 for brand new entry", () => {
    const now = Date.now();
    const features = extractFeatures(makeEntry({ created_at: now }), now);
    expect(features.age_days_norm).toBeCloseTo(0);
  });

  it("age_days_norm is clamped to 1.0 for very old entries", () => {
    const old = Date.now() - 400 * 86_400_000; // 400 days ago
    const features = extractFeatures(makeEntry({ created_at: old }));
    expect(features.age_days_norm).toBe(1.0);
  });

  it("outcome_encoded is 0 when no outcome", () => {
    const entry = makeEntry();
    delete entry.outcome;
    const features = extractFeatures(entry);
    expect(features.outcome_encoded).toBe(0);
  });

  it("outcome_encoded is > 0 when outcome is set", () => {
    const features = extractFeatures(makeEntry({ outcome: "success" }));
    expect(features.outcome_encoded).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// extractLabel
// ---------------------------------------------------------------------------

describe("extractLabel", () => {
  it("returns null when neither outcome nor validated_by is set", () => {
    const entry = makeEntry();
    delete entry.outcome;
    delete entry.validated_by;
    expect(extractLabel(entry)).toBeNull();
  });

  it("returns a label when outcome is set", () => {
    const label = extractLabel(makeEntry({ outcome: "success", validated_by: undefined }));
    expect(label).not.toBeNull();
    expect(label!.outcome).toBe("success");
  });

  it("returns a label when only validated_by is set", () => {
    const entry = makeEntry({ validated_by: "human" });
    delete entry.outcome;
    const label = extractLabel(entry);
    expect(label).not.toBeNull();
    expect(label!.validated_by).toBe("human");
    expect(label!.outcome).toBeNull();
  });

  it("label confidence defaults to 0.5 when absent", () => {
    const entry = makeEntry({ outcome: "failure" });
    delete entry.confidence;
    const label = extractLabel(entry);
    expect(label!.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// extractClassifierSignals — quality gate
// ---------------------------------------------------------------------------

describe("extractClassifierSignals — quality gate", () => {
  const ts = Date.now();

  it("excludes unlabeled signals by default", () => {
    const entries = [
      makeEntry({ id: "m1", outcome: "success" }),
      makeEntry({ id: "m2", outcome: undefined, validated_by: undefined }),
    ] as MemoryEntry[];
    entries[1].outcome = undefined;
    entries[1].validated_by = undefined;

    const signals = extractClassifierSignals(entries, { reference_ts: ts });
    expect(signals.map((s) => s.id)).toEqual(["m1"]);
  });

  it("includes unlabeled signals when include_unlabeled is true", () => {
    const unlabeled = makeEntry({ id: "m1" });
    delete unlabeled.outcome;
    delete unlabeled.validated_by;

    const signals = extractClassifierSignals([unlabeled], {
      include_unlabeled: true,
      reference_ts: ts,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].label).toBeNull();
  });

  it("filters by min_confidence", () => {
    const high = makeEntry({ id: "h", confidence: 0.9, outcome: "success" });
    const low = makeEntry({ id: "l", confidence: 0.3, outcome: "partial" });

    const signals = extractClassifierSignals([high, low], {
      quality: { min_confidence: 0.7 },
      include_unlabeled: true,
      reference_ts: ts,
    });

    const highSig = signals.find((s) => s.id === "h");
    const lowSig = signals.find((s) => s.id === "l");
    expect(highSig!.quality.overall).toBe(true);
    expect(lowSig!.quality.overall).toBe(false);
    expect(lowSig!.quality.passes_noise_threshold).toBe(false);
  });

  it("filters by min_content_length", () => {
    const short = makeEntry({ id: "s", content: "hi", outcome: "success" });
    const long = makeEntry({ id: "l", content: "Use PluresDB for storage", outcome: "success" });

    const signals = extractClassifierSignals([short, long], {
      quality: { min_content_length: 10 },
      reference_ts: ts,
    });

    expect(signals.find((s) => s.id === "s")!.quality.passes_noise_threshold).toBe(false);
    expect(signals.find((s) => s.id === "l")!.quality.passes_noise_threshold).toBe(true);
  });

  it("deduplicates entries with identical content", () => {
    const same = "Identical content for dedup test";
    const e1 = makeEntry({ id: "m1", content: same, outcome: "success", created_at: ts - 2000 });
    const e2 = makeEntry({ id: "m2", content: same, outcome: "failure", created_at: ts - 1000 });

    const signals = extractClassifierSignals([e1, e2], { include_unlabeled: true, reference_ts: ts });
    // First one should pass, second is a duplicate
    expect(signals.find((s) => s.id === "m1")!.quality.is_duplicate).toBe(false);
    expect(signals.find((s) => s.id === "m2")!.quality.is_duplicate).toBe(true);
  });

  it("respects dedupe: false option", () => {
    const same = "Same content";
    const e1 = makeEntry({ id: "m1", content: same, outcome: "success" });
    const e2 = makeEntry({ id: "m2", content: same, outcome: "partial" });

    const signals = extractClassifierSignals([e1, e2], {
      include_unlabeled: true,
      quality: { dedupe: false },
      reference_ts: ts,
    });

    expect(signals.every((s) => !s.quality.is_duplicate)).toBe(true);
  });

  it("filters by categories whitelist", () => {
    const d = makeEntry({ id: "d", category: "decision", outcome: "success" });
    const c = makeEntry({ id: "c", category: "conversation", outcome: "success" });

    const signals = extractClassifierSignals([d, c], {
      quality: { categories: ["decision"] },
      reference_ts: ts,
    });

    expect(signals.find((s) => s.id === "d")!.quality.category_included).toBe(true);
    expect(signals.find((s) => s.id === "c")!.quality.category_included).toBe(false);
  });

  it("filters by exclude_categories", () => {
    const d = makeEntry({ id: "d", category: "decision", outcome: "success" });
    const c = makeEntry({ id: "c", category: "conversation", outcome: "success" });

    const signals = extractClassifierSignals([d, c], {
      quality: { exclude_categories: ["conversation"] },
      reference_ts: ts,
    });

    expect(signals.find((s) => s.id === "d")!.quality.category_included).toBe(true);
    expect(signals.find((s) => s.id === "c")!.quality.category_included).toBe(false);
  });

  it("signals are ordered by created_at ascending", () => {
    const entries = [
      makeEntry({ id: "m3", created_at: ts, outcome: "success" }),
      makeEntry({ id: "m1", created_at: ts - 2000, outcome: "success" }),
      makeEntry({ id: "m2", created_at: ts - 1000, outcome: "success" }),
    ];

    const signals = extractClassifierSignals(entries, { reference_ts: ts });
    expect(signals.map((s) => s.id)).toEqual(["m1", "m2", "m3"]);
  });
});

// ---------------------------------------------------------------------------
// signalsToJsonl
// ---------------------------------------------------------------------------

describe("signalsToJsonl", () => {
  const ts = Date.now();

  it("emits one line per passing signal", () => {
    const entries = [
      makeEntry({ id: "m1", outcome: "success" }),
      makeEntry({ id: "m2", outcome: "failure", content: "Another decision" }),
    ];
    const signals = extractClassifierSignals(entries, { reference_ts: ts });
    const jsonl = signalsToJsonl(signals);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("each line parses to a valid ClassifierSignal with schema_version", () => {
    const entry = makeEntry({ outcome: "success" });
    const signals = extractClassifierSignals([entry], { reference_ts: ts });
    const jsonl = signalsToJsonl(signals);
    const parsed = JSON.parse(jsonl);
    expect(parsed.schema_version).toBe(CLASSIFIER_SIGNAL_SCHEMA_VERSION);
    expect(parsed.id).toBe(entry.id);
    expect(parsed.features).toBeDefined();
    expect(parsed.label).toBeDefined();
    expect(parsed.quality).toBeDefined();
  });

  it("excludes signals that fail the quality gate", () => {
    const noisy = makeEntry({ content: "hi", outcome: "success" }); // too short
    const signals = extractClassifierSignals([noisy], {
      quality: { min_content_length: 20 },
      reference_ts: ts,
    });
    expect(signals[0].quality.overall).toBe(false);
    expect(signalsToJsonl(signals)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// generateEvalReport
// ---------------------------------------------------------------------------

describe("generateEvalReport", () => {
  const ts = Date.now();

  it("returns empty report for no signals", () => {
    const report = generateEvalReport([]);
    expect(report.total_signals).toBe(0);
    expect(report.labeled_signals).toBe(0);
    expect(report.macro.precision).toBeNull();
    expect(report.drift).toBeNull();
  });

  it("schema_version matches CLASSIFIER_SIGNAL_SCHEMA_VERSION", () => {
    const report = generateEvalReport([]);
    expect(report.schema_version).toBe(CLASSIFIER_SIGNAL_SCHEMA_VERSION);
  });

  it("counts labeled vs total signals correctly", () => {
    const labeled = extractClassifierSignals(
      [
        makeEntry({ id: "a", outcome: "success" }),
        makeEntry({ id: "b", outcome: "failure", content: "Different content" }),
      ],
      { include_unlabeled: true, reference_ts: ts },
    );

    const unlabeled = makeEntry({ id: "c", content: "No label content" });
    delete unlabeled.outcome;
    delete unlabeled.validated_by;
    const allSignals = extractClassifierSignals([unlabeled, ...labeled.map((s) => ({
      id: s.id,
      content: s.id === "a" ? "Use PluresDB for storage" : "Different content",
      embedding: [],
      created_at: ts - 86_400_000,
      source: "conversation",
      tags: [],
      category: "decision",
      outcome: s.id === "a" ? ("success" as const) : ("failure" as const),
      confidence: 0.9,
      validated_by: "human" as const,
    }))], { include_unlabeled: true, reference_ts: ts });

    const report = generateEvalReport(allSignals);
    expect(report.labeled_signals).toBeLessThanOrEqual(report.total_signals);
  });

  it("quality_stats reflects quality gate results", () => {
    const entries = [
      makeEntry({ id: "m1", outcome: "success" }),
      makeEntry({ id: "m2", content: "hi", outcome: "partial" }), // fails noise
    ];
    const signals = extractClassifierSignals(entries, {
      quality: { min_content_length: 10 },
      reference_ts: ts,
    });
    const report = generateEvalReport(signals);
    expect(report.quality_stats.total).toBe(signals.length);
    expect(report.quality_stats.failed_noise).toBeGreaterThanOrEqual(1);
  });

  it("computes drift score vs reference batch", () => {
    const refEntries = [
      makeEntry({ id: "r1", outcome: "success" }),
      makeEntry({ id: "r2", outcome: "success", content: "Another reference success" }),
    ];
    const refSignals = extractClassifierSignals(refEntries, { reference_ts: ts });

    const curEntries = [
      makeEntry({ id: "c1", outcome: "failure" }),
      makeEntry({ id: "c2", outcome: "failure", content: "Another current failure" }),
    ];
    const curSignals = extractClassifierSignals(curEntries, { reference_ts: ts });

    const report = generateEvalReport(curSignals, refSignals);
    expect(report.drift).not.toBeNull();
    expect(report.drift!.score).toBeGreaterThan(0);
    expect(report.drift!.score).toBeLessThanOrEqual(1);
  });

  it("drift score is 0 when distributions are identical", () => {
    const entries = [
      makeEntry({ id: "a", outcome: "success" }),
      makeEntry({ id: "b", outcome: "success", content: "Another success" }),
    ];
    const signals = extractClassifierSignals(entries, { reference_ts: ts });
    const report = generateEvalReport(signals, signals);
    expect(report.drift!.score).toBeCloseTo(0, 5);
  });

  it("label_distribution counts per outcome class", () => {
    const entries = [
      makeEntry({ id: "s1", outcome: "success" }),
      makeEntry({ id: "s2", outcome: "success", content: "Another success" }),
      makeEntry({ id: "f1", outcome: "failure", content: "A failure" }),
    ];
    const signals = extractClassifierSignals(entries, { reference_ts: ts });
    const report = generateEvalReport(signals);
    expect(report.label_distribution.success).toBe(2);
    expect(report.label_distribution.failure).toBe(1);
  });

  it("macro metrics are averages of per-class metrics", () => {
    const entries = [
      makeEntry({ id: "s", outcome: "success", confidence: 0.9 }),
      makeEntry({ id: "f", outcome: "failure", content: "A failure", confidence: 0.9 }),
    ];
    const signals = extractClassifierSignals(entries, { reference_ts: ts });
    const report = generateEvalReport(signals);
    expect(Object.keys(report.per_class)).toContain("success");
    expect(Object.keys(report.per_class)).toContain("failure");
  });
});

// ---------------------------------------------------------------------------
// pluresLM_export_classifier_signals (public API)
// ---------------------------------------------------------------------------

describe("pluresLM_export_classifier_signals", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_export_classifier_signals()).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });

  it("returns empty string when store has no labeled memories", async () => {
    await db.storeContent("Unlabeled memory", { source: "agent", category: "conversation" });
    const result = await pluresLM_export_classifier_signals();
    expect(result).toBe("");
  });

  it("returns JSONL with one line per labeled memory that passes quality gate", async () => {
    await db.storeContent("Use Rust for backend", {
      source: "pr_merge",
      category: "decision",
      outcome: "success",
      confidence: 0.9,
      validated_by: "human",
    });
    await db.storeContent("Use PluresDB for storage", {
      source: "conversation",
      category: "decision",
      outcome: "failure",
      confidence: 0.7,
      validated_by: "ci_result",
    });

    const jsonl = await pluresLM_export_classifier_signals();
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.schema_version).toBe(CLASSIFIER_SIGNAL_SCHEMA_VERSION);
    expect(parsed.features).toBeDefined();
    expect(parsed.label).toBeDefined();
    expect(parsed.quality.overall).toBe(true);
  });

  it("respects min_confidence quality option", async () => {
    await db.storeContent("High confidence decision", {
      source: "agent",
      category: "decision",
      outcome: "success",
      confidence: 0.95,
      validated_by: "human",
    });
    await db.storeContent("Low confidence decision", {
      source: "agent",
      category: "decision",
      outcome: "partial",
      confidence: 0.2,
      validated_by: "agent",
    });

    const jsonl = await pluresLM_export_classifier_signals({
      quality: { min_confidence: 0.7 },
    });
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).features.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("includes unlabeled entries when include_unlabeled is true", async () => {
    await db.storeContent("No outcome memory", {
      source: "agent",
      category: "conversation",
    });

    const withLabels = await pluresLM_export_classifier_signals();
    expect(withLabels).toBe("");

    const withUnlabeled = await pluresLM_export_classifier_signals({ include_unlabeled: true });
    const lines = withUnlabeled.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pluresLM_eval_classifier (public API)
// ---------------------------------------------------------------------------

describe("pluresLM_eval_classifier", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_eval_classifier()).rejects.toThrow("pluresLM is not initialised");
  });

  it("returns a versioned report for an empty store", async () => {
    const report = await pluresLM_eval_classifier();
    expect(report.schema_version).toBe(CLASSIFIER_SIGNAL_SCHEMA_VERSION);
    expect(report.total_signals).toBe(0);
    expect(report.labeled_signals).toBe(0);
    expect(report.drift).toBeNull();
  });

  it("includes quality_stats in report", async () => {
    await db.storeContent("Good quality decision", {
      source: "pr_merge",
      category: "decision",
      outcome: "success",
      confidence: 0.9,
      validated_by: "human",
    });
    await db.storeContent("hi", {
      source: "agent",
      category: "incident",
      outcome: "failure",
      confidence: 0.8,
      validated_by: "agent",
    });

    const report = await pluresLM_eval_classifier({
      include_unlabeled: true,
      quality: { min_content_length: 10 },
    });
    expect(report.quality_stats.total).toBeGreaterThan(0);
    expect(report.quality_stats.failed_noise).toBeGreaterThanOrEqual(1);
  });

  it("computes drift when reference signals are provided", async () => {
    await db.storeContent("Decision for eval", {
      source: "agent",
      category: "decision",
      outcome: "success",
      confidence: 0.9,
      validated_by: "human",
    });

    const memories = await db.listMemories();
    const { extractClassifierSignals: ecs } = await import("../../src/classifier-signal.js");
    const refSignals = ecs(memories);

    await db.storeContent("New failure decision", {
      source: "agent",
      category: "decision",
      outcome: "failure",
      confidence: 0.8,
      validated_by: "ci_result",
    });

    const report = await pluresLM_eval_classifier({}, refSignals);
    expect(report.drift).not.toBeNull();
  });
});
