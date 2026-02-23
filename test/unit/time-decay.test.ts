import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDB } from "../../src/memory-db.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec } from "../helpers/embeddings.js";

describe("time decay", () => {
  let db: MemoryDB;
  let cleanup: () => void;

  beforeEach(() => {
    // 7-day half-life: after 14 days, score is multiplied by 0.25
    ({ db, cleanup } = makeTestDB(7));
  });

  afterEach(() => {
    cleanup();
  });

  it("fresh memory has full cosine score (no decay)", async () => {
    const r = await db.store("Project deadline", makeVec(0), { category: "task", useSemanticDedup: false });

    const results = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    expect(results.length).toBe(1);
    // Score should be close to 1.0 (cos=1, decay=1, importance=1, priority normal=1)
    expect(results[0].score).toBeCloseTo(1.0, 1);
    expect(results[0].entry.id).toBe(r.entry.id);
  });

  it("old memory has lower score than fresh memory", async () => {
    const r = await db.store("Project deadline", makeVec(0), { category: "task", useSemanticDedup: false });

    const freshResults = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    const freshScore = freshResults[0].score;

    // Simulate 14 days old (2 half-lives with 7-day half-life → 0.25× multiplier)
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    db.updateLastAccessedAt(r.entry.id, fourteenDaysAgo);

    const oldResults = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    const oldScore = oldResults[0].score;

    expect(oldScore).toBeLessThan(freshScore * 0.3);
  });

  it("score after 14 days is approximately 0.25× the fresh score", async () => {
    const r = await db.store("Project deadline", makeVec(0), { category: "task", useSemanticDedup: false });

    const freshResults = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    const freshScore = freshResults[0].score;

    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    db.updateLastAccessedAt(r.entry.id, fourteenDaysAgo);

    const oldResults = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    const oldScore = oldResults[0].score;

    // 2 half-lives → 2^(-2) = 0.25 × fresh
    expect(oldScore).toBeGreaterThan(freshScore * 0.15);
    expect(oldScore).toBeLessThan(freshScore * 0.35);
  });

  it("permanent tag exempts memory from decay", async () => {
    const r = await db.store("Core architecture", makeVec(0), {
      tags: ["permanent"],
      category: "principle",
      useSemanticDedup: false,
    });

    const freshResults = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    const freshScore = freshResults[0].score;

    // Simulate 30 days old (would be ~0.063× without permanent tag)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.updateLastAccessedAt(r.entry.id, thirtyDaysAgo);

    const oldResults = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    const oldScore = oldResults[0].score;

    // Permanent memory should not decay
    expect(oldScore).toBeCloseTo(freshScore, 1);
  });

  it("half-life=0 disables decay entirely", async () => {
    let noDecayDb: MemoryDB;
    let noDecayCleanup: () => void;
    ({ db: noDecayDb, cleanup: noDecayCleanup } = makeTestDB(0));

    try {
      const r = await noDecayDb.store("Memory", makeVec(0), { category: "tech", useSemanticDedup: false });

      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      noDecayDb.updateLastAccessedAt(r.entry.id, fourteenDaysAgo);

      const results = await noDecayDb.vectorSearch(makeVec(0), 1, 0.0, false);
      expect(results.length).toBe(1);
      expect(results[0].score).toBeCloseTo(1.0, 1);
    } finally {
      noDecayCleanup();
    }
  });
});
