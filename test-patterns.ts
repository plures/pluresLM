#!/usr/bin/env npx tsx
/**
 * Tests for the YAML-extensible pattern engine (src/patterns.ts)
 *
 * Tests: schema validation, pattern loading, template rendering,
 *        trigger→capture→recall→action flow, hot-reload, conditions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  PatternEngine,
  PatternSchema,
  renderValue,
  type PatternDefinition,
  type PatternMatch,
} from "./src/patterns.js";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmpPattern(dir: string, filename: string, content: string) {
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

const VALID_YAML = `
name: test-pattern
version: 1
description: A test pattern
trigger:
  event: test-event
  conditions:
    repo: plures/test
capture:
  content: "Captured: {{message}}"
  opts:
    category: test-cat
    tags:
      - "{{tag}}"
recall:
  query: "{{message}}"
  filter:
    category: test-cat
  limit: 3
  min_similarity: 0.7
action:
  on_match:
    type: suggest-fix
    template: "Found prior fix: {{recalled.content}}"
  on_no_match:
    type: store-new
`;

const INVALID_YAML = `
name: bad-pattern
# missing version, trigger, capture, recall, action
description: incomplete
`;

// ---------------------------------------------------------------------------
// 1. Zod schema validation
// ---------------------------------------------------------------------------

console.log("\n=== 1. Schema Validation ===\n");

const validParsed = PatternSchema.safeParse({
  name: "my-pattern",
  version: 1,
  trigger: { event: "ci-failure" },
  capture: { content: "{{msg}}", opts: { category: "test" } },
  recall: { query: "{{msg}}" },
  action: {},
});
assert(validParsed.success, "Valid pattern object passes schema validation");

const missingName = PatternSchema.safeParse({
  version: 1,
  trigger: { event: "ci-failure" },
  capture: { content: "x", opts: {} },
  recall: { query: "x" },
  action: {},
});
assert(!missingName.success, "Pattern without name fails validation");

const zeroVersion = PatternSchema.safeParse({
  name: "p",
  version: 0,
  trigger: { event: "x" },
  capture: { content: "x", opts: {} },
  recall: { query: "x" },
  action: {},
});
assert(!zeroVersion.success, "Version 0 fails validation (must be positive integer)");

const negSimilarity = PatternSchema.safeParse({
  name: "p",
  version: 1,
  trigger: { event: "x" },
  capture: { content: "x", opts: {} },
  recall: { query: "x", min_similarity: -0.1 },
  action: {},
});
assert(!negSimilarity.success, "Negative min_similarity fails validation");

// ---------------------------------------------------------------------------
// 2. renderValue template helper
// ---------------------------------------------------------------------------

console.log("\n=== 2. Template Rendering ===\n");

assert(
  renderValue("Hello {{name}}!", { name: "World" }) === "Hello World!",
  "renderValue renders string templates",
);

const rendered = renderValue({ key: "{{k}}", arr: ["{{v}}", 42] }, { k: "K", v: "V" });
assert(
  JSON.stringify(rendered) === JSON.stringify({ key: "K", arr: ["V", 42] }),
  "renderValue recurses into objects and arrays",
);

assert(
  renderValue(99, {}) === 99,
  "renderValue passes non-string scalars through unchanged",
);

// ---------------------------------------------------------------------------
// 3. PatternEngine – loading from directory
// ---------------------------------------------------------------------------

console.log("\n=== 3. Pattern Loading ===\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluresLM-pattern-test-"));

try {
  writeTmpPattern(tmpDir, "valid.yml", VALID_YAML);
  writeTmpPattern(tmpDir, "invalid.yml", INVALID_YAML);
  writeTmpPattern(tmpDir, "not-a-pattern.txt", "should be ignored");

  const engine = new PatternEngine({ patternsDirs: [tmpDir] });
  engine.load();

  const names = engine.getPatternNames();
  assert(names.includes("test-pattern"), "Valid pattern is loaded");
  assert(!names.includes("bad-pattern"), "Invalid pattern is NOT loaded");
  assert(names.length === 1, "Only 1 pattern loaded (txt file ignored)");

  const p = engine.getPattern("test-pattern")!;
  assert(p.version === 1, "Pattern version preserved");
  assert(p.trigger.event === "test-event", "Trigger event preserved");
  assert(p.capture.content === "Captured: {{message}}", "Capture content preserved");

  // ---------------------------------------------------------------------------
  // 4. loadFile directly
  // ---------------------------------------------------------------------------

  console.log("\n=== 4. loadFile ===\n");

  const loaded = engine.loadFile(path.join(tmpDir, "valid.yml"));
  assert(loaded !== null, "loadFile returns pattern for valid YAML");
  assert(loaded?.name === "test-pattern", "loadFile parses name correctly");

  const failed2 = engine.loadFile(path.join(tmpDir, "invalid.yml"));
  assert(failed2 === null, "loadFile returns null for invalid YAML");

  const missing = engine.loadFile(path.join(tmpDir, "nonexistent.yml"));
  assert(missing === null, "loadFile returns null for missing file");

  // ---------------------------------------------------------------------------
  // 5. getPatternsForEvent
  // ---------------------------------------------------------------------------

  console.log("\n=== 5. getPatternsForEvent ===\n");

  const forEvent = engine.getPatternsForEvent("test-event");
  assert(forEvent.length === 1, "getPatternsForEvent returns matching patterns");

  const forOther = engine.getPatternsForEvent("unknown-event");
  assert(forOther.length === 0, "getPatternsForEvent returns empty for unknown event");

  // ---------------------------------------------------------------------------
  // 6. dispatch – on_no_match → store-new
  // ---------------------------------------------------------------------------

  console.log("\n=== 6. Dispatch: on_no_match (store-new) ===\n");

  const captured: Array<{ content: string; opts: Record<string, unknown> }> = [];
  const engine2 = new PatternEngine({
    patternsDirs: [tmpDir],
    store: async (content, opts) => {
      captured.push({ content, opts });
    },
    search: async () => [], // always no match
  });
  engine2.load();

  const context = { message: "Build failed: module not found", tag: "ci", repo: "plures/test" };
  const results = await engine2.dispatch("test-event", context);

  assert(results.length === 1, "One result from dispatch");
  assert(results[0].action === "store-new", "Action is store-new on no match");
  assert(captured.length === 1, "store callback was called");
  assert(
    captured[0].content === "Captured: Build failed: module not found",
    "Captured content is rendered from template",
  );
  assert(
    (captured[0].opts as { tags: string[] }).tags[0] === "ci",
    "Captured opts tags are rendered",
  );

  // ---------------------------------------------------------------------------
  // 7. dispatch – on_match → suggest-fix
  // ---------------------------------------------------------------------------

  console.log("\n=== 7. Dispatch: on_match (suggest-fix) ===\n");

  const mockMatches: PatternMatch[] = [
    { content: "Install missing package with npm ci", metadata: {}, score: 0.85 },
  ];
  const engine3 = new PatternEngine({
    patternsDirs: [tmpDir],
    store: async () => {},
    search: async () => mockMatches,
  });
  engine3.load();

  const results2 = await engine3.dispatch("test-event", context);
  assert(results2.length === 1, "One result from dispatch with match");
  assert(results2[0].action === "suggest-fix", "Action is suggest-fix on match");
  assert(results2[0].matches?.length === 1, "Matches returned");
  assert(
    results2[0].message === "Found prior fix: Install missing package with npm ci",
    `Message rendered from template: "${results2[0].message}"`,
  );

  // ---------------------------------------------------------------------------
  // 8. dispatch – condition filtering
  // ---------------------------------------------------------------------------

  console.log("\n=== 8. Condition Filtering ===\n");

  // Matching condition
  const matchCtx = { message: "err", tag: "t", repo: "plures/test" };
  const matchResults = await engine3.dispatch("test-event", matchCtx);
  assert(matchResults.length === 1, "Pattern fires when conditions match");

  // Non-matching condition
  const noMatchCtx = { message: "err", tag: "t", repo: "other/repo" };
  const noMatchResults = await engine3.dispatch("test-event", noMatchCtx);
  assert(noMatchResults.length === 0, "Pattern skipped when condition fails");

  // ---------------------------------------------------------------------------
  // 9. Numeric condition comparison
  // ---------------------------------------------------------------------------

  console.log("\n=== 9. Numeric Conditions ===\n");

  const numericPatternYaml = `
name: numeric-pattern
version: 1
trigger:
  event: pr-check
  conditions:
    days_since_update: ">3"
capture:
  content: "{{repository}}#{{pr_number}} stale"
  opts:
    category: stale-pr
recall:
  query: "stale PR in {{repository}}"
  filter:
    category: stale-pr
  limit: 5
action:
  on_match:
    type: escalate
  on_no_match:
    type: store-new
`;
  writeTmpPattern(tmpDir, "numeric.yml", numericPatternYaml);

  const engine4 = new PatternEngine({
    patternsDirs: [tmpDir],
    store: async () => {},
    search: async () => [],
  });
  engine4.load();

  const staleCtx = { days_since_update: "5", repository: "plures/test", pr_number: "42" };
  const staleResults = await engine4.dispatch("pr-check", staleCtx);
  assert(staleResults.length === 1, "Numeric >3 condition passes for value 5");

  const freshCtx = { days_since_update: "2", repository: "plures/test", pr_number: "43" };
  const freshResults = await engine4.dispatch("pr-check", freshCtx);
  assert(freshResults.length === 0, "Numeric >3 condition fails for value 2");

  // ---------------------------------------------------------------------------
  // 10. Built-in patterns
  // ---------------------------------------------------------------------------

  console.log("\n=== 10. Built-in Patterns ===\n");

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const builtinDir = path.join(__dirname, "src", "patterns");

  const engineBuiltin = new PatternEngine({ patternsDirs: [builtinDir] });
  engineBuiltin.load();

  const builtinNames = engineBuiltin.getPatternNames();
  console.log(`   Loaded built-in patterns: ${builtinNames.join(", ")}`);

  assert(builtinNames.includes("error-patterns"), "error-patterns built-in loaded");
  assert(builtinNames.includes("preference-override"), "preference-override built-in loaded");
  assert(builtinNames.includes("repo-quirks"), "repo-quirks built-in loaded");
  assert(builtinNames.includes("delegation-context"), "delegation-context built-in loaded");

  // ---------------------------------------------------------------------------
  // 11. Hot-reload (write a new file and verify it is picked up)
  // ---------------------------------------------------------------------------

  console.log("\n=== 11. Hot-reload ===\n");

  const hotDir = fs.mkdtempSync(path.join(os.tmpdir(), "pluresLM-hot-"));
  try {
    const engineHot = new PatternEngine({ patternsDirs: [hotDir], watch: true });
    engineHot.load();

    assert(engineHot.getPatternNames().length === 0, "Hot dir starts empty");

    let reloadedName: string | undefined;
    engineHot.on("pattern:reloaded", (p: PatternDefinition) => {
      reloadedName = p.name;
    });

    const hotPatternYaml = `
name: hot-pattern
version: 1
trigger:
  event: hot-event
capture:
  content: "{{msg}}"
  opts:
    category: hot
recall:
  query: "{{msg}}"
action:
  on_no_match:
    type: store-new
`;
    writeTmpPattern(hotDir, "hot.yml", hotPatternYaml);

    // Give the watcher time to fire
    await new Promise((r) => setTimeout(r, 300));

    assert(
      engineHot.getPattern("hot-pattern") !== undefined,
      "Hot-reloaded pattern is available in the registry",
    );
    assert(reloadedName === "hot-pattern", "pattern:reloaded event fired with correct name");

    engineHot.stopWatching();
  } finally {
    fs.rmSync(hotDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // 12. dispatch – no store/search callbacks (graceful degradation)
  // ---------------------------------------------------------------------------

  console.log("\n=== 12. Graceful Degradation (no callbacks) ===\n");

  const engineNoop = new PatternEngine({ patternsDirs: [tmpDir] });
  engineNoop.load();

  const noopResults = await engineNoop.dispatch("test-event", context);
  assert(noopResults.length === 1, "Dispatch returns result even without callbacks");
  assert(
    noopResults[0].action === "store-new",
    "Action is store-new when no search callback (no matches found)",
  );

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
