/**
 * Tests for the Optimization Trap Memory schema and retrieval API:
 *   - encodeOptimizationTrap / decodeOptimizationTrap (codec round-trip)
 *   - trapsToJsonl (export serialisation)
 *   - contextFingerprint (stable context hashing)
 *   - pluresLM_store_optimization_trap
 *   - pluresLM_find_similar_traps
 *   - pluresLM_export_optimization_traps
 *   - pluresLM_trap_context_fingerprint
 *
 * All tests use the in-memory PluresDBBackend stub — no native binary required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeTestDB } from "../helpers/db.js";
import { makeVec } from "../helpers/embeddings.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import {
  OPTIMIZATION_TRAP_SCHEMA_VERSION,
  OPTIMIZATION_TRAP_CATEGORY,
  encodeOptimizationTrap,
  decodeOptimizationTrap,
  trapsToJsonl,
  contextFingerprint,
  type OptimizationTrap,
  type OptimizationTrapExportRecord,
} from "../../src/optimization-trap.js";
import {
  pluresLM_store_optimization_trap,
  pluresLM_find_similar_traps,
  pluresLM_export_optimization_traps,
  pluresLM_trap_context_fingerprint,
} from "../../src/index.js";
import { _setIngestState } from "../../src/test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "../fixtures/memories/sample-optimization-traps.json");

function loadFixtureTraps(): Array<Omit<OptimizationTrap, "id" | "schemaVersion" | "recordedAt">> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Array<
    Omit<OptimizationTrap, "id" | "schemaVersion" | "recordedAt">
  >;
}

function makeTrapInput(
  overrides: Partial<Omit<OptimizationTrap, "id" | "schemaVersion" | "recordedAt">> = {},
): Omit<OptimizationTrap, "id" | "schemaVersion" | "recordedAt"> {
  return {
    objective: "Minimise API latency",
    contextSignature: ["service:api", "env:prod"],
    missingSignals: ["queue-depth", "db-pool-util"],
    unsafeRecommendationPattern: "Disable connection pooling",
    outcome: "avoided",
    outcomeDescription: "Pooling is required under load",
    correctiveGuardrail: "Profile before tuning pool size",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State setup
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
// Schema constants
// ---------------------------------------------------------------------------

describe("OPTIMIZATION_TRAP_SCHEMA_VERSION", () => {
  it("is a semver string", () => {
    expect(OPTIMIZATION_TRAP_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("equals 1.0.0 for the initial release", () => {
    expect(OPTIMIZATION_TRAP_SCHEMA_VERSION).toBe("1.0.0");
  });
});

describe("OPTIMIZATION_TRAP_CATEGORY", () => {
  it("is the string optimization-trap", () => {
    expect(OPTIMIZATION_TRAP_CATEGORY).toBe("optimization-trap");
  });
});

// ---------------------------------------------------------------------------
// Codec: encodeOptimizationTrap / decodeOptimizationTrap
// ---------------------------------------------------------------------------

describe("encodeOptimizationTrap", () => {
  it("produces content combining objective and unsafe pattern", () => {
    const input = makeTrapInput();
    const { content } = encodeOptimizationTrap(input);
    expect(content).toContain(input.objective);
    expect(content).toContain(input.unsafeRecommendationPattern);
  });

  it("includes the schema version tag", () => {
    const { tags } = encodeOptimizationTrap(makeTrapInput());
    expect(tags.some((t) => t.startsWith("trap:schema:"))).toBe(true);
    expect(tags.some((t) => t === `trap:schema:${OPTIMIZATION_TRAP_SCHEMA_VERSION}`)).toBe(true);
  });

  it("includes the outcome tag", () => {
    const { tags } = encodeOptimizationTrap(makeTrapInput({ outcome: "realized" }));
    expect(tags).toContain("trap:outcome:realized");
  });

  it("includes the OPTIMIZATION_TRAP_CATEGORY tag", () => {
    const { tags } = encodeOptimizationTrap(makeTrapInput());
    expect(tags).toContain(OPTIMIZATION_TRAP_CATEGORY);
  });

  it("JSON-encodes missingSignals in a tag", () => {
    const signals = ["sig-a", "sig-b"];
    const { tags } = encodeOptimizationTrap(makeTrapInput({ missingSignals: signals }));
    const missingTag = tags.find((t) => t.startsWith("trap:missing_signals:"));
    expect(missingTag).toBeDefined();
    expect(JSON.parse(missingTag!.slice("trap:missing_signals:".length))).toEqual(signals);
  });

  it("JSON-encodes contextSignature in a tag", () => {
    const ctx = ["service:x", "env:staging"];
    const { tags } = encodeOptimizationTrap(makeTrapInput({ contextSignature: ctx }));
    const ctxTag = tags.find((t) => t.startsWith("trap:context_sig:"));
    expect(ctxTag).toBeDefined();
    expect(JSON.parse(ctxTag!.slice("trap:context_sig:".length))).toEqual(ctx);
  });

  it("propagates outcomeDescription", () => {
    const { outcomeDescription } = encodeOptimizationTrap(
      makeTrapInput({ outcomeDescription: "It was bad" }),
    );
    expect(outcomeDescription).toBe("It was bad");
  });

  it("outcomeDescription is undefined when not provided", () => {
    const input = makeTrapInput();
    delete (input as Partial<typeof input>).outcomeDescription;
    const { outcomeDescription } = encodeOptimizationTrap(input);
    expect(outcomeDescription).toBeUndefined();
  });
});

describe("decodeOptimizationTrap", () => {
  it("returns null for a non-trap category", () => {
    const fakeEntry = {
      id: "x",
      content: "hello",
      embedding: [],
      created_at: 0,
      source: "agent",
      tags: [],
      category: "decision",
      priority: "normal" as const,
    };
    expect(decodeOptimizationTrap(fakeEntry)).toBeNull();
  });

  it("returns null when required tags are missing", () => {
    const entry = {
      id: "y",
      content: "something",
      embedding: [],
      created_at: 0,
      source: "agent",
      tags: [OPTIMIZATION_TRAP_CATEGORY, "trap:outcome:avoided"],
      category: OPTIMIZATION_TRAP_CATEGORY,
      priority: "normal" as const,
    };
    expect(decodeOptimizationTrap(entry)).toBeNull();
  });

  it("returns null for an invalid outcome value", () => {
    const { tags } = encodeOptimizationTrap(makeTrapInput());
    const mutated = tags.map((t) =>
      t.startsWith("trap:outcome:") ? "trap:outcome:invalid" : t,
    );
    const entry = {
      id: "z",
      content: "test",
      embedding: [],
      created_at: Date.now(),
      source: "agent",
      tags: mutated,
      category: OPTIMIZATION_TRAP_CATEGORY,
      priority: "normal" as const,
    };
    expect(decodeOptimizationTrap(entry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: encode → decode
// ---------------------------------------------------------------------------

describe("encode → decode round-trip", () => {
  it("round-trips all fields for an avoided trap", () => {
    const input = makeTrapInput({
      outcome: "avoided",
      outcomeDescription: "Guardrail kicked in",
    });
    const { content, tags, outcomeDescription } = encodeOptimizationTrap(input);

    const syntheticEntry: MemoryEntry = {
      id: "round-trip-1",
      content,
      embedding: [],
      created_at: 1_700_000_000_000,
      source: "agent",
      tags,
      category: OPTIMIZATION_TRAP_CATEGORY,
      priority: "normal",
      outcome_evidence: outcomeDescription,
    };

    const decoded = decodeOptimizationTrap(syntheticEntry);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe("round-trip-1");
    expect(decoded!.schemaVersion).toBe(OPTIMIZATION_TRAP_SCHEMA_VERSION);
    expect(decoded!.objective).toBe(input.objective);
    expect(decoded!.contextSignature).toEqual(input.contextSignature);
    expect(decoded!.missingSignals).toEqual(input.missingSignals);
    expect(decoded!.unsafeRecommendationPattern).toBe(input.unsafeRecommendationPattern);
    expect(decoded!.outcome).toBe("avoided");
    expect(decoded!.outcomeDescription).toBe("Guardrail kicked in");
    expect(decoded!.correctiveGuardrail).toBe(input.correctiveGuardrail);
    expect(decoded!.recordedAt).toBe(1_700_000_000_000);
  });

  it("round-trips a realized trap with empty arrays", () => {
    const input = makeTrapInput({
      outcome: "realized",
      contextSignature: [],
      missingSignals: [],
      outcomeDescription: undefined,
    });
    const { content, tags } = encodeOptimizationTrap(input);

    const syntheticEntry: MemoryEntry = {
      id: "round-trip-2",
      content,
      embedding: [],
      created_at: 0,
      source: "agent",
      tags,
      category: OPTIMIZATION_TRAP_CATEGORY,
      priority: "normal",
    };

    const decoded = decodeOptimizationTrap(syntheticEntry);
    expect(decoded).not.toBeNull();
    expect(decoded!.outcome).toBe("realized");
    expect(decoded!.contextSignature).toEqual([]);
    expect(decoded!.missingSignals).toEqual([]);
    expect(decoded!.outcomeDescription).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// contextFingerprint
// ---------------------------------------------------------------------------

describe("contextFingerprint", () => {
  it("returns a hex string", () => {
    const fp = contextFingerprint(["a", "b"]);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it("is order-independent", () => {
    const fp1 = contextFingerprint(["env:prod", "service:api"]);
    const fp2 = contextFingerprint(["service:api", "env:prod"]);
    expect(fp1).toBe(fp2);
  });

  it("is case-insensitive", () => {
    const fp1 = contextFingerprint(["ENV:PROD"]);
    const fp2 = contextFingerprint(["env:prod"]);
    expect(fp1).toBe(fp2);
  });

  it("differs for different token sets", () => {
    const fp1 = contextFingerprint(["a"]);
    const fp2 = contextFingerprint(["b"]);
    expect(fp1).not.toBe(fp2);
  });

  it("returns a consistent value for an empty array", () => {
    expect(contextFingerprint([])).toBe(contextFingerprint([]));
  });
});

// ---------------------------------------------------------------------------
// trapsToJsonl
// ---------------------------------------------------------------------------

describe("trapsToJsonl", () => {
  it("returns an empty string for an empty array", () => {
    expect(trapsToJsonl([])).toBe("");
  });

  it("produces one valid JSON line per trap", () => {
    const traps: OptimizationTrap[] = [
      {
        id: "a",
        schemaVersion: OPTIMIZATION_TRAP_SCHEMA_VERSION,
        objective: "obj-a",
        contextSignature: ["ctx:1"],
        missingSignals: ["sig:1"],
        unsafeRecommendationPattern: "do-bad-thing",
        outcome: "avoided",
        correctiveGuardrail: "do-good-thing",
        recordedAt: 1_000,
      },
      {
        id: "b",
        schemaVersion: OPTIMIZATION_TRAP_SCHEMA_VERSION,
        objective: "obj-b",
        contextSignature: [],
        missingSignals: [],
        unsafeRecommendationPattern: "another-bad-thing",
        outcome: "realized",
        outcomeDescription: "It happened",
        correctiveGuardrail: "prevention-rule",
        recordedAt: 2_000,
      },
    ];

    const jsonl = trapsToJsonl(traps);
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const recordA = JSON.parse(lines[0]) as OptimizationTrapExportRecord;
    expect(recordA.trap_id).toBe("a");
    expect(recordA.schema_version).toBe(OPTIMIZATION_TRAP_SCHEMA_VERSION);
    expect(recordA.objective).toBe("obj-a");
    expect(recordA.context_signature).toEqual(["ctx:1"]);
    expect(recordA.missing_signals).toEqual(["sig:1"]);
    expect(recordA.unsafe_recommendation_pattern).toBe("do-bad-thing");
    expect(recordA.outcome).toBe("avoided");
    expect(recordA.outcome_description).toBeUndefined();
    expect(recordA.corrective_guardrail).toBe("do-good-thing");
    expect(recordA.recorded_at).toBe(1_000);

    const recordB = JSON.parse(lines[1]) as OptimizationTrapExportRecord;
    expect(recordB.outcome).toBe("realized");
    expect(recordB.outcome_description).toBe("It happened");
  });
});

// ---------------------------------------------------------------------------
// pluresLM_store_optimization_trap
// ---------------------------------------------------------------------------

describe("pluresLM_store_optimization_trap", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_store_optimization_trap(makeTrapInput())).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });

  it("returns a fully populated OptimizationTrap", async () => {
    const input = makeTrapInput();
    const trap = await pluresLM_store_optimization_trap(input);

    expect(trap.id).toBeTypeOf("string");
    expect(trap.id.length).toBeGreaterThan(0);
    expect(trap.schemaVersion).toBe(OPTIMIZATION_TRAP_SCHEMA_VERSION);
    expect(trap.objective).toBe(input.objective);
    expect(trap.contextSignature).toEqual(input.contextSignature);
    expect(trap.missingSignals).toEqual(input.missingSignals);
    expect(trap.unsafeRecommendationPattern).toBe(input.unsafeRecommendationPattern);
    expect(trap.outcome).toBe(input.outcome);
    expect(trap.outcomeDescription).toBe(input.outcomeDescription);
    expect(trap.correctiveGuardrail).toBe(input.correctiveGuardrail);
    expect(trap.recordedAt).toBeTypeOf("number");
  });

  it("stores the trap with the correct category", async () => {
    await pluresLM_store_optimization_trap(makeTrapInput());
    const memories = await db.listMemories();
    const trapMemories = memories.filter((m) => m.category === OPTIMIZATION_TRAP_CATEGORY);
    expect(trapMemories).toHaveLength(1);
  });

  it("can store multiple traps independently", async () => {
    await pluresLM_store_optimization_trap(makeTrapInput({ objective: "obj-1" }));
    await pluresLM_store_optimization_trap(makeTrapInput({ objective: "obj-2" }));

    const memories = await db.listMemories();
    const trapMemories = memories.filter((m) => m.category === OPTIMIZATION_TRAP_CATEGORY);
    expect(trapMemories).toHaveLength(2);
  });

  it("stores avoided trap with outcome = success in MemoryEntry", async () => {
    await pluresLM_store_optimization_trap(makeTrapInput({ outcome: "avoided" }));
    const memories = await db.listMemories();
    const trap = memories.find((m) => m.category === OPTIMIZATION_TRAP_CATEGORY);
    expect(trap!.outcome).toBe("success");
  });

  it("stores realized trap with outcome = failure in MemoryEntry", async () => {
    await pluresLM_store_optimization_trap(makeTrapInput({ outcome: "realized" }));
    const memories = await db.listMemories();
    const trap = memories.find((m) => m.category === OPTIMIZATION_TRAP_CATEGORY);
    expect(trap!.outcome).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// pluresLM_find_similar_traps
// ---------------------------------------------------------------------------

describe("pluresLM_find_similar_traps", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_find_similar_traps("latency")).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });

  it("returns empty array when no traps are stored (no embedText)", async () => {
    const results = await pluresLM_find_similar_traps("some query");
    expect(results).toEqual([]);
  });

  it("returns stored traps when embedText is null (fallback list mode)", async () => {
    await pluresLM_store_optimization_trap(makeTrapInput({ objective: "reduce latency" }));
    await pluresLM_store_optimization_trap(makeTrapInput({ objective: "reduce memory" }));

    // Also store a non-trap memory to verify filtering
    await db.storeContent("unrelated memory", { source: "agent", category: "decision" });

    const results = await pluresLM_find_similar_traps("latency");
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.schemaVersion === OPTIMIZATION_TRAP_SCHEMA_VERSION)).toBe(true);
  });

  it("respects the limit parameter in fallback mode", async () => {
    for (let i = 0; i < 5; i++) {
      await pluresLM_store_optimization_trap(makeTrapInput({ objective: `obj-${i}` }));
    }
    const results = await pluresLM_find_similar_traps("anything", 3);
    expect(results).toHaveLength(3);
  });

  it("uses vector search when embedText is provided", async () => {
    // Use deterministic vectors: trap A at dimension 0, trap B at dimension 4
    // Query at dimension 0 → trap A should rank first
    const vecA = makeVec(0);
    const vecB = makeVec(4);

    await db.store(
      "latency optimisation: disable connection pooling",
      vecA,
      {
        source: "agent",
        category: OPTIMIZATION_TRAP_CATEGORY,
        tags: [
          OPTIMIZATION_TRAP_CATEGORY,
          "trap:schema:1.0.0",
          "trap:outcome:avoided",
          "trap:objective:Minimise latency",
          "trap:unsafe_pattern:Disable connection pooling",
          "trap:missing_signals:[]",
          "trap:context_sig:[]",
          "trap:guardrail:Profile first",
        ],
      },
    );
    await db.store(
      "memory optimisation: clear all caches",
      vecB,
      {
        source: "agent",
        category: OPTIMIZATION_TRAP_CATEGORY,
        tags: [
          OPTIMIZATION_TRAP_CATEGORY,
          "trap:schema:1.0.0",
          "trap:outcome:realized",
          "trap:objective:Reduce memory",
          "trap:unsafe_pattern:Clear all caches",
          "trap:missing_signals:[]",
          "trap:context_sig:[]",
          "trap:guardrail:Profile cache first",
        ],
      },
    );

    // embedText returns a vector at dimension 0 — should match trap A first
    const stubEmbed = (_text: string) => Promise.resolve(makeVec(0));
    _setIngestState(db, stubEmbed);

    const results = await pluresLM_find_similar_traps("latency", 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].objective).toBe("Minimise latency");
  });
});

// ---------------------------------------------------------------------------
// pluresLM_export_optimization_traps
// ---------------------------------------------------------------------------

describe("pluresLM_export_optimization_traps", () => {
  it("throws when plugin is not initialised", async () => {
    _setIngestState(null, null);
    await expect(pluresLM_export_optimization_traps()).rejects.toThrow(
      "pluresLM is not initialised",
    );
  });

  it("returns empty string when no traps are stored", async () => {
    const result = await pluresLM_export_optimization_traps();
    expect(result).toBe("");
  });

  it("excludes non-trap memories from the export", async () => {
    await db.storeContent("unrelated note", { source: "agent", category: "note" });
    const result = await pluresLM_export_optimization_traps();
    expect(result).toBe("");
  });

  it("exports all stored traps as JSONL", async () => {
    await pluresLM_store_optimization_trap(makeTrapInput({ objective: "trap-1" }));
    await pluresLM_store_optimization_trap(makeTrapInput({ objective: "trap-2" }));

    const jsonl = await pluresLM_export_optimization_traps();
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const records = lines.map((l) => JSON.parse(l) as OptimizationTrapExportRecord);
    const objectives = records.map((r) => r.objective).sort();
    expect(objectives).toEqual(["trap-1", "trap-2"]);
  });

  it("each exported line is a valid OptimizationTrapExportRecord", async () => {
    await pluresLM_store_optimization_trap(
      makeTrapInput({
        outcome: "realized",
        outcomeDescription: "It went wrong",
      }),
    );

    const jsonl = await pluresLM_export_optimization_traps();
    const record = JSON.parse(jsonl) as OptimizationTrapExportRecord;

    expect(record.trap_id).toBeTypeOf("string");
    expect(record.schema_version).toBe(OPTIMIZATION_TRAP_SCHEMA_VERSION);
    expect(record.objective).toBeTypeOf("string");
    expect(record.context_signature).toBeInstanceOf(Array);
    expect(record.missing_signals).toBeInstanceOf(Array);
    expect(record.unsafe_recommendation_pattern).toBeTypeOf("string");
    expect(record.outcome).toBe("realized");
    expect(record.outcome_description).toBe("It went wrong");
    expect(record.corrective_guardrail).toBeTypeOf("string");
    expect(record.recorded_at).toBeTypeOf("number");
  });

  it("round-trips the example corpus fixture", async () => {
    const fixtures = loadFixtureTraps();
    for (const f of fixtures) {
      await pluresLM_store_optimization_trap(f);
    }

    const jsonl = await pluresLM_export_optimization_traps();
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(fixtures.length);

    for (const line of lines) {
      const record = JSON.parse(line) as OptimizationTrapExportRecord;
      expect(record.schema_version).toBe(OPTIMIZATION_TRAP_SCHEMA_VERSION);
      expect(["avoided", "realized"]).toContain(record.outcome);
      expect(record.trap_id).toBeTypeOf("string");
    }
  });
});

// ---------------------------------------------------------------------------
// pluresLM_trap_context_fingerprint (re-exported from index.ts)
// ---------------------------------------------------------------------------

describe("pluresLM_trap_context_fingerprint", () => {
  it("delegates to contextFingerprint and returns a hex string", () => {
    const fp = pluresLM_trap_context_fingerprint(["svc:api", "env:prod"]);
    expect(fp).toMatch(/^[0-9a-f]+$/);
    expect(fp).toBe(contextFingerprint(["svc:api", "env:prod"]));
  });

  it("is order-independent", () => {
    expect(pluresLM_trap_context_fingerprint(["a", "b"])).toBe(
      pluresLM_trap_context_fingerprint(["b", "a"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Type import guard (compile-time check that MemoryEntry is accessible)
// ---------------------------------------------------------------------------
import type { MemoryEntry } from "../../src/types.js";
