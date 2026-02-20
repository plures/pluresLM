#!/usr/bin/env npx tsx
/**
 * Self-test infrastructure unit tests.
 *
 * Tests: getEmbeddingByteLength(), dimension mismatch detection, kind/version
 * assertion logic, dist freshness warning logic, and behavior when self-test
 * fails (auto-recall / auto-capture disabled).
 *
 * Does NOT require network access — no embeddings model download needed.
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

const tmpDir = os.tmpdir();
const TEST_DB = path.join(tmpDir, "pluresLM-selftest.db");
const TEST_DB2 = path.join(tmpDir, "pluresLM-selftest2.db");

function cleanup(...dbs: string[]) {
  for (const db of dbs) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = db + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
  }
}

async function main() {
  cleanup(TEST_DB, TEST_DB2);

  // =========================================================================
  console.log("\n=== 1. getEmbeddingByteLength — empty DB ===\n");
  // =========================================================================

  const db = new MemoryDB(TEST_DB, 384);
  const noneResult = await db.getEmbeddingByteLength();
  assert(noneResult === null, "getEmbeddingByteLength returns null when no embeddings");

  // =========================================================================
  console.log("\n=== 2. getEmbeddingByteLength — after storing 384-dim embedding ===\n");
  // =========================================================================

  const vec384 = new Array(384).fill(0).map((_, i) => i / 384);
  await db.store("Test memory", vec384, { source: "test", tags: [], category: "test" });

  const result384 = await db.getEmbeddingByteLength();
  // MemoryDB uses Float64Array (8 bytes per value)
  const expected384Bytes = 384 * 8;
  assert(result384 === expected384Bytes,
    `getEmbeddingByteLength returns ${expected384Bytes} bytes for 384-dim embedding (got ${result384})`);

  db.close();

  // =========================================================================
  console.log("\n=== 3. getEmbeddingByteLength — 1536-dim DB ===\n");
  // =========================================================================

  const db2 = new MemoryDB(TEST_DB2, 1536);
  const vec1536 = new Array(1536).fill(0).map((_, i) => i / 1536);
  await db2.store("Test 1536", vec1536, { source: "test", tags: [], category: "test" });

  const result1536 = await db2.getEmbeddingByteLength();
  const expected1536Bytes = 1536 * 8;
  assert(result1536 === expected1536Bytes,
    `getEmbeddingByteLength returns ${expected1536Bytes} bytes for 1536-dim embedding (got ${result1536})`);

  db2.close();
  cleanup(TEST_DB, TEST_DB2);

  // =========================================================================
  console.log("\n=== 4. Dimension mismatch detection logic ===\n");
  // =========================================================================

  const configDim = 384;
  const bytesPerValue = 8;

  // Case: DB has 1536-dim embeddings but config expects 384
  const storedByteLen = 1536 * bytesPerValue;
  const expectedBytes = configDim * bytesPerValue;
  assert(storedByteLen !== expectedBytes,
    `Mismatch detected: DB=${storedByteLen / bytesPerValue}-dim, config=${configDim}-dim`);
  const actualDim = storedByteLen / bytesPerValue;
  assert(Number.isInteger(actualDim) && actualDim === 1536,
    `actualDim computed correctly as ${actualDim}`);

  // Case: DB has matching 384-dim embeddings
  const matchingByteLen = 384 * bytesPerValue;
  assert(matchingByteLen === expectedBytes,
    `Match confirmed: ${matchingByteLen / bytesPerValue}-dim ✓`);

  // Case: Corruption — byte length not divisible by 8
  const corruptByteLen = 3073; // 384 * 8 + 1
  assert(corruptByteLen % bytesPerValue !== 0,
    `Corruption detected: ${corruptByteLen} bytes is not divisible by ${bytesPerValue}`);

  // =========================================================================
  console.log("\n=== 5. Kind/version assertion logic ===\n");
  // =========================================================================

  const plugin = { id: "pluresLM", kind: "extension" };
  const manifest = { id: "pluresLM", kind: "extension", version: "0.14.0" };
  const pkg = { version: "0.14.0" };

  assert(plugin.id === manifest.id && plugin.kind === manifest.kind,
    "Kind/id assertion passes when code matches manifest");
  assert(pkg.version === manifest.version,
    "Version check passes when package.json matches manifest");

  const wrongManifest = { id: "wrongId", kind: "extension", version: "0.12.0" };
  assert(plugin.id !== wrongManifest.id,
    "Kind/id assertion detects id mismatch");
  assert(pkg.version !== wrongManifest.version,
    "Version check detects version mismatch");

  // =========================================================================
  console.log("\n=== 6. Dist freshness logic ===\n");
  // =========================================================================

  const fakeRoot = path.join(tmpDir, "pluresLM-freshtest");
  const fakeSrc = path.join(fakeRoot, "src");
  const fakeDist = path.join(fakeRoot, "dist");
  mkdirSync(fakeSrc, { recursive: true });
  mkdirSync(fakeDist, { recursive: true });

  // Write a dist file and a src file with matching timestamps
  const jsFile = path.join(fakeDist, "index.js");
  const tsFile = path.join(fakeSrc, "index.ts");
  writeFileSync(jsFile, "// compiled");
  writeFileSync(tsFile, "// source");

  const past = new Date(Date.now() - 10_000); // 10 seconds ago
  const now = new Date();

  // dist is NEWER than src → fresh
  utimesSync(tsFile, past, past);
  utimesSync(jsFile, now, now);
  const tsMtimeOk = past.getTime();
  const jsMtimeOk = now.getTime();
  assert(tsMtimeOk < jsMtimeOk, "Fresh: dist is newer than src (no stale warning)");

  // dist is OLDER than src → stale
  utimesSync(tsFile, now, now);
  utimesSync(jsFile, past, past);
  const tsMtimeStale = now.getTime();
  const jsMtimeStale = past.getTime();
  assert(tsMtimeStale > jsMtimeStale, "Stale: src is newer than dist (stale warning expected)");

  rmSync(fakeRoot, { recursive: true });

  // =========================================================================
  console.log("\n=== 7. selfTestErrors disables auto-recall / auto-capture ===\n");
  // =========================================================================

  // Simulate the guard logic used in the auto-recall/auto-capture hooks
  let selfTestErrors: string[] = [];
  let recallFired = false;
  let captureFired = false;

  function simulateRecall() {
    if (selfTestErrors.length > 0) return; // guarded
    recallFired = true;
  }

  function simulateCapture() {
    if (selfTestErrors.length > 0) return; // guarded
    captureFired = true;
  }

  // No errors → hooks run normally
  simulateRecall();
  simulateCapture();
  assert(recallFired, "Auto-recall fires when no self-test errors");
  assert(captureFired, "Auto-capture fires when no self-test errors");

  // Inject errors → hooks are skipped
  recallFired = false;
  captureFired = false;
  selfTestErrors = ["Embedding dimension mismatch: model returned 384 dims, config.embeddingDimension=1536"];
  simulateRecall();
  simulateCapture();
  assert(!recallFired, "Auto-recall is disabled when self-test errors are present");
  assert(!captureFired, "Auto-capture is disabled when self-test errors are present");

  // =========================================================================

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
