/**
 * Unit tests for PluresDBBackend graph operation methods:
 *   findRelated, autoLink, getMemoryInsights
 *
 * PluresDBBackend requires native bindings to initialise normally.
 * These tests bypass initialisation by injecting a mock NAPI handle
 * directly so the computation logic can be exercised without the native
 * binary being present.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";

const MEM = "memory:";
const EDGE = "edge:";

// ---------------------------------------------------------------------------
// Minimal in-memory stub that satisfies PluresDatabaseNAPI
// ---------------------------------------------------------------------------

type NodeEntry = { id: string; data: Record<string, unknown> };

function makeMockNapiDb(store: Map<string, Record<string, unknown>>) {
  return {
    list: (): NodeEntry[] =>
      Array.from(store.entries()).map(([id, data]) => ({ id, data })),
    get: (id: string) => store.get(id) ?? null,
    put: (id: string, data: Record<string, unknown>) => {
      store.set(id, data);
      return id;
    },
    putWithEmbedding: (id: string, data: Record<string, unknown>) => {
      store.set(id, data);
      return id;
    },
    delete: (id: string) => { store.delete(id); },
    vectorSearch: () => [],
    search: () => [],
    stats: () => ({}),
    getActorId: () => "test",
    // execDsl throws by default so tests exercise the fallback path
    execDsl: (_query: string): never => { throw new Error("DSL not available in test stub"); },
    execIr: (_steps: unknown[]): never => { throw new Error("IR not available in test stub"); },
  };
}

function makeMockBackend() {
  const store = new Map<string, Record<string, unknown>>();
  const mockNapiDb = makeMockNapiDb(store);

  const backend = new PluresDBBackend("/tmp/plures-test-stub", 8);
  // Inject stub bypassing native-binding initialisation
  (backend as any).db = mockNapiDb;
  (backend as any).closed = false;
  (backend as any).initPromise = Promise.resolve();

  let edgeSeq = 0;

  const addMemory = (id: string, content: string, category = "other") => {
    store.set(MEM + id, {
      id, content, category,
      tags: [], vector: [], created_at: Date.now(),
      source: "", importance_score: 1.0, priority: "normal",
    });
  };

  const addEdge = (fromId: string, toId: string, relation = "related") => {
    const edgeId = `e${++edgeSeq}`;
    store.set(EDGE + edgeId, { id: edgeId, from_id: fromId, to_id: toId, relation, created_at: Date.now() });
  };

  return { backend, store, mockNapiDb, addMemory, addEdge };
}

// ---------------------------------------------------------------------------
// findRelated
// ---------------------------------------------------------------------------

describe("PluresDBBackend.findRelated", () => {
  it("falls back to edge traversal when DSL is unavailable", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "Memory A", "tech");
    addMemory("b", "Memory B", "tech");
    addEdge("a", "b", "related");

    const related = await backend.findRelated("a");
    expect(related.length).toBe(1);
    expect(related[0].content).toBe("Memory B");
  });

  it("returns memories linked in both directions", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "Memory A");
    addMemory("b", "Memory B");
    addEdge("b", "a", "related"); // edge points TO a

    const related = await backend.findRelated("a");
    expect(related.some((m) => m.content === "Memory B")).toBe(true);
  });

  it("returns empty array when no edges exist", async () => {
    const { backend, addMemory } = makeMockBackend();
    addMemory("a", "Isolated memory");

    const related = await backend.findRelated("a");
    expect(related).toEqual([]);
  });

  it("filters by linkTypes in fallback path", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "Memory A");
    addMemory("b", "Memory B");
    addMemory("c", "Memory C");
    addEdge("a", "b", "related");
    addEdge("a", "c", "context");

    const related = await backend.findRelated("a", { linkTypes: ["related"] });
    expect(related.length).toBe(1);
    expect(related[0].content).toBe("Memory B");
  });

  it("rejects memoryId containing injection characters", async () => {
    const { backend } = makeMockBackend();
    await expect(backend.findRelated('bad"id')).rejects.toThrow("Invalid memory ID");
    await expect(backend.findRelated("bad'id")).rejects.toThrow("Invalid memory ID");
    await expect(backend.findRelated("")).rejects.toThrow("Invalid memory ID");
  });

  it("uses DSL result when DSL succeeds", async () => {
    const { backend, addMemory, mockNapiDb } = makeMockBackend();
    addMemory("a", "Memory A");
    addMemory("b", "Memory B");

    // Override execDsl to return a successful result
    mockNapiDb.execDsl = (_query: string) => ({
      nodes: [{ id: MEM + "b", data: { id: "b", content: "Memory B via DSL", category: "tech", tags: [], vector: [], created_at: 0, source: "", importance_score: 1.0, priority: "normal" } }],
    });

    const related = await backend.findRelated("a", { depth: 1 });
    expect(related.length).toBe(1);
    expect(related[0].content).toBe("Memory B via DSL");
  });
});

// ---------------------------------------------------------------------------
// autoLink
// ---------------------------------------------------------------------------

describe("PluresDBBackend.autoLink", () => {
  it("returns linksCreated=0 when DSL is unavailable", async () => {
    const { backend } = makeMockBackend();
    const result = await backend.autoLink();
    expect(result.linksCreated).toBe(0);
  });

  it("returns linksCreated from mutated count when DSL succeeds", async () => {
    const { backend, mockNapiDb } = makeMockBackend();
    mockNapiDb.execDsl = (_query: string) => ({ mutated: 5 });

    const result = await backend.autoLink();
    expect(result.linksCreated).toBe(5);
  });

  it("returns linksCreated=0 when DSL returns no mutated field", async () => {
    const { backend, mockNapiDb } = makeMockBackend();
    mockNapiDb.execDsl = (_query: string) => ({});

    const result = await backend.autoLink();
    expect(result.linksCreated).toBe(0);
  });

  it("targets specific memory when memoryId is provided and DSL fails", async () => {
    const { backend } = makeMockBackend();
    // DSL unavailable — should gracefully return 0 links
    const result = await backend.autoLink({ memoryId: "abc-123" });
    expect(result.linksCreated).toBe(0);
  });

  it("targets specific memory when DSL succeeds", async () => {
    const { backend, mockNapiDb } = makeMockBackend();
    let capturedQuery = "";
    mockNapiDb.execDsl = (query: string) => { capturedQuery = query; return { mutated: 3 }; };

    await backend.autoLink({ memoryId: "my-uuid" });
    expect(capturedQuery).toContain("my-uuid");
    expect(capturedQuery).toContain("auto_link");
  });
});

// ---------------------------------------------------------------------------
// getMemoryInsights
// ---------------------------------------------------------------------------

describe("PluresDBBackend.getMemoryInsights", () => {
  it("returns empty insights for an empty database", async () => {
    const { backend } = makeMockBackend();
    const insights = await backend.getMemoryInsights();

    expect(insights.totalMemories).toBe(0);
    expect(insights.totalEdges).toBe(0);
    expect(insights.isolatedMemories).toBe(0);
    expect(insights.connectedMemories).toBe(0);
    expect(insights.clusters).toEqual([]);
    expect(insights.topCategories).toEqual([]);
  });

  it("counts isolated and connected memories correctly", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "Memory A");
    addMemory("b", "Memory B");
    addMemory("c", "Isolated C");
    addEdge("a", "b");

    const insights = await backend.getMemoryInsights();
    expect(insights.totalMemories).toBe(3);
    expect(insights.totalEdges).toBe(1);
    expect(insights.connectedMemories).toBe(2);
    expect(insights.isolatedMemories).toBe(1);
  });

  it("detects a connected cluster correctly", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "A");
    addMemory("b", "B");
    addMemory("c", "C");
    addEdge("a", "b");
    addEdge("b", "c");

    const insights = await backend.getMemoryInsights();
    expect(insights.clusters.length).toBe(1);
    expect(insights.clusters[0].size).toBe(3);
  });

  it("treats two-node pairs as separate clusters", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "A"); addMemory("b", "B");
    addMemory("c", "C"); addMemory("d", "D");
    addEdge("a", "b");
    addEdge("c", "d");

    const insights = await backend.getMemoryInsights();
    expect(insights.clusters.length).toBe(2);
  });

  it("computes top categories in descending frequency order", async () => {
    const { backend, addMemory } = makeMockBackend();
    addMemory("a", "A", "decision");
    addMemory("b", "B", "decision");
    addMemory("c", "C", "preference");

    const insights = await backend.getMemoryInsights();
    expect(insights.topCategories[0].category).toBe("decision");
    expect(insights.topCategories[0].count).toBe(2);
    expect(insights.topCategories[1].category).toBe("preference");
    expect(insights.topCategories[1].count).toBe(1);
  });

  it("passes the timespan label through to the result", async () => {
    const { backend } = makeMockBackend();
    const insights = await backend.getMemoryInsights("7d");
    expect(insights.timespan).toBe("7d");
  });

  it("includes category information in cluster metadata", async () => {
    const { backend, addMemory, addEdge } = makeMockBackend();
    addMemory("a", "A", "decision");
    addMemory("b", "B", "project");
    addEdge("a", "b");

    const insights = await backend.getMemoryInsights();
    expect(insights.clusters[0].categories).toContain("decision");
    expect(insights.clusters[0].categories).toContain("project");
  });
});
