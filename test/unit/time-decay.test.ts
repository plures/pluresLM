/**
 * Score scaling tests for PluresDBBackend.
 *
 * PluresDB does not implement time-decay or last_accessed_at tracking;
 * the score returned by vectorSearch is: cosine_similarity × importance_score.
 * These tests verify that scoring behaviour instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";

describe("score scaling (PluresDB)", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("fresh memory has full cosine score (no decay)", async () => {
    const r = await db.store("Project deadline", makeVec(0), { category: "task", dedupeThreshold: 1.1 });

    const results = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(results.length).toBe(1);
    // Score should be close to 1.0 (cos=1, importance=1)
    expect(results[0].score).toBeCloseTo(1.0, 1);
    expect(results[0].entry.id).toBe(r.entry.id);
  });

  it("importance_score multiplies the cosine score", async () => {
    const r = await db.store("Important item", makeVec(0), {
      category: "task",
      dedupeThreshold: 1.1,
      importanceScore: 2.0,
    });

    const results = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(results.length).toBe(1);
    expect(results[0].score).toBeCloseTo(2.0, 1);
    expect(results[0].entry.importance_score).toBe(2.0);
    expect(results[0].entry.id).toBe(r.entry.id);
  });

  it("higher-importance memory outranks lower-importance memory", async () => {
    await db.store("Low importance", makeNearVec(0, 0.5), {
      category: "task",
      dedupeThreshold: 1.1,
      importanceScore: 0.5,
    });
    await db.store("High importance", makeVec(0), {
      category: "task",
      dedupeThreshold: 1.1,
      importanceScore: 3.0,
    });

    const results = await db.vectorSearch(makeVec(0), 5, 0.0);
    expect(results[0].entry.content).toBe("High importance");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("setImportanceScore updates score for subsequent searches", async () => {
    const r = await db.store("Memory", makeVec(0), { category: "task", dedupeThreshold: 1.1 });

    const before = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(before[0].score).toBeCloseTo(1.0, 1);

    await db.setImportanceScore(r.entry.id, 5.0);

    const after = await db.vectorSearch(makeVec(0), 1, 0.0);
    expect(after[0].score).toBeCloseTo(5.0, 1);
  });
});
