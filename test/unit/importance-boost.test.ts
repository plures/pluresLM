import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { makePluresTestDB } from "../helpers/db.js";
import { makeVec } from "../helpers/embeddings.js";

describe("importance score boosting", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makePluresTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("default importance_score is 1.0", async () => {
    const r = await db.store("Normal memory", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });
    expect(r.entry.importance_score).toBe(1.0);
  });

  it("importance_score of 2.0 doubles the recall score", async () => {
    const r = await db.store("Important memory", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });

    const baseline = await db.vectorSearch(makeVec(0), 1, 0.0);
    const baseScore = baseline[0].score;

    await db.setImportanceScore(r.entry.id, 2.0);

    const boosted = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(boosted[0].score).toBeCloseTo(baseScore * 2, 2);
    expect(boosted[0].entry.importance_score).toBe(2.0);
  });

  it("importance_score of 0.5 halves the recall score", async () => {
    const r = await db.store("Less important memory", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });

    const baseline = await db.vectorSearch(makeVec(0), 1, 0.0);
    const baseScore = baseline[0].score;

    await db.setImportanceScore(r.entry.id, 0.5);

    const reduced = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(reduced[0].score).toBeCloseTo(baseScore * 0.5, 2);
  });

  it("importanceScore option sets value at store time", async () => {
    const r = await db.store("Pre-boosted memory", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
      importanceScore: 3.0,
    });
    expect(r.entry.importance_score).toBe(3.0);

    const results = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(results[0].score).toBeCloseTo(3.0, 2);
  });

  it("importance_score is returned in search results", async () => {
    const r = await db.store("Memory", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    await db.setImportanceScore(r.entry.id, 1.5);

    const results = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(results[0].entry.importance_score).toBe(1.5);
  });

  it("rejects invalid importance_score values", async () => {
    const { db: tempDb, cleanup: tempCleanup } = makePluresTestDB();
    try {
      await expect(tempDb.setImportanceScore("fake-id", -1)).rejects.toThrow();
      await expect(tempDb.setImportanceScore("fake-id", 101)).rejects.toThrow();
      await expect(tempDb.setImportanceScore("fake-id", Infinity)).rejects.toThrow();
    } finally {
      tempCleanup();
    }
  });

  it("high-importance memory outranks lower-importance memory in search", async () => {
    const rA = await db.store("Topic A", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });
    const rB = await db.store("Topic B", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });

    await db.setImportanceScore(rA.entry.id, 2.0);
    await db.setImportanceScore(rB.entry.id, 0.5);

    const results = await db.vectorSearch(makeVec(0), 2, 0.0);
    expect(results).toHaveLength(2);
    expect(results[0].entry.id).toBe(rA.entry.id);
    expect(results[1].entry.id).toBe(rB.entry.id);
  });
});
