import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluresDBBackend } from "../../src/pluresdb-backend.js";
import { makeTestDB } from "../helpers/db.js";
import { makeVec, makeNearVec } from "../helpers/embeddings.js";

describe("full lifecycle", () => {
  let db: PluresDBBackend;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
  });

  afterEach(() => {
    cleanup();
  });

  it("store → search → recall end-to-end", async () => {
    // Store a set of memories across different "topics"
    await db.store("TypeScript adds static types to JavaScript", makeVec(0), {
      source: "agent",
      tags: ["tech:typescript"],
      category: "preference",
      dedupeThreshold: 1.1,
    });
    await db.store("PluresDB is a local-first graph database", makeVec(1), {
      source: "agent",
      tags: ["tech:pluresdb"],
      category: "project-context",
      dedupeThreshold: 1.1,
    });
    await db.store("The weather in Seattle is rainy", makeVec(2), {
      source: "agent",
      tags: ["location:seattle"],
      category: "conversation",
      dedupeThreshold: 1.1,
    });

    expect(await db.count()).toBe(3);

    // Recall the TypeScript memory
    const techResults = await db.vectorSearch(makeVec(0), 3, 0.5);
    expect(techResults[0].entry.content).toBe("TypeScript adds static types to JavaScript");
    expect(techResults[0].entry.tags).toContain("tech:typescript");
    expect(techResults[0].entry.source).toBe("agent");

    // Recall the PluresDB memory
    const dbResults = await db.vectorSearch(makeVec(1), 3, 0.5);
    expect(dbResults[0].entry.content).toBe("PluresDB is a local-first graph database");

    // Stats reflect reality
    const stats = await db.stats();
    expect(stats.totalMemories).toBe(3);
    expect(stats.categories).toMatchObject({
      preference: 1,
      "project-context": 1,
      conversation: 1,
    });
  });

  it("profile: store and retrieve user profile", async () => {
    expect(await db.getProfile()).toBeNull();

    await db.setProfile({
      summary: "User prefers TypeScript, works on PluresDB",
      facts: ["Prefers TypeScript", "Uses dark mode"],
      updated_at: Date.now(),
      capture_count: 5,
    });

    const profile = await db.getProfile();
    expect(profile).not.toBeNull();
    expect(profile!.facts).toHaveLength(2);
    expect(profile!.summary).toContain("TypeScript");
    expect(profile!.capture_count).toBe(5);
  });

  it("capture counter increments monotonically", async () => {
    const c1 = await db.incrementCaptureCount();
    const c2 = await db.incrementCaptureCount();
    const c3 = await db.incrementCaptureCount();
    expect(c2).toBe(c1 + 1);
    expect(c3).toBe(c2 + 1);
  });

  it("delete removes memory from search results", async () => {
    const r = await db.store("Memory to delete", makeVec(0), {
      category: "tech",
      dedupeThreshold: 1.1,
    });

    expect(await db.count()).toBe(1);

    await db.delete(r.entry.id);

    expect(await db.count()).toBe(0);
    const results = await db.vectorSearch(makeVec(0), 5, 0.0);
    expect(results).toHaveLength(0);
  });

  it("deleteBySource removes all memories from that source", async () => {
    await db.store("Memory 1", makeVec(0), { source: "source-a", category: "tech", dedupeThreshold: 1.1 });
    await db.store("Memory 2", makeVec(1), { source: "source-a", category: "tech", dedupeThreshold: 1.1 });
    await db.store("Memory 3", makeVec(2), { source: "source-b", category: "tech", dedupeThreshold: 1.1 });

    const removed = await db.deleteBySource("source-a");
    expect(removed).toBe(2);
    expect(await db.count()).toBe(1);
  });

  it("graph edge persists in full store-edge-query cycle", async () => {
    const r1 = await db.store("TypeScript", makeVec(0), { category: "tech", dedupeThreshold: 1.1 });
    const r2 = await db.store("JavaScript", makeVec(1), { category: "tech", dedupeThreshold: 1.1 });

    await db.addEdge(r1.entry.id, r2.entry.id, "supersedes");

    const related = await db.getRelated(r1.entry.id, "supersedes");
    expect(related).toHaveLength(1);
    expect(related[0].content).toBe("JavaScript");

    const stats = await db.stats();
    expect(stats.edgeCount).toBe(1);
  });

  it("agent stores → failure → fix → next failure recalls fix", async () => {
    // Simulate CI failure stored with high importance
    const failureVec = makeVec(0);
    const rFail = await db.store("CI failure: missing OPENAI_API_KEY in test env", failureVec, {
      source: "ci",
      tags: ["ci:failure", "env:openai"],
      category: "error-fix",
      importanceScore: 2.0,
      dedupeThreshold: 1.1,
    });

    // Simulate fix stored linked to failure
    const fixVec = makeNearVec(0, 0.1);
    const rFix = await db.store("Fix: add OPENAI_API_KEY to CI secrets", fixVec, {
      source: "ci",
      tags: ["ci:fix", "env:openai"],
      category: "error-fix",
      dedupeThreshold: 1.1,
    });

    await db.addEdge(rFail.entry.id, rFix.entry.id, "fix-for");

    // Next time a similar failure occurs, recall should surface the fix
    const recallResults = await db.vectorSearch(failureVec, 3, 0.5);
    expect(recallResults.length).toBeGreaterThan(0);
    expect(recallResults.some(r => r.entry.tags.includes("ci:fix"))).toBe(true);
  });

  it("isOpen returns true when DB is open", async () => {
    expect(await db.isOpen()).toBe(true);
  });

  it("isOpen returns false after close", async () => {
    await db.close();
    expect(await db.isOpen()).toBe(false);
  });
});
