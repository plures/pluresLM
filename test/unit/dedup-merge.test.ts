import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDB } from "../../src/memory-db.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";

describe("dedup and merge", () => {
  let db: MemoryDB;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  describe("simple dedup (exact threshold)", () => {
    it("first store is not a duplicate", async () => {
      const r = await db.store("TypeScript is great", makeVec(0), {
        category: "tech",
        useSemanticDedup: false,
      });
      expect(r.isDuplicate).toBe(false);
      expect(r.entry.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("identical vector triggers dedup", async () => {
      await db.store("TypeScript is great", makeVec(0), {
        tags: ["ts"],
        category: "tech",
        useSemanticDedup: false,
      });
      const r2 = await db.store("TypeScript is great", makeVec(0), {
        tags: ["ts"],
        category: "tech",
        useSemanticDedup: false,
      });
      expect(r2.isDuplicate).toBe(true);
      expect(await db.count()).toBe(1);
    });

    it("orthogonal vector does not trigger dedup", async () => {
      await db.store("TypeScript", makeVec(0), { category: "tech", useSemanticDedup: false });
      const r2 = await db.store("Weather", makeVec(1), { category: "tech", useSemanticDedup: false });
      expect(r2.isDuplicate).toBe(false);
      expect(await db.count()).toBe(2);
    });

    it("similar vector above threshold triggers dedup", async () => {
      // makeNearVec(0, 0.1) has cos ≈ 0.995 with makeVec(0) — above 0.95 threshold
      await db.store("TypeScript", makeVec(0), { category: "tech", useSemanticDedup: false });
      const r2 = await db.store("TypeScript similar", makeNearVec(0, 0.1), {
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(true);
    });

    it("similar vector below threshold does not trigger dedup", async () => {
      // makeNearVec(0, 0.5) has cos ≈ 0.894 — below 0.95 threshold
      await db.store("TypeScript", makeVec(0), { category: "tech", useSemanticDedup: false });
      const r2 = await db.store("TypeScript variant", makeNearVec(0, 0.5), {
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(false);
      expect(await db.count()).toBe(2);
    });
  });

  describe("semantic dedup (cluster merge)", () => {
    it("two similar memories form a cluster on third insert", async () => {
      // noiseLevel=0.5 → cos≈0.894 (below simple dedup 0.95, above semantic 0.85)
      // Store two without semantic dedup
      await db.store("TypeScript type system", makeVec(0), {
        tags: ["ts"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript static typing", makeNearVec(0, 0.5), {
        tags: ["static"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      expect(await db.count()).toBe(2);

      // Third similar store with semantic dedup enabled — should trigger cluster merge
      const r3 = await db.store("TypeScript adds types to JS", makeNearVec(0, 0.45), {
        tags: ["js"],
        category: "tech",
        useSemanticDedup: true,
      });
      expect(r3.isDuplicate).toBe(true);
      expect(r3.merged).toBe(true);
      // clusterAndMerge updates the target memory in-place; the other
      // similar memory stays in the DB — use findDuplicates() to consolidate.
      expect(await db.count()).toBe(2);
    });

    it("merged entry has unioned tags", async () => {
      await db.store("TypeScript types", makeVec(0), {
        tags: ["ts", "types"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript static", makeNearVec(0, 0.5), {
        tags: ["static", "lang"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });

      const r3 = await db.store("TypeScript language", makeNearVec(0, 0.45), {
        tags: ["programming"],
        category: "tech",
        useSemanticDedup: true,
      });

      expect(r3.merged).toBe(true);
      const merged = r3.entry;
      // The merged entry should have combined tags from the cluster
      expect(merged.tags).toEqual(expect.arrayContaining(["ts", "types", "static", "lang"]));
    });

    it("merge_count increments on cluster merge", async () => {
      await db.store("TypeScript types", makeVec(0), {
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript static", makeNearVec(0, 0.5), {
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });

      const r3 = await db.store("TypeScript language", makeNearVec(0, 0.45), {
        category: "tech",
        useSemanticDedup: true,
      });

      expect(r3.merged).toBe(true);
      expect(r3.entry.merge_count).toBeGreaterThan(0);
    });
  });

  describe("findDuplicates", () => {
    it("dry run finds clusters without modifying DB", async () => {
      // cos ≈ 0.894 — above semantic 0.85, findDuplicates threshold
      await db.store("TypeScript typing", makeVec(0), {
        tags: ["ts"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript types", makeNearVec(0, 0.5), {
        tags: ["types"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });

      const countBefore = await db.count();
      const candidates = await db.findDuplicates(true);

      expect(candidates.length).toBeGreaterThan(0);
      expect(await db.count()).toBe(countBefore); // unchanged in dry run
    });

    it("actual run removes duplicate memories", async () => {
      await db.store("TypeScript typing", makeVec(0), {
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript types", makeNearVec(0, 0.5), {
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });

      const countBefore = await db.count();
      await db.findDuplicates(false);

      expect(await db.count()).toBeLessThan(countBefore);
    });

    it("merged result has unioned tags", async () => {
      await db.store("TypeScript typing", makeVec(0), {
        tags: ["ts", "lang"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript types", makeNearVec(0, 0.5), {
        tags: ["static", "types"],
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });

      const candidates = await db.findDuplicates(true);
      expect(candidates[0].mergedTags).toEqual(
        expect.arrayContaining(["ts", "lang", "static", "types"]),
      );
    });

    it("preserves source attribution from the target memory", async () => {
      await db.store("TypeScript typing", makeVec(0), {
        source: "agent-1",
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });
      await db.store("TypeScript types", makeNearVec(0, 0.5), {
        source: "agent-2",
        category: "tech",
        useSemanticDedup: false,
        dedupeThreshold: 1.1,
      });

      const candidates = await db.findDuplicates(true);
      expect(candidates.length).toBeGreaterThan(0);
      // The target ID should correspond to one of the stored memories
      expect(candidates[0].targetId).toBeDefined();
    });
  });
});
