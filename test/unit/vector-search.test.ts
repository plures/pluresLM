import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDB } from "../../src/memory-db.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";

describe("vector search", () => {
  let db: MemoryDB;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("returns results above minScore threshold", async () => {
    await db.store("TypeScript", makeVec(0), { category: "tech", useSemanticDedup: false });
    await db.store("Weather", makeVec(1), { category: "weather", useSemanticDedup: false });

    // Query aligned with tech → weather vec (makeVec(1)) scores 0, should be excluded
    const results = await db.vectorSearch(makeVec(0), 5, 0.5, false);
    expect(results.length).toBe(1);
    expect(results[0].entry.category).toBe("tech");
  });

  it("returns empty array when no results exceed minScore", async () => {
    await db.store("TypeScript", makeVec(0), { category: "tech", useSemanticDedup: false });

    const results = await db.vectorSearch(makeVec(1), 5, 0.5, false);
    expect(results.length).toBe(0);
  });

  it("returns results in descending score order", async () => {
    // makeVec(0) has cos=1 with query, makeNearVec(0,0.5) has cos≈0.894
    await db.store("Exact match", makeVec(0), { category: "tech", useSemanticDedup: false });
    await db.store("Close match", makeNearVec(0, 0.5), { category: "tech", useSemanticDedup: false });

    const results = await db.vectorSearch(makeVec(0), 5, 0.0, false);
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await db.store(`Memory ${i}`, makeNearVec(0, i * 0.05 + 0.01), { category: "test", useSemanticDedup: false });
    }

    const results = await db.vectorSearch(makeVec(0), 2, 0.0, false);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("updates last_accessed_at when updateAccessTime is true", async () => {
    const r = await db.store("Memory", makeVec(0), { category: "tech", useSemanticDedup: false });
    expect(r.entry.last_accessed_at).toBeUndefined();

    const results = await db.vectorSearch(makeVec(0), 1, 0.0, true);
    expect(results[0].entry.last_accessed_at).toBeDefined();
  });

  it("does not update last_accessed_at when updateAccessTime is false", async () => {
    await db.store("Memory", makeVec(0), { category: "tech", useSemanticDedup: false });
    await db.vectorSearch(makeVec(0), 1, 0.0, false);

    const results2 = await db.vectorSearch(makeVec(0), 1, 0.0, false);
    // SQLite stores NULL for unset last_accessed_at; it comes back as null, not undefined
    expect(results2[0].entry.last_accessed_at).toBeNull();
  });

  it("boosted search applies category multiplier", async () => {
    // Use makeNearVec so baseline score < 1.0; after boost it becomes > baseline
    await db.store("Work item", makeNearVec(0, 0.5), { category: "work-in-progress", useSemanticDedup: false, dedupeThreshold: 1.1 });
    await db.store("Other", makeNearVec(0, 0.5), { category: "tech", useSemanticDedup: false, dedupeThreshold: 1.1 });

    const normal = await db.vectorSearch(makeVec(0), 5, 0.0, false);
    const baseScore = normal.find(r => r.entry.category === "work-in-progress")!.score;

    const boosted = await db.vectorSearchBoosted(makeVec(0), 5, 0.0, { "work-in-progress": 1.5 });
    const boostedScore = boosted.find(r => r.entry.category === "work-in-progress")!.score;

    expect(boostedScore).toBeGreaterThan(baseScore);
  });
});
