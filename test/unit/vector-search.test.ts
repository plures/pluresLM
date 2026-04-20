import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";

describe("vector search", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("returns results above minScore threshold", async () => {
    await db.store("TypeScript", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    await db.store("Weather", makeVec(1), { category: "weather", dedupeThreshold: 1.1 });

    // Query aligned with tech vec (makeVec(0)) → weather vec (makeVec(1)) scores 0, should be excluded
    const results = await db.vectorSearch(makeVec(0), 5, 0.5);
    expect(results.length).toBe(1);
    expect(results[0].entry.category).toBe("tech");
  });

  it("returns empty array when no results exceed minScore", async () => {
    await db.store("TypeScript", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });

    const results = await db.vectorSearch(makeVec(1), 5, 0.5);
    expect(results.length).toBe(0);
  });

  it("returns results in descending score order", async () => {
    // makeVec(0) has cos=1 with query, makeNearVec(0,0.5) has cos≈0.894
    await db.store("Exact match", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    await db.store("Close match", makeNearVec(0, 0.5), { category: "tech", dedupeThreshold: 1.1 });

    const results = await db.vectorSearch(makeVec(0), 5, 0.0);
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await db.store(`Memory ${i}`, makeNearVec(0, i * 0.05 + 0.01), { category: "test", dedupeThreshold: 1.1 });
    }

    const results = await db.vectorSearch(makeVec(0), 2, 0.0);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("boosted search applies category multiplier", async () => {
    // Use makeNearVec so baseline score < 1.0; after boost it becomes > baseline
    await db.store("Work item", makeNearVec(0, 0.5), { category: "work-in-progress", dedupeThreshold: 1.1 });
    await db.store("Other", makeNearVec(0, 0.5), { category: "tech", dedupeThreshold: 1.1 });

    const normal = await db.vectorSearch(makeVec(0), 5, 0.0);
    const baseScore = normal.find(r => r.entry.category === "work-in-progress")!.score;

    const boosted = await db.vectorSearchBoosted(makeVec(0), 5, 0.0, { "work-in-progress": 1.5 });
    const boostedScore = boosted.find(r => r.entry.category === "work-in-progress")!.score;

    expect(boostedScore).toBeGreaterThan(baseScore);
  });

  it("maxPerCategory caps results from a single dominant category", async () => {
    // Store 8 project-context and 4 decision memories, all near makeVec(0)
    // project-context has slightly higher scores so it dominates without cap
    for (let i = 0; i < 8; i++) {
      await db.store(`project ctx ${i}`, makeNearVec(0, 0.01 * (i + 1)), { category: "project-context", dedupeThreshold: 1.1 });
    }
    for (let i = 0; i < 4; i++) {
      await db.store(`decision ${i}`, makeNearVec(0, 0.01 * (i + 9)), { category: "decision", dedupeThreshold: 1.1 });
    }

    // Without diversity cap: project-context dominates the top 5 (highest scores)
    const noCap = await db.vectorSearchBoosted(makeVec(0), 5, 0.0);
    const noCapPc = noCap.filter(r => r.entry.category === "project-context").length;
    expect(noCapPc).toBe(5); // All slots taken by dominant category

    // With maxPerCategory=3: ensures decision memories surface
    const capped = await db.vectorSearchBoosted(makeVec(0), 5, 0.0, {}, undefined, 3);
    const catCounts = new Map<string, number>();
    for (const r of capped) catCounts.set(r.entry.category, (catCounts.get(r.entry.category) ?? 0) + 1);

    expect(catCounts.get("project-context") ?? 0).toBeLessThanOrEqual(3);
    expect(catCounts.get("decision") ?? 0).toBeGreaterThanOrEqual(2);
    expect(capped.length).toBe(5);
  });

  it("maxPerCategory back-fills from deferred results when diversity pool exhausted", async () => {
    // Only one category available — cap should still return all results
    for (let i = 0; i < 4; i++) {
      await db.store(`only cat ${i}`, makeNearVec(0, 0.01 * (i + 1)), { category: "project-context", dedupeThreshold: 1.1 });
    }

    const results = await db.vectorSearchBoosted(makeVec(0), 4, 0.0, {}, undefined, 2);
    expect(results.length).toBe(4);
    // All from same category since there's nothing else
    expect(results.every(r => r.entry.category === "project-context")).toBe(true);
  });

  it("without maxPerCategory, no diversity cap is applied", async () => {
    for (let i = 0; i < 5; i++) {
      await db.store(`dominant ${i}`, makeNearVec(0, 0.01 * (i + 1)), { category: "project-context", dedupeThreshold: 1.1 });
    }
    await db.store("other", makeNearVec(0, 0.5), { category: "decision", dedupeThreshold: 1.1 });

    const results = await db.vectorSearchBoosted(makeVec(0), 5, 0.0);
    const pcCount = results.filter(r => r.entry.category === "project-context").length;
    // Without cap, project-context can take all high-score slots
    expect(pcCount).toBeGreaterThanOrEqual(4);
  });
});
