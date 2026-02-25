import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";

describe("dedup and merge", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  describe("simple dedup (threshold-based)", () => {
    it("first store is not a duplicate", async () => {
      const r = await db.store("TypeScript is great", makeVec(0), {
        category: "tech",
        dedupeThreshold: 1.1,
      });
      expect(r.isDuplicate).toBe(false);
      expect(r.entry.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("identical vector triggers dedup", async () => {
      await db.store("TypeScript is great", makeVec(0), {
        tags: ["ts"],
        category: "tech",
        dedupeThreshold: 0.95,
      });
      const r2 = await db.store("TypeScript is great", makeVec(0), {
        tags: ["ts"],
        category: "tech",
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(true);
      expect(await db.count()).toBe(1);
    });

    it("orthogonal vector does not trigger dedup", async () => {
      await db.store("TypeScript", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
      const r2 = await db.store("Weather", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });
      expect(r2.isDuplicate).toBe(false);
      expect(await db.count()).toBe(2);
    });

    it("similar vector above threshold triggers dedup", async () => {
      // makeNearVec(0, 0.1) has cos ≈ 0.995 with makeVec(0) — above 0.95 threshold
      await db.store("TypeScript", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
      const r2 = await db.store("TypeScript similar", makeNearVec(0, 0.1), {
        category: "tech",
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(true);
    });

    it("similar vector below threshold does not trigger dedup", async () => {
      // makeNearVec(0, 0.5) has cos ≈ 0.894 — below 0.95 threshold
      await db.store("TypeScript", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
      const r2 = await db.store("TypeScript variant", makeNearVec(0, 0.5), {
        category: "tech",
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(false);
      expect(await db.count()).toBe(2);
    });

    it("dedup merge preserves the higher importance score", async () => {
      await db.store("TypeScript", makeVec(0), {
        category: "tech",
        importanceScore: 1.5,
        dedupeThreshold: 0.95,
      });
      const r2 = await db.store("TypeScript duplicate", makeVec(0), {
        category: "tech",
        importanceScore: 2.0,
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(true);
      expect(r2.entry.importance_score).toBe(2.0);
    });

    it("dedup merge unions tags", async () => {
      await db.store("TypeScript", makeVec(0), {
        tags: ["ts", "types"],
        category: "tech",
        dedupeThreshold: 0.95,
      });
      const r2 = await db.store("TypeScript duplicate", makeVec(0), {
        tags: ["lang", "static"],
        category: "tech",
        dedupeThreshold: 0.95,
      });
      expect(r2.isDuplicate).toBe(true);
      expect(r2.entry.tags).toEqual(expect.arrayContaining(["ts", "types", "lang", "static"]));
    });
  });
});
