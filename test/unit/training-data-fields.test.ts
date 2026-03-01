/**
 * Tests for training data fields added to MemoryEntry and StoreContentOpts in src/types.ts.
 * Validates the new types, interfaces, backward compatibility, and runtime round-trip
 * persistence through PluresDBBackend.
 */

import { describe, expect, it } from "vitest";
import { makePluresTestDB } from "../helpers/db.js";
import type {
  MemoryEntry,
  MemoryOutcome,
  MemorySource,
  ValidatedBy,
  ConversationWindowEntry,
  ToolUsed,
  StoreContentOpts,
} from "../../src/types.js";

describe("MemorySource type", () => {
  it("accepts all valid MemorySource values", () => {
    const sources: MemorySource[] = [
      "conversation",
      "cron_output",
      "pr_merge",
      "web_search",
      "user_explicit",
      "agent",
    ];
    expect(sources).toHaveLength(6);
  });

  it("rejects invalid source value at compile time", () => {
    // @ts-expect-error — 'unknown_source' is not assignable to MemorySource
    const s: MemorySource = "unknown_source";
    void s;
  });
});

describe("MemoryOutcome type", () => {
  it("accepts all valid MemoryOutcome values", () => {
    const outcomes: MemoryOutcome[] = ["success", "failure", "partial", "unknown"];
    expect(outcomes).toHaveLength(4);
  });

  it("rejects invalid outcome value at compile time", () => {
    // @ts-expect-error — 'pending' is not assignable to MemoryOutcome
    const o: MemoryOutcome = "pending";
    void o;
  });
});

describe("ValidatedBy type", () => {
  it("accepts all valid ValidatedBy values", () => {
    const validators: ValidatedBy[] = ["human", "agent", "ci_result", "none"];
    expect(validators).toHaveLength(4);
  });

  it("rejects invalid validated_by value at compile time", () => {
    // @ts-expect-error — 'bot' is not assignable to ValidatedBy
    const v: ValidatedBy = "bot";
    void v;
  });
});

describe("ConversationWindowEntry interface", () => {
  it("accepts a valid entry", () => {
    const entry: ConversationWindowEntry = {
      role: "user",
      content: "What should I use here?",
      timestamp: 1700000000000,
    };
    expect(entry.role).toBe("user");
    expect(entry.content).toBe("What should I use here?");
    expect(entry.timestamp).toBe(1700000000000);
  });
});

describe("ToolUsed interface", () => {
  it("accepts a valid tool record", () => {
    const tool: ToolUsed = {
      tool_name: "grep",
      result_summary: "Found 3 matches in src/types.ts",
    };
    expect(tool.tool_name).toBe("grep");
    expect(tool.result_summary).toBe("Found 3 matches in src/types.ts");
  });
});

describe("MemoryEntry training data fields", () => {
  it("accepts a minimal entry (backward compatibility)", () => {
    const entry: MemoryEntry = {
      id: "mem-001",
      content: "Some content",
      embedding: [0.1, 0.2, 0.3],
      created_at: 1700000000000,
      source: "agent",
      tags: [],
      category: "conversation",
    };
    expect(entry.id).toBe("mem-001");
    expect(entry.rejected_approach).toBeUndefined();
    expect(entry.outcome).toBeUndefined();
    expect(entry.confidence).toBeUndefined();
  });

  it("accepts all training data fields", () => {
    const entry: MemoryEntry = {
      id: "mem-002",
      content: "Decision made",
      embedding: [0.1, 0.2],
      created_at: 1700000000000,
      source: "conversation",
      tags: ["decision"],
      category: "decision",
      rejected_approach: "Use SQLite",
      chosen_approach: "Use PluresDB",
      rejection_reason: "SQLite is not local-first",
      outcome: "success",
      outcome_evidence: "Build passed",
      outcome_timestamp: 1700000001000,
      confidence: 0.9,
      access_count: 5,
      reinforcement_count: 2,
      contradiction_count: 0,
      derived_from: ["mem-001"],
      validated_by: "human",
      conversation_window: [
        { role: "user", content: "Which DB?", timestamp: 1700000000000 },
        { role: "assistant", content: "PluresDB", timestamp: 1700000000500 },
      ],
      tools_used: [
        { tool_name: "search_code", result_summary: "Found 5 files" },
      ],
    };
    expect(entry.rejected_approach).toBe("Use SQLite");
    expect(entry.chosen_approach).toBe("Use PluresDB");
    expect(entry.rejection_reason).toBe("SQLite is not local-first");
    expect(entry.outcome).toBe("success");
    expect(entry.outcome_evidence).toBe("Build passed");
    expect(entry.outcome_timestamp).toBe(1700000001000);
    expect(entry.confidence).toBe(0.9);
    expect(entry.access_count).toBe(5);
    expect(entry.reinforcement_count).toBe(2);
    expect(entry.contradiction_count).toBe(0);
    expect(entry.derived_from).toEqual(["mem-001"]);
    expect(entry.validated_by).toBe("human");
    expect(entry.conversation_window).toHaveLength(2);
    expect(entry.tools_used).toHaveLength(1);
  });

  it("accepts nullable training data fields as null", () => {
    const entry: MemoryEntry = {
      id: "mem-003",
      content: "Nullable test",
      embedding: [],
      created_at: 0,
      source: "agent",
      tags: [],
      category: "other",
      rejected_approach: null,
      chosen_approach: null,
      rejection_reason: null,
      outcome_evidence: null,
      outcome_timestamp: null,
    };
    expect(entry.rejected_approach).toBeNull();
    expect(entry.chosen_approach).toBeNull();
    expect(entry.rejection_reason).toBeNull();
    expect(entry.outcome_evidence).toBeNull();
    expect(entry.outcome_timestamp).toBeNull();
  });

  it("source field still accepts arbitrary strings (backward compatibility)", () => {
    const entry: MemoryEntry = {
      id: "mem-004",
      content: "Legacy source",
      embedding: [],
      created_at: 0,
      source: "auto-capture:code",
      tags: [],
      category: "conversation",
    };
    expect(entry.source).toBe("auto-capture:code");
  });
});

describe("StoreContentOpts training data fields", () => {
  it("accepts opts with no training fields (backward compatibility)", () => {
    const opts: StoreContentOpts = {
      source: "test",
      category: "preference",
      tags: ["important"],
    };
    expect(opts.outcome).toBeUndefined();
    expect(opts.confidence).toBeUndefined();
  });

  it("accepts opts with all training data fields", () => {
    const opts: StoreContentOpts = {
      source: "user_explicit",
      outcome: "partial",
      confidence: 0.75,
      access_count: 0,
      reinforcement_count: 1,
      contradiction_count: 0,
      rejected_approach: "Approach A",
      chosen_approach: "Approach B",
      rejection_reason: "Too complex",
      outcome_evidence: null,
      outcome_timestamp: null,
      derived_from: ["mem-001", "mem-002"],
      validated_by: "ci_result",
      conversation_window: [{ role: "user", content: "help", timestamp: 1 }],
      tools_used: [{ tool_name: "grep", result_summary: "ok" }],
    };
    expect(opts.outcome).toBe("partial");
    expect(opts.confidence).toBe(0.75);
    expect(opts.validated_by).toBe("ci_result");
    expect(opts.derived_from).toEqual(["mem-001", "mem-002"]);
  });
});

describe("training data fields — runtime round-trip via PluresDBBackend", () => {
  it("store() persists and retrieves all training data fields", async () => {
    const { db, cleanup } = makePluresTestDB();
    try {
      const vec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
      const { entry } = await db.store("PluresDB is local-first", vec, {
        source: "conversation",
        category: "decision",
        dedupeThreshold: 1.1,
        rejected_approach: "SQLite",
        chosen_approach: "PluresDB",
        rejection_reason: "SQLite is not local-first",
        outcome: "success",
        outcome_evidence: "Build passed",
        outcome_timestamp: 1700000001000,
        confidence: 0.9,
        access_count: 0,
        reinforcement_count: 1,
        contradiction_count: 0,
        derived_from: ["mem-abc"],
        validated_by: "human",
        conversation_window: [
          { role: "user", content: "Which DB?", timestamp: 1700000000000 },
          { role: "assistant", content: "PluresDB", timestamp: 1700000000500 },
        ],
        tools_used: [{ tool_name: "search_code", result_summary: "5 files" }],
      });

      // Retrieve via vectorSearch
      const results = await db.vectorSearch(vec, 1, 0.0);
      expect(results).toHaveLength(1);
      const retrieved = results[0].entry;

      expect(retrieved.id).toBe(entry.id);
      expect(retrieved.rejected_approach).toBe("SQLite");
      expect(retrieved.chosen_approach).toBe("PluresDB");
      expect(retrieved.rejection_reason).toBe("SQLite is not local-first");
      expect(retrieved.outcome).toBe("success");
      expect(retrieved.outcome_evidence).toBe("Build passed");
      expect(retrieved.outcome_timestamp).toBe(1700000001000);
      expect(retrieved.confidence).toBe(0.9);
      expect(retrieved.access_count).toBe(0);
      expect(retrieved.reinforcement_count).toBe(1);
      expect(retrieved.contradiction_count).toBe(0);
      expect(retrieved.derived_from).toEqual(["mem-abc"]);
      expect(retrieved.validated_by).toBe("human");
      expect(retrieved.conversation_window).toHaveLength(2);
      expect(retrieved.conversation_window![0].role).toBe("user");
      expect(retrieved.tools_used).toHaveLength(1);
      expect(retrieved.tools_used![0].tool_name).toBe("search_code");
    } finally {
      cleanup();
    }
  });

  it("storeContent() persists and retrieves training data fields", async () => {
    const { db, cleanup } = makePluresTestDB();
    try {
      const { entry } = await db.storeContent("Use Rust for backend", {
        source: "pr_merge",
        category: "preference",
        outcome: "partial",
        confidence: 0.7,
        validated_by: "ci_result",
        derived_from: ["mem-xyz"],
        tools_used: [{ tool_name: "grep", result_summary: "ok" }],
      });

      // Retrieve via listMemories
      const memories = await db.listMemories();
      const found = memories.find(m => m.id === entry.id);
      expect(found).toBeDefined();
      expect(found!.outcome).toBe("partial");
      expect(found!.confidence).toBe(0.7);
      expect(found!.validated_by).toBe("ci_result");
      expect(found!.derived_from).toEqual(["mem-xyz"]);
      expect(found!.tools_used).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("entries without training data fields round-trip cleanly (backward compatibility)", async () => {
    const { db, cleanup } = makePluresTestDB();
    try {
      const vec = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
      const { entry } = await db.store("Legacy memory", vec, {
        source: "agent",
        category: "conversation",
        dedupeThreshold: 1.1,
      });

      const results = await db.vectorSearch(vec, 1, 0.0);
      expect(results).toHaveLength(1);
      const retrieved = results[0].entry;

      expect(retrieved.id).toBe(entry.id);
      expect(retrieved.outcome).toBeUndefined();
      expect(retrieved.confidence).toBeUndefined();
      expect(retrieved.validated_by).toBeUndefined();
      expect(retrieved.derived_from).toBeUndefined();
      expect(retrieved.conversation_window).toBeUndefined();
      expect(retrieved.tools_used).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("nullable training data fields persist as null and round-trip", async () => {
    const { db, cleanup } = makePluresTestDB();
    try {
      const vec = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9];
      const { entry } = await db.store("Nullable fields test", vec, {
        source: "agent",
        category: "decision",
        dedupeThreshold: 1.1,
        rejected_approach: null,
        outcome_evidence: null,
        outcome_timestamp: null,
      });

      const results = await db.vectorSearch(vec, 1, 0.0);
      expect(results).toHaveLength(1);
      const retrieved = results[0].entry;

      expect(retrieved.id).toBe(entry.id);
      expect(retrieved.rejected_approach).toBeNull();
      expect(retrieved.outcome_evidence).toBeNull();
      expect(retrieved.outcome_timestamp).toBeNull();
    } finally {
      cleanup();
    }
  });
});
