#!/usr/bin/env npx tsx
/**
 * Tests for the ops/ operational memory modules:
 *   - ErrorCapture
 *   - RepoKnowledge
 *   - PreferenceTracker
 *   - DelegationHelper
 *
 * Uses MemoryDB (better-sqlite3) as the backend with a temporary database.
 * Embeddings are produced by DualEmbeddings (Transformers.js, in-process).
 */

import { MemoryDB } from "../../src/memory-db.js";
import { DualEmbeddings } from "../../src/embeddings.js";
import { ErrorCapture, ERROR_PATTERN_CATEGORY } from "../../src/ops/error-capture.js";
import { RepoKnowledge, REPO_CONTEXT_CATEGORY } from "../../src/ops/repo-knowledge.js";
import { PreferenceTracker, PREFERENCE_CATEGORY } from "../../src/ops/preference-tracker.js";
import { DelegationHelper } from "../../src/ops/delegation-helper.js";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = join(tmpdir(), "pluresLM-ops-test.db");
const PASS = "✅";
const FAIL = "❌";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`${FAIL} ${msg}`);
    failed++;
  }
}

async function main() {
  // Cleanup any leftover test DB
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new MemoryDB(TEST_DB, 384);
  const embeddings = new DualEmbeddings({
    provider: "transformers",
    transformersModel: "Xenova/bge-small-en-v1.5",
    dimension: 384,
  });

  // ── ErrorCapture ───────────────────────────────────────────────────────────

  console.log("\n=== ErrorCapture ===\n");

  const errorCapture = new ErrorCapture(db, embeddings);

  const entry = await errorCapture.captureError(
    "libclang not found on Windows",
    "Install LLVM and set LIBCLANG_PATH",
    { repository: "plures/pluresdb", ciSystem: "github-actions", tags: ["windows"] },
  );

  assert(entry.category === ERROR_PATTERN_CATEGORY, `Stored with category "${ERROR_PATTERN_CATEGORY}"`);
  assert(entry.tags.includes("repository:plures/pluresdb"), `Tag repository:plures/pluresdb present`);
  assert(entry.tags.includes("ci:github-actions"), `Tag ci:github-actions present`);
  assert(entry.tags.includes("windows"), `Extra tag "windows" present`);
  assert(entry.content.includes("libclang"), `Content contains error text`);
  assert(entry.content.includes("LIBCLANG_PATH"), `Content contains fix text`);

  // Recall with a similar error description
  const fixes = await errorCapture.recallFix("libclang missing during build");
  assert(fixes.length > 0, `recallFix returns at least one result`);
  assert(
    fixes[0].entry.category === ERROR_PATTERN_CATEGORY,
    `Recalled entry has correct category`,
  );
  assert(fixes[0].score > 0.3, `Recalled entry has meaningful similarity score`);

  // ── RepoKnowledge ──────────────────────────────────────────────────────────

  console.log("\n=== RepoKnowledge ===\n");

  const repoKnowledge = new RepoKnowledge(db, embeddings);

  const repoEntry = await repoKnowledge.capture(
    "plures/pluresdb",
    "Requires LLVM toolchain. Set LIBCLANG_PATH before running cargo build.",
    { buildSystem: "cargo", tags: ["setup"] },
  );

  assert(repoEntry.category === REPO_CONTEXT_CATEGORY, `Stored with category "${REPO_CONTEXT_CATEGORY}"`);
  assert(repoEntry.tags.includes("repository:plures/pluresdb"), `Tag repository:plures/pluresdb present`);
  assert(repoEntry.tags.includes("build:cargo"), `Tag build:cargo present`);

  const repoResults = await repoKnowledge.recall(
    "plures/pluresdb",
    "How do I build this repo?",
  );
  assert(repoResults.length > 0, `recall returns at least one result`);
  assert(
    repoResults[0].entry.category === REPO_CONTEXT_CATEGORY,
    `Recalled repo entry has correct category`,
  );
  assert(
    repoResults[0].entry.tags.includes("repository:plures/pluresdb"),
    `Recalled repo entry tagged with repository`,
  );

  // ── PreferenceTracker ──────────────────────────────────────────────────────

  console.log("\n=== PreferenceTracker ===\n");

  const preferenceTracker = new PreferenceTracker(db, embeddings);

  const prefEntry = await preferenceTracker.capture(
    "Assigning PR review tasks",
    "Always route Rust PRs to human reviewer, not Copilot",
    { overrideType: "delegation", delegationTarget: "human", tags: ["rust"] },
  );

  assert(prefEntry.category === PREFERENCE_CATEGORY, `Stored with category "${PREFERENCE_CATEGORY}"`);
  assert(prefEntry.tags.includes("override-type:delegation"), `Tag override-type:delegation present`);
  assert(prefEntry.tags.includes("target:human"), `Tag target:human present`);
  assert(prefEntry.tags.includes("rust"), `Extra tag "rust" present`);

  const prefResults = await preferenceTracker.recall("reviewing a Rust pull request");
  assert(prefResults.length > 0, `recall returns at least one result`);
  assert(
    prefResults[0].entry.category === PREFERENCE_CATEGORY,
    `Recalled preference has correct category`,
  );

  // ── DelegationHelper ───────────────────────────────────────────────────────

  console.log("\n=== DelegationHelper ===\n");

  // Use a fresh DB so earlier test data does not influence delegation decisions.
  db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
  const dbDelegation = new MemoryDB(TEST_DB, 384);

  const helper = new DelegationHelper(dbDelegation, embeddings);

  // Expose sub-modules
  assert(helper.errors instanceof ErrorCapture, `helper.errors is ErrorCapture`);
  assert(helper.repos instanceof RepoKnowledge, `helper.repos is RepoKnowledge`);
  assert(helper.preferences instanceof PreferenceTracker, `helper.preferences is PreferenceTracker`);

  // Seed: store a known fix and repo context for pluresdb
  await helper.errors.captureError(
    "libclang not found on Windows",
    "Install LLVM and set LIBCLANG_PATH",
    { repository: "plures/pluresdb" },
  );
  await helper.repos.capture(
    "plures/pluresdb",
    "Requires LLVM toolchain on Windows. Set LIBCLANG_PATH before cargo build.",
    { buildSystem: "cargo" },
  );

  // Delegation decision with repo context available
  const decision = await helper.decide(
    "Build the pluresdb project on Windows",
    { repository: "plures/pluresdb" },
  );
  assert(
    decision.target === "copilot" || decision.target === "human" || decision.target === "self",
    `Decision target is a valid DelegationTarget: "${decision.target}"`,
  );
  assert(typeof decision.reason === "string" && decision.reason.length > 0, `Decision reason is non-empty`);
  assert(decision.confidence > 0 && decision.confidence <= 1, `Confidence is in (0, 1]`);
  console.log(`   Decision: ${decision.target} (confidence=${decision.confidence.toFixed(2)}) — ${decision.reason.slice(0, 80)}`);

  // Delegation decision with no prior memory (fresh query → default fallback)
  const freshDecision = await helper.decide("Optimise the rendering pipeline in a React app");
  assert(freshDecision.target === "copilot", `Unknown task defaults to copilot`);
  assert(freshDecision.confidence <= 0.5, `Default fallback has low confidence`);
  console.log(`   Fallback decision: ${freshDecision.target} (${freshDecision.confidence.toFixed(2)})`);

  // Delegation preference with explicit target tag
  await helper.preferences.capture(
    "Reviewing Rust security-sensitive PRs",
    "Route to human security reviewer",
    { overrideType: "delegation", delegationTarget: "human" },
  );
  const securityDecision = await helper.decide("Review this Rust security-sensitive pull request");
  assert(securityDecision.target === "human", `Preference with target:human routes to human`);
  console.log(`   Security PR decision: ${securityDecision.target} (${securityDecision.confidence.toFixed(2)})`);

  // Delegation preference with target:copilot
  await helper.preferences.capture(
    "Reviewing documentation-only PRs",
    "Route doc-only changes to Copilot for automated review",
    { overrideType: "delegation", delegationTarget: "copilot" },
  );
  const docDecision = await helper.decide("Review this documentation-only pull request update");
  assert(docDecision.target === "copilot", `Preference with target:copilot routes to copilot`);
  console.log(`   Doc PR decision: ${docDecision.target} (${docDecision.confidence.toFixed(2)})`);

  // Cleanup
  dbDelegation.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
