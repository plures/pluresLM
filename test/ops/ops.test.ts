import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDB } from "../helpers/db.js";
import { makeVec } from "../helpers/embeddings.js";
import type { EmbeddingProvider } from "../../src/embeddings.js";
import { ErrorCapture, ERROR_PATTERN_CATEGORY } from "../../src/ops/error-capture.js";
import { RepoKnowledge, REPO_CONTEXT_CATEGORY } from "../../src/ops/repo-knowledge.js";
import { PreferenceTracker, PREFERENCE_CATEGORY } from "../../src/ops/preference-tracker.js";
import { DelegationHelper } from "../../src/ops/delegation-helper.js";
import type { MemoryDB } from "../../src/memory-db.js";

/**
 * Deterministic stub embedding provider.
 *
 * Returns makeVec(0) for every input — all stored embeddings are identical,
 * so cosine similarity is 1.0 for any query. This means category/tag
 * filtering in the ops modules drives all recall results, which is exactly
 * what we want to test here.
 */
class StubEmbeddings implements EmbeddingProvider {
  dimension = 8;
  async embed(_text: string): Promise<number[]> {
    return makeVec(0);
  }
}

describe("ErrorCapture", () => {
  let db: MemoryDB;
  let cleanup: () => void;
  let embeddings: StubEmbeddings;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    embeddings = new StubEmbeddings();
  });

  afterEach(() => {
    cleanup();
  });

  it("stores CI failure with correct category", async () => {
    const ec = new ErrorCapture(db, embeddings);
    const entry = await ec.captureError(
      "libclang not found on Windows",
      "Install LLVM and set LIBCLANG_PATH",
      { repository: "plures/pluresdb", ciSystem: "github-actions" },
    );
    expect(entry.category).toBe(ERROR_PATTERN_CATEGORY);
    expect(entry.content).toContain("libclang");
    expect(entry.content).toContain("LIBCLANG_PATH");
  });

  it("stores repository and CI system tags", async () => {
    const ec = new ErrorCapture(db, embeddings);
    const entry = await ec.captureError(
      "Missing env var OPENAI_KEY",
      "Add OPENAI_KEY to CI secrets",
      { repository: "plures/pluresLM", ciSystem: "github-actions", tags: ["env"] },
    );
    expect(entry.tags).toContain("repository:plures/pluresLM");
    expect(entry.tags).toContain("ci:github-actions");
    expect(entry.tags).toContain("env");
  });

  it("recalls similar past failure and surfaces fix", async () => {
    const ec = new ErrorCapture(db, embeddings);
    await ec.captureError(
      "libclang not found",
      "Set LIBCLANG_PATH",
      { repository: "plures/pluresdb" },
    );

    const fixes = await ec.recallFix("libclang missing during build");
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes[0].entry.category).toBe(ERROR_PATTERN_CATEGORY);
    expect(fixes[0].score).toBeGreaterThan(0);
  });

  it("recall returns [] when no EmbeddingProvider is given", async () => {
    const ec = new ErrorCapture(db, null);
    const entry = await ec.captureError("some error", "some fix", {});
    expect(entry.category).toBe(ERROR_PATTERN_CATEGORY);

    const fixes = await ec.recallFix("some error");
    expect(fixes).toEqual([]);
  });

  it("storeContent stores entry without embedding when provider is null", async () => {
    const ec = new ErrorCapture(db, null);
    const entry = await ec.captureError(
      "storeContent test error",
      "storeContent test fix",
      { repository: "plures/test", tags: ["no-embed"] },
    );
    expect(entry.category).toBe(ERROR_PATTERN_CATEGORY);
    expect(entry.content).toContain("storeContent test error");
    expect(entry.tags).toContain("repository:plures/test");
    expect(await db.count()).toBe(1);
  });
});

describe("RepoKnowledge", () => {
  let db: MemoryDB;
  let cleanup: () => void;
  let embeddings: StubEmbeddings;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    embeddings = new StubEmbeddings();
  });

  afterEach(() => {
    cleanup();
  });

  it("captures build system quirks with correct category", async () => {
    const rk = new RepoKnowledge(db, embeddings);
    const entry = await rk.capture(
      "plures/pluresdb",
      "Requires LLVM toolchain. Set LIBCLANG_PATH before cargo build.",
      { buildSystem: "cargo", tags: ["setup"] },
    );
    expect(entry.category).toBe(REPO_CONTEXT_CATEGORY);
    expect(entry.tags).toContain("repository:plures/pluresdb");
    expect(entry.tags).toContain("build:cargo");
    expect(entry.tags).toContain("setup");
  });

  it("recalls repo context when working on that repo", async () => {
    const rk = new RepoKnowledge(db, embeddings);
    await rk.capture(
      "plures/pluresdb",
      "Requires LLVM toolchain. Set LIBCLANG_PATH.",
      { buildSystem: "cargo" },
    );

    const results = await rk.recall("plures/pluresdb", "How do I build this repo?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.category).toBe(REPO_CONTEXT_CATEGORY);
    expect(results[0].entry.tags).toContain("repository:plures/pluresdb");
  });

  it("unscoped recall returns all repo-context entries", async () => {
    const rk = new RepoKnowledge(db, embeddings);
    await rk.capture("plures/pluresdb", "LLVM toolchain needed", { buildSystem: "cargo" });
    // Note: a second capture with the same stub vector may dedup with the first;
    // the key invariant is that all returned entries belong to repo-context category.
    await rk.capture("plures/pluresLM", "Node 18+ required", { buildSystem: "npm" });

    const results = await rk.recall(undefined, "build toolchain");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.entry.category === REPO_CONTEXT_CATEGORY)).toBe(true);
  });

  it("scoped recall only returns entries for the given repository", async () => {
    const rk = new RepoKnowledge(db, embeddings);
    await rk.capture("plures/pluresdb", "LLVM toolchain", { buildSystem: "cargo" });
    await rk.capture("plures/other", "Different repo context", {});

    const results = await rk.recall("plures/pluresdb", "build");
    expect(results.every((r) => r.entry.tags.includes("repository:plures/pluresdb"))).toBe(true);
  });

  it("recall returns [] when no EmbeddingProvider is given", async () => {
    const rk = new RepoKnowledge(db, null);
    await rk.capture("plures/test", "test content", {});
    const results = await rk.recall("plures/test", "build");
    expect(results).toEqual([]);
  });
});

describe("PreferenceTracker", () => {
  let db: MemoryDB;
  let cleanup: () => void;
  let embeddings: StubEmbeddings;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    embeddings = new StubEmbeddings();
  });

  afterEach(() => {
    cleanup();
  });

  it("captures human override with correct category and tags", async () => {
    const pt = new PreferenceTracker(db, embeddings);
    const entry = await pt.capture(
      "Assigning PR review tasks",
      "Always route Rust PRs to human reviewer",
      { overrideType: "delegation", delegationTarget: "human", tags: ["rust"] },
    );
    expect(entry.category).toBe(PREFERENCE_CATEGORY);
    expect(entry.tags).toContain("override-type:delegation");
    expect(entry.tags).toContain("target:human");
    expect(entry.tags).toContain("rust");
  });

  it("recalls preference when similar decision arises", async () => {
    const pt = new PreferenceTracker(db, embeddings);
    await pt.capture(
      "Reviewing Rust PRs",
      "Route to human reviewer",
      { overrideType: "delegation", delegationTarget: "human" },
    );

    const results = await pt.recall("reviewing a Rust pull request");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.category).toBe(PREFERENCE_CATEGORY);
  });

  it("recall returns [] when no EmbeddingProvider is given", async () => {
    const pt = new PreferenceTracker(db, null);
    await pt.capture("some context", "some preference", {});
    const results = await pt.recall("some context");
    expect(results).toEqual([]);
  });
});

describe("DelegationHelper", () => {
  let db: MemoryDB;
  let cleanup: () => void;
  let embeddings: StubEmbeddings;
  let helper: DelegationHelper;

  beforeEach(() => {
    ({ db, cleanup } = makeTestDB());
    embeddings = new StubEmbeddings();
    helper = new DelegationHelper(db, embeddings);
  });

  afterEach(() => {
    cleanup();
  });

  it("exposes errors, repos, and preferences sub-modules", () => {
    expect(helper.errors).toBeInstanceOf(ErrorCapture);
    expect(helper.repos).toBeInstanceOf(RepoKnowledge);
    expect(helper.preferences).toBeInstanceOf(PreferenceTracker);
  });

  it("defaults to copilot with low confidence when no memory matches", async () => {
    const decision = await helper.decide("Optimise the React rendering pipeline");
    expect(decision.target).toBe("copilot");
    expect(decision.confidence).toBeLessThanOrEqual(0.5);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("respects human preference override in routing", async () => {
    await helper.preferences.capture(
      "Reviewing security-sensitive Rust PRs",
      "Route to human security reviewer",
      { overrideType: "delegation", delegationTarget: "human" },
    );

    const decision = await helper.decide(
      "Review this security-sensitive Rust pull request",
    );
    expect(decision.target).toBe("human");
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it("respects copilot preference override in routing", async () => {
    await helper.preferences.capture(
      "Reviewing documentation-only PRs",
      "Route doc-only changes to Copilot",
      { overrideType: "delegation", delegationTarget: "copilot" },
    );

    const decision = await helper.decide(
      "Review this documentation-only pull request update",
    );
    expect(decision.target).toBe("copilot");
  });

  it("routes to copilot when a known error fix exists", async () => {
    await helper.errors.captureError(
      "libclang not found on Windows",
      "Install LLVM and set LIBCLANG_PATH",
      { repository: "plures/pluresdb" },
    );

    const decision = await helper.decide("libclang missing during cargo build");
    expect(decision.target).toBe("copilot");
    expect(decision.reason).toContain("fix");
  });
});

