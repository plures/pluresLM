import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec } from "../helpers/embeddings.js";

describe("graph edges", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("addEdge links two memories", async () => {
    const rA = await db.store("TypeScript features", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("JavaScript history", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(rA.entry.id, rB.entry.id, "related");

    const related = await db.getRelated(rA.entry.id, "related");
    expect(related.length).toBe(1);
    expect(related[0].id).toBe(rB.entry.id);
    expect(related[0].content).toBe("JavaScript history");
  });

  it("getRelated returns memories from both directions of an edge", async () => {
    const rA = await db.store("TypeScript features", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("JavaScript history", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(rA.entry.id, rB.entry.id, "related");

    const relatedFromA = await db.getRelated(rA.entry.id, "related");
    const relatedFromB = await db.getRelated(rB.entry.id, "related");

    expect(relatedFromA.some(m => m.id === rB.entry.id)).toBe(true);
    expect(relatedFromB.some(m => m.id === rA.entry.id)).toBe(true);
  });

  it("getRelated without relation filter returns all related memories", async () => {
    const rA = await db.store("A", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("B", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });
    const rC = await db.store("C", makeVec(2), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(rA.entry.id, rB.entry.id, "related");
    await db.addEdge(rA.entry.id, rC.entry.id, "context");

    const related = await db.getRelated(rA.entry.id);
    expect(related.length).toBe(2);
  });

  it("getRelated with relation filter returns only matching relation type", async () => {
    const rA = await db.store("A", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("B", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });
    const rC = await db.store("C", makeVec(2), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(rA.entry.id, rB.entry.id, "related");
    await db.addEdge(rA.entry.id, rC.entry.id, "context");

    const relatedOnly = await db.getRelated(rA.entry.id, "related");
    expect(relatedOnly.length).toBe(1);
    expect(relatedOnly[0].id).toBe(rB.entry.id);
  });

  it("getRelated returns empty array for memory with no edges", async () => {
    const r = await db.store("Isolated memory", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const related = await db.getRelated(r.entry.id);
    expect(related).toEqual([]);
  });

  it("calling addEdge multiple times with the same nodes creates multiple edges", async () => {
    const rA = await db.store("A", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("B", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(rA.entry.id, rB.entry.id, "related");
    await db.addEdge(rA.entry.id, rB.entry.id, "related");

    // Each call uses a fresh UUID, so both edges are stored
    const stats = await db.stats();
    expect(stats.edgeCount).toBe(2);
  });

  it("stats.edgeCount reflects total edge count", async () => {
    const rA = await db.store("A", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("B", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });
    const rC = await db.store("C", makeVec(2), { category: "tech", dedupeThreshold: 1.1 });

    expect((await db.stats()).edgeCount).toBe(0);

    await db.addEdge(rA.entry.id, rB.entry.id, "related");
    expect((await db.stats()).edgeCount).toBe(1);

    await db.addEdge(rA.entry.id, rC.entry.id, "context");
    expect((await db.stats()).edgeCount).toBe(2);
  });

  it("deleting a memory removes its edges", async () => {
    const rA = await db.store("A", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const rB = await db.store("B", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(rA.entry.id, rB.entry.id, "related");
    expect((await db.stats()).edgeCount).toBe(1);

    await db.delete(rA.entry.id);
    expect((await db.stats()).edgeCount).toBe(0);
  });
});
