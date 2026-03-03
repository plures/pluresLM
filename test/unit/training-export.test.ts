/**
 * Tests for the training data export APIs:
 *   pluresLM_record_outcome, pluresLM_export_training, pluresLM_get_training_stats
 *
 * Module-level state is injected via _setIngestState so no plugin runtime is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import {
  pluresLM_record_outcome,
  pluresLM_export_training,
  pluresLM_get_training_stats,
} from "../../src/index.js";
import { _setIngestState } from "../../src/test-helpers.js";

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
// pluresLM_record_outcome
// ---------------------------------------------------------------------------

describe("pluresLM_record_outcome", () => {
  it("returns false for an unknown memoryId", async () => {
    const result = await pluresLM_record_outcome("nonexistent-id", "success");
    expect(result).toBe(false);
  });

  it("updates the outcome on an existing memory", async () => {
    const { entry } = await db.storeContent("Use Rust for the backend", {
      source: "conversation",
      category: "decision",
    });

    const updated = await pluresLM_record_outcome(entry.id, "success", "Build passed");
    expect(updated).toBe(true);

    const memories = await db.listMemories();
    const found = memories.find((m) => m.id === entry.id);
    expect(found).toBeDefined();
    expect(found!.outcome).toBe("success");
    expect(found!.outcome_evidence).toBe("Build passed");
    expect(found!.outcome_timestamp).toBeTypeOf("number");
  });

  it("updates outcome without evidence when evidence is omitted", async () => {
    const { entry } = await db.storeContent("Use ESM only", { source: "pr_merge" });

    await pluresLM_record_outcome(entry.id, "partial");

    const memories = await db.listMemories();
    const found = memories.find((m) => m.id === entry.id);
    expect(found!.outcome).toBe("partial");
    expect(found!.outcome_evidence).toBeUndefined();
  });

  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_record_outcome("id", "success")).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });
});

// ---------------------------------------------------------------------------
// pluresLM_export_training — sft format
// ---------------------------------------------------------------------------

describe("pluresLM_export_training — sft", () => {
  it("returns empty string when no memories have a conversation_window", async () => {
    await db.storeContent("standalone memory", { source: "agent", confidence: 0.8 });
    const result = await pluresLM_export_training("sft");
    expect(result).toBe("");
  });

  it("produces one JSONL line per memory with a conversation_window", async () => {
    await db.storeContent("Decision A", {
      source: "conversation",
      confidence: 0.9,
      conversation_window: [
        { role: "user", content: "What DB?", timestamp: 1 },
        { role: "assistant", content: "PluresDB", timestamp: 2 },
      ],
    });
    await db.storeContent("Decision B", {
      source: "conversation",
      confidence: 0.7,
      conversation_window: [
        { role: "user", content: "What language?", timestamp: 3 },
        { role: "assistant", content: "Rust", timestamp: 4 },
      ],
    });

    const jsonl = await pluresLM_export_training("sft");
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toHaveProperty("messages");
    expect(parsed[0].messages[0]).toMatchObject({ role: "user", content: "What DB?" });
  });

  it("respects min_confidence filter", async () => {
    await db.storeContent("High conf", {
      source: "conversation",
      confidence: 0.9,
      conversation_window: [{ role: "user", content: "Q?", timestamp: 1 }],
    });
    await db.storeContent("Low conf", {
      source: "conversation",
      confidence: 0.3,
      conversation_window: [{ role: "user", content: "X?", timestamp: 2 }],
    });

    const jsonl = await pluresLM_export_training("sft", 0.8);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).messages[0].content).toBe("Q?");
  });

  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_export_training("sft")).rejects.toThrow("pluresLM is not initialised");
  });
});

// ---------------------------------------------------------------------------
// pluresLM_export_training — dpo format
// ---------------------------------------------------------------------------

describe("pluresLM_export_training — dpo", () => {
  it("only includes memories with both chosen and rejected approaches", async () => {
    await db.storeContent("Full DPO", {
      source: "conversation",
      confidence: 0.8,
      chosen_approach: "PluresDB",
      rejected_approach: "SQLite",
    });
    await db.storeContent("Missing rejected", {
      source: "conversation",
      confidence: 0.8,
      chosen_approach: "Rust",
    });

    const jsonl = await pluresLM_export_training("dpo");
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({ chosen: "PluresDB", rejected: "SQLite" });
    expect(record.prompt).toBeTypeOf("string");
  });

  it("uses first conversation_window entry as prompt when available", async () => {
    await db.storeContent("With window", {
      source: "conversation",
      confidence: 0.8,
      chosen_approach: "A",
      rejected_approach: "B",
      conversation_window: [{ role: "user", content: "Pick one?", timestamp: 1 }],
    });

    const jsonl = await pluresLM_export_training("dpo");
    const record = JSON.parse(jsonl);
    expect(record.prompt).toBe("Pick one?");
  });
});

// ---------------------------------------------------------------------------
// pluresLM_export_training — rlhf format
// ---------------------------------------------------------------------------

describe("pluresLM_export_training — rlhf", () => {
  it("includes all memories (no conversation_window required)", async () => {
    await db.storeContent("memory 1", { source: "agent" });
    await db.storeContent("memory 2", { source: "agent" });

    const jsonl = await pluresLM_export_training("rlhf");
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("computes reward as confidence × outcome_score", async () => {
    await db.storeContent("Success", {
      source: "agent",
      confidence: 0.8,
      outcome: "success",
    });

    const jsonl = await pluresLM_export_training("rlhf");
    const record = JSON.parse(jsonl);
    // reward = 0.8 × 1.0 = 0.8
    expect(record.reward).toBeCloseTo(0.8);
  });

  it("reward = 0 for failure outcome", async () => {
    await db.storeContent("Failure", {
      source: "agent",
      confidence: 0.9,
      outcome: "failure",
    });

    const jsonl = await pluresLM_export_training("rlhf");
    const record = JSON.parse(jsonl);
    expect(record.reward).toBeCloseTo(0.0);
  });

  it("reward = confidence × 0.5 when outcome is unknown/partial", async () => {
    await db.storeContent("Partial", {
      source: "agent",
      confidence: 0.6,
      outcome: "partial",
    });

    const jsonl = await pluresLM_export_training("rlhf");
    const record = JSON.parse(jsonl);
    expect(record.reward).toBeCloseTo(0.3);
  });

  it("defaults confidence to 0.5 when not set", async () => {
    await db.storeContent("No confidence", {
      source: "agent",
      outcome: "success",
    });

    const jsonl = await pluresLM_export_training("rlhf");
    const record = JSON.parse(jsonl);
    // reward = 0.5 × 1.0 = 0.5
    expect(record.reward).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// pluresLM_get_training_stats
// ---------------------------------------------------------------------------

describe("pluresLM_get_training_stats", () => {
  it("returns zeros for an empty store", async () => {
    const stats = await pluresLM_get_training_stats();
    expect(stats.total).toBe(0);
    expect(stats.with_outcome).toBe(0);
    expect(stats.with_confidence).toBe(0);
    expect(stats.with_conversation_window).toBe(0);
    expect(stats.with_chosen_rejected).toBe(0);
    expect(stats.outcome_distribution).toEqual({});
    expect(stats.avg_confidence).toBeNull();
  });

  it("counts memories accurately", async () => {
    await db.storeContent("A", {
      source: "agent",
      outcome: "success",
      confidence: 0.9,
      conversation_window: [{ role: "user", content: "Hi", timestamp: 1 }],
      chosen_approach: "X",
      rejected_approach: "Y",
    });
    await db.storeContent("B", {
      source: "agent",
      outcome: "failure",
      confidence: 0.4,
    });
    await db.storeContent("C", {
      source: "agent",
    });

    const stats = await pluresLM_get_training_stats();
    expect(stats.total).toBe(3);
    expect(stats.with_outcome).toBe(2);
    expect(stats.with_confidence).toBe(2);
    expect(stats.with_conversation_window).toBe(1);
    expect(stats.with_chosen_rejected).toBe(1);
    expect(stats.outcome_distribution).toEqual({ success: 1, failure: 1 });
    expect(stats.avg_confidence).toBeCloseTo((0.9 + 0.4) / 2);
  });

  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_get_training_stats()).rejects.toThrow("pluresLM is not initialised");
  });
});
