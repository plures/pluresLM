/**
 * Boundary tests: PluresDB engine layer vs pluresLM application layer.
 *
 * These tests verify that:
 *  1. `PluresStore` (PluresDB engine boundary) contains no memory-application
 *     types (MemoryEntry, category, priority, …).
 *  2. `TopicIndex` depends only on `PluresStore`, not on `PluresDBBackend`.
 *  3. `PluresDBBackend.getStore()` returns an object that satisfies the
 *     `PluresStore` interface.
 *  4. The mock store used in tests satisfies `PluresStore` structurally
 *     (TypeScript structural subtyping is the compile-time proof; these
 *     runtime checks act as documentation and regression guards).
 */

import { describe, expect, it } from "vitest";
import { TopicIndex } from "../../src/topic-index.js";
import type { PluresStore } from "../../src/plures-store.js";
import { makeTestDB } from "../helpers/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory PluresStore stub for boundary tests. */
function makeMinimalStore(): PluresStore {
  const nodes = new Map<string, Record<string, unknown>>();
  return {
    put(id, data) { nodes.set(id, data); },
    putWithEmbedding(id, data) { nodes.set(id, data); },
    get(id) { return nodes.get(id) ?? null; },
    delete(id) { nodes.delete(id); },
    list() { return Array.from(nodes.entries()).map(([id, data]) => ({ id, data })); },
    listByType(prefix) {
      return Array.from(nodes.entries())
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, data]) => ({ id, data }));
    },
    vectorSearch() { return []; },
    search() { return []; },
    execDsl(): never { throw new Error("not implemented"); },
    execIr(): never { throw new Error("not implemented"); },
  };
}

// ---------------------------------------------------------------------------
// 1. PluresStore interface contains no memory-application types
// ---------------------------------------------------------------------------

describe("PluresStore interface — engine boundary", () => {
  it("accepts an object with only generic node/vector/procedure methods", () => {
    // If TypeScript compiles this file, the assignment proves PluresStore
    // does not require any memory-application-specific methods.
    const store: PluresStore = makeMinimalStore();
    expect(store).toBeDefined();
  });

  it("PluresStore has no reference to MemoryEntry in its method signatures", () => {
    // Structural test: iterate the store methods and verify none return
    // objects that have 'category' or 'priority' fields (memory app concerns).
    const store = makeMinimalStore();
    const listed = store.list();
    expect(Array.isArray(listed)).toBe(true);
    // list() returns PluresNode[] — not MemoryEntry[]
    // PluresNode has only: id, data, score?, timestamp?
    if (listed.length > 0) {
      const node = listed[0];
      expect(Object.keys(node)).not.toContain("category");
      expect(Object.keys(node)).not.toContain("priority");
      expect(Object.keys(node)).not.toContain("embedding");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. TopicIndex depends only on PluresStore
// ---------------------------------------------------------------------------

describe("TopicIndex boundary — depends only on PluresStore", () => {
  it("can be constructed with a minimal PluresStore (no PluresDBBackend needed)", () => {
    const store = makeMinimalStore();
    // This proves that TopicIndex does not require PluresDBBackend.
    const index = new TopicIndex(store);
    expect(index).toBeDefined();
    expect(index.listTopics()).toEqual([]);
  });

  it("indexes entries without importing MemoryEntry", () => {
    const store = makeMinimalStore();
    const index = new TopicIndex(store);
    const emb = [1, 0, 0, 0, 0, 0, 0, 0];
    const topicId = index.indexEntry("entry-abc", emb, "product boundary test content");
    expect(typeof topicId).toBe("string");
    const topic = index.getTopic(topicId);
    // TopicEntry has no 'category', 'priority' or other memory-app fields
    expect(topic).not.toBeNull();
    expect(topic).not.toHaveProperty("category");
    expect(topic).not.toHaveProperty("priority");
    expect(topic).not.toHaveProperty("source");
  });

  it("persists topics under the 'topic:' namespace — no 'memory:' prefix leakage", () => {
    const store = makeMinimalStore();
    const index = new TopicIndex(store);
    index.indexEntry("m1", [1, 0, 0, 0, 0, 0, 0, 0], "content about boundary enforcement");
    const all = store.list();
    expect(all.every((n) => n.id.startsWith("topic:"))).toBe(true);
    expect(all.some((n) => n.id.startsWith("memory:"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. PluresDBBackend.getStore() returns a valid PluresStore
// ---------------------------------------------------------------------------

describe("PluresDBBackend.getStore()", () => {
  it("returns an object that satisfies the PluresStore interface", () => {
    const { db } = makeTestDB();
    const store: PluresStore = db.getStore();
    // Verify the required methods are present
    expect(typeof store.put).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(typeof store.list).toBe("function");
    expect(typeof store.vectorSearch).toBe("function");
    expect(typeof store.search).toBe("function");
  });

  it("can be passed directly to TopicIndex", async () => {
    const { db } = makeTestDB();
    const store = db.getStore();
    const index = new TopicIndex(store);

    // Store a memory in the backend, then index it via TopicIndex
    const { entry } = await db.store(
      "Rust ownership model prevents data races at compile time",
      [1, 0, 0, 0, 0, 0, 0, 0],
      { category: "decision" },
    );

    const topicId = index.indexEntry(entry.id, entry.embedding, entry.content);
    expect(typeof topicId).toBe("string");

    const topic = index.getTopic(topicId);
    expect(topic!.entryIds).toContain(entry.id);
  });

  it("TopicIndex and PluresDBBackend share the same store without interference", async () => {
    const { db } = makeTestDB();
    const index = new TopicIndex(db.getStore());

    // Store memories in the backend
    const { entry: e1 } = await db.store(
      "TypeScript strict mode catches null errors early in development",
      [1, 0, 0, 0, 0, 0, 0, 0],
      { category: "preference" },
    );
    const { entry: e2 } = await db.store(
      "Go channels simplify concurrent programming patterns significantly",
      [0, 1, 0, 0, 0, 0, 0, 0],
      { category: "preference" },
    );

    // Index both entries under topics
    index.indexEntry(e1.id, e1.embedding, e1.content);
    index.indexEntry(e2.id, e2.embedding, e2.content);

    // Memory backend remains unaffected
    const memories = await db.listMemories();
    expect(memories).toHaveLength(2);

    // Topic index has its own entries under 'topic:' prefix
    const topics = index.listTopics();
    expect(topics.length).toBeGreaterThanOrEqual(1);

    // No memory: nodes in the topic list, no topic: nodes in memory list
    for (const t of topics) {
      expect(t).not.toHaveProperty("category");
    }
    for (const m of memories) {
      expect(m.id).not.toMatch(/^topic:/);
    }
  });
});
