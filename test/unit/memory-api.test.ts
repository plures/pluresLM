/**
 * Tests for the Pares Agens recall/capture API (src/memory-api.ts).
 *
 * Uses the in-memory PluresDBBackend stub so no native binary is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";
import type { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { MemoryAPI, detectCategory, isTrivial, injectContext } from "../../src/memory-api.js";
import { shouldCapture } from "../../src/capture-quality.js";

// ---------------------------------------------------------------------------
// Deterministic embedding stub: returns a basis vector keyed by first character
// so that different strings map to distinguishable directions.
// ---------------------------------------------------------------------------

function stubEmbed(text: string): Promise<number[]> {
  const code = (text.charCodeAt(0) ?? 0) % 8;
  return Promise.resolve(makeVec(code));
}

// ---------------------------------------------------------------------------

describe("isTrivial", () => {
  it("rejects greetings", () => {
    expect(isTrivial("hi")).toBe(true);
    expect(isTrivial("hello!")).toBe(true);
    expect(isTrivial("ok")).toBe(true);
  });

  it("rejects very short strings", () => {
    expect(isTrivial("yes")).toBe(true);
    expect(isTrivial("ok sure")).toBe(true);
  });

  it("rejects HEARTBEAT_OK and NO_REPLY", () => {
    expect(isTrivial("HEARTBEAT_OK")).toBe(true);
    expect(isTrivial("NO_REPLY")).toBe(true);
  });

  it("rejects slash-commands", () => {
    expect(isTrivial("/help me do something now")).toBe(true);
  });

  it("accepts substantive text", () => {
    expect(isTrivial("We decided to use Rust for the memory layer.")).toBe(false);
    expect(isTrivial("I prefer TypeScript over JavaScript for new projects.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("detectCategory", () => {
  it("detects preference", () => {
    expect(detectCategory("I prefer Rust over Go for systems work")).toBe("preference");
    expect(detectCategory("I like dark mode in all my editors")).toBe("preference");
    expect(detectCategory("My favorite framework is Next.js")).toBe("preference");
  });

  it("detects decision", () => {
    expect(detectCategory("We decided to use PostgreSQL for the main store")).toBe("decision");
    expect(detectCategory("going with Vite for the build tool")).toBe("decision");
    expect(detectCategory("decision: use sled as the embedded DB")).toBe("decision");
  });

  it("detects entity", () => {
    expect(detectCategory("Contact Alice, named Alice Johnson")).toBe("entity");
    expect(detectCategory("call +12025551234 for support")).toBe("entity");
  });

  it("detects explicit memory instruction", () => {
    expect(detectCategory("Remember this: always run tests before merging")).toBe("explicit");
    expect(detectCategory("Note: the DB path must be absolute")).toBe("explicit");
    expect(detectCategory("Important: do not commit secrets")).toBe("explicit");
  });

  it("falls back to conversation", () => {
    expect(detectCategory("The build took 45 seconds today")).toBe("conversation");
    expect(detectCategory("Here is the output from the linter run")).toBe("conversation");
  });
});

// ---------------------------------------------------------------------------

describe("shouldCapture", () => {
  it("rejects content below minContentLength", () => {
    expect(shouldCapture("short")).toBe(false);
    // Just below the 50-char default minimum
    expect(shouldCapture("a".repeat(49))).toBe(false);
    // Exactly at the minimum — should pass (no skip patterns match)
    expect(shouldCapture("a".repeat(50))).toBe(true);
  });

  it("rejects JSON tool output", () => {
    expect(shouldCapture('{"tool":"pluresLM_store","result":"ok","id":"123456"}')).toBe(false);
  });

  it("rejects memory echo patterns", () => {
    expect(shouldCapture("- [preference] [by: Alice Desktop] I like dark mode")).toBe(false);
  });

  it("rejects boilerplate openers", () => {
    expect(shouldCapture("I'll help you with that task!")).toBe(false);
  });

  it("accepts substantive content", () => {
    expect(shouldCapture("We decided to migrate from SQLite to PluresDB for CRDT support across devices.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("injectContext", () => {
  it("formats memories into markdown bullet lines", () => {
    const memories = [
      { category: "preference", content: "I prefer dark mode" },
      { category: "decision", content: "We use Rust", originator_name: "Alice" },
    ];
    const result = injectContext(memories, 10_000);
    expect(result).toContain("- [preference] I prefer dark mode");
    expect(result).toContain("- [decision] [by: Alice] We use Rust");
  });

  it("respects the budget and stops before exceeding it", () => {
    const memories = Array.from({ length: 100 }, (_, i) => ({
      category: "conversation",
      content: `memory entry number ${i} with some content to make it longer`,
    }));
    const budget = 200;
    const result = injectContext(memories, budget);
    expect(result.length).toBeLessThanOrEqual(budget);
  });

  it("includes status when present", () => {
    const memories = [{ category: "work-in-progress", content: "Refactoring auth module", status: "active" }];
    const result = injectContext(memories, 10_000);
    expect(result).toContain("[active]");
  });

  it("returns empty string when budget is too small for any entry", () => {
    const memories = [{ category: "conversation", content: "This is some content" }];
    const result = injectContext(memories, 5);
    expect(result).toBe("");
  });

  it("uses originator_id when originator_name is absent", () => {
    const memories = [
      { category: "decision", content: "Use sled", originator_id: "device-abc" },
    ];
    const result = injectContext(memories, 10_000);
    expect(result).toContain("[by: device-abc]");
  });
});

// ---------------------------------------------------------------------------

describe("MemoryAPI", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;
  let api: MemoryAPI;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    api = new MemoryAPI(db, stubEmbed);
  });

  afterEach(() => {
    cleanup();
  });

  describe("capture", () => {
    it("stores substantive content and returns an id", async () => {
      const id = await api.capture(
        "We decided to use Rust for all memory-layer crates in Pares Agens.",
      );
      expect(typeof id).toBe("string");
      expect(id).not.toBeNull();
    });

    it("uses provided category", async () => {
      const id = await api.capture(
        "We decided to use Rust for all memory-layer crates in Pares Agens.",
        "decision",
      );
      expect(id).not.toBeNull();
      const all = await db.listMemories();
      const stored = all.find((m) => m.id === id);
      expect(stored?.category).toBe("decision");
    });

    it("auto-detects category from content when omitted", async () => {
      const id = await api.capture("I prefer TypeScript over JavaScript for all new backend service code.");
      expect(id).not.toBeNull();
      const all = await db.listMemories();
      const stored = all.find((m) => m.id === id);
      expect(stored?.category).toBe("preference");
    });

    it("attaches tags to the stored memory", async () => {
      const id = await api.capture(
        "We decided to migrate the database layer to PluresDB for CRDT support.",
        "decision",
        ["migration", "database"],
      );
      expect(id).not.toBeNull();
      const all = await db.listMemories();
      const stored = all.find((m) => m.id === id);
      expect(stored?.tags).toContain("migration");
      expect(stored?.tags).toContain("database");
    });

    it("returns null for noise (quality gate rejection)", async () => {
      const id = await api.capture("ok");
      expect(id).toBeNull();
    });

    it("returns null for JSON tool output", async () => {
      const id = await api.capture('{"tool":"pluresLM_store","result":"stored","id":"xyz"}');
      expect(id).toBeNull();
    });

    it("returns null for memory echo pattern", async () => {
      const id = await api.capture("- [preference] [by: Alice Desktop] I like dark mode");
      expect(id).toBeNull();
    });
  });

  describe("recall", () => {
    it("returns stored memories via vector search", async () => {
      // stubEmbed keys on the first character code mod 8.
      // "async await…" starts with 'a' (97), so 97 % 8 = 1 → makeVec(1).
      // Store the memory with the same embedding direction so the query can find it.
      const embedding = makeVec(1);
      await db.store(
        "always use async/await in TypeScript for better readability",
        embedding,
        { category: "preference", tags: ["typescript"] },
      );

      // Query starts with 'a' → stubEmbed returns makeVec(1) → cosine sim = 1.0
      const results = await api.recall("async await typescript", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("async/await");
    });

    it("respects excludeCategories", async () => {
      // Use storeContent with explicit embeddings so the recall can find them
      const embedding = makeVec(0);
      await db.store("project-context memory content here for filtering", embedding, {
        category: "project-context",
      });
      await db.store("preference memory content here for filtering test", embedding, {
        category: "preference",
      });

      // Recall with same embedding direction — exclude project-context
      const results = await api.recall("project context preference", 10, ["project-context"]);
      const categories = results.map((r) => r.category);
      expect(categories).not.toContain("project-context");
    });

    it("returns empty array when no memories match", async () => {
      const results = await api.recall("completely unrelated query xyz", 5);
      expect(results).toEqual([]);
    });

    it("limits results to the specified count", async () => {
      const embedding = makeVec(0);
      // Store 5 memories all pointing the same direction
      for (let i = 0; i < 5; i++) {
        await db.store(`memory entry ${i} with enough content to pass quality checks`, embedding, {
          category: "conversation",
        });
      }
      const results = await api.recall("memory entry", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });
});
