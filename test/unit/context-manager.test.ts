import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { ContextManager } from "../../src/context-manager.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec } from "../helpers/embeddings.js";

describe("ContextManager", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("getContextForPrompt returns vector-similar results, not word-overlap results", async () => {
    // Store two memories with distinct embedding directions
    // Memory A: aligned with query vec(0)
    await db.store("TypeScript generics and type inference", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });
    // Memory B: orthogonal — contains words from the prompt but wrong embedding
    await db.store("TypeScript generics and type inference duplicate text", makeVec(1), {
      category: "tech",
      dedupeThreshold: 1.1,
    });

    const manager = new ContextManager(db, {
      maxContextMemories: 5,
      priorityCategories: ["tech"],
      recencyBias: 0.3,
    });

    // embedFn returns vec(0): should match Memory A (cos=1) over Memory B (cos=0)
    const results = await manager.getContextForPrompt(
      "TypeScript generics and type inference",
      async () => makeVec(0),
    );

    expect(results.length).toBeGreaterThan(0);
    // The top result must be Memory A (aligned with query), not Memory B (orthogonal)
    expect(results[0].content).toBe("TypeScript generics and type inference");
  });

  it("getSessionStartContext returns priority category memories", async () => {
    await db.store("Decision: use React", makeVec(0), { category: "decision", dedupeThreshold: 1.1 });
    await db.store("General note", makeVec(1), { category: "general", dedupeThreshold: 1.1 });

    const manager = new ContextManager(db, {
      maxContextMemories: 10,
      priorityCategories: ["decision"],
      recencyBias: 0.7,
    });

    const results = await manager.getSessionStartContext();

    expect(results.length).toBe(1);
    expect(results[0].category).toBe("decision");
    expect(results[0].content).toBe("Decision: use React");
  });

  it("getContextForPrompt respects excludeCategories", async () => {
    await db.store("Work in progress item", makeVec(0), { category: "work-in-progress", dedupeThreshold: 1.1 });
    await db.store("Excluded project context", makeVec(0), { category: "project-context", dedupeThreshold: 1.1 });

    const manager = new ContextManager(db, {
      maxContextMemories: 10,
      priorityCategories: [],
      recencyBias: 0.3,
      excludeCategories: new Set(["project-context"]),
    });

    const results = await manager.getContextForPrompt("work", async () => makeVec(0));

    const categories = results.map((r) => r.category);
    expect(categories).not.toContain("project-context");
    expect(categories).toContain("work-in-progress");
  });

  it("getContextForPrompt respects maxContextMemories limit", async () => {
    for (let i = 0; i < 5; i++) {
      await db.store(`Memory ${i}`, makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    }

    const manager = new ContextManager(db, {
      maxContextMemories: 2,
      priorityCategories: ["tech"],
      recencyBias: 0.3,
    });

    const results = await manager.getContextForPrompt("query", async () => makeVec(0));

    expect(results.length).toBeLessThanOrEqual(2);
  });
});
