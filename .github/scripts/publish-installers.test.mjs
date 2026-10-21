import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";
import {
  identity, validateRun, inspectCandidate, verifyAssets, unpackArtifact, evaluatePublicationContract,
  payloadNames, assetNames, targets, sourceRepo, workflowPath, releaseExists, assertStableVersionAdvances, createReleaseDraft,
} from "./publish-installers.mjs";

const candidate = identity({ tag: "plureslm-v2.4.0", source_sha: "a".repeat(40), run_id: 123 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = {
  id: 123, workflow_id: 99, path: workflowPath, repository: { full_name: sourceRepo },
  head_repository: { full_name: sourceRepo }, head_branch: candidate.tag,
  event: "push", head_sha: candidate.source_sha, status: "completed", conclusion: "success",
};
const artifacts = targets.map((target, index) => ({
  id: index + 1, name: `plureslm-npm-${target}-${candidate.source_sha}`, digest: `sha256:${"b".repeat(64)}`,
  expired: false, workflow_run: { id: 123, head_sha: candidate.source_sha }, size_in_bytes: 100,
}));

function responses() {
  const map = new Map([
    [`repos/${sourceRepo}/actions/workflows/plureslm-package-artifact.yml`, { id: 99 }],
    [`repos/${sourceRepo}/actions/runs/123`, JSON.parse(JSON.stringify(run))],
    [`repos/${sourceRepo}/git/ref/tags/${candidate.tag}`, { object: { type: "commit", sha: candidate.source_sha } }],
    [`repos/${sourceRepo}/compare/main...${candidate.source_sha}`, { status: "behind" }],
    [`repos/${sourceRepo}/actions/runs/123/artifacts?per_page=100`, { total_count: 2, artifacts: JSON.parse(JSON.stringify(artifacts)) }],
  ]);
  for (const name of ["package.json", "package-lock.json", "openclaw.plugin.json"]) {
    map.set(`repos/${sourceRepo}/contents/packages/plureslm/${name}?ref=${candidate.source_sha}`, {
      encoding: "base64", content: Buffer.from(JSON.stringify({
        name: "@plures/plureslm", version: candidate.version, packages: { "": { version: candidate.version } },
      })).toString("base64"),
    });
  }
  return map;
}

async function inspect(map) {
  return inspectCandidate(candidate, async (path) => {
    assert.ok(map.has(path), `Unexpected API request: ${path}`);
    return map.get(path);
  });
}

test("rejects malformed and extra dispatch fields", () => {
  for (const patch of [
    { run_id: "123" }, { run_id: -1 }, { source_sha: "../source" }, { tag: "../tag" },
    { tag: "v2.4.0" }, { tag: "plureslm-v02.4.0" }, { artifact_url: "https://example.org" },
  ]) assert.throws(() => identity({ tag: candidate.tag, source_sha: candidate.source_sha, run_id: 123, ...patch }));
});

test("detects existing tags and drafts and propagates collision lookup failures", async () => {
  assert.equal(await releaseExists(candidate.tag, async () => [{ ref: `refs/tags/${candidate.tag}` }]), true);
  let count = 0;
  assert.equal(await releaseExists(candidate.tag, async () => ++count === 1 ? [] : [{ tag_name: candidate.tag, draft: true }]), true);
  assert.equal(await releaseExists(candidate.tag, async () => []), false);
  await assert.rejects(releaseExists(candidate.tag, async () => { throw new Error("Forbidden"); }), /Forbidden/);
  let calls = 0;
  assert.equal(await releaseExists(candidate.tag, async () => {
    calls++;
    return calls === 1 ? [] : calls === 2 ? Array(100).fill({ tag_name: "other" }) : [{ tag_name: candidate.tag }];
  }), true);
});

test("exact successful source workflow only, never forks or PR runs", () => {
  validateRun(run, candidate, 99);
  for (const patch of [
    { conclusion: "failure" }, { status: "in_progress" }, { workflow_id: 100 }, { path: "other.yml" },
    { event: "pull_request" }, { head_sha: "b".repeat(40) }, { head_branch: "main" },
    { head_repository: { full_name: "attacker/praxis-platform" } }, { id: 124 },
  ]) assert.throws(() => validateRun({ ...run, ...patch }, candidate, 99));
});

test("publisher runs only trusted public main under approval and legacy source publishing is opt-in", async () => {
  const workflow = await readFile(new URL("../workflows/publish-installers.yml", import.meta.url), "utf8");
  assert.match(workflow, /environment: plureslm-release/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /verify_only:[\s\S]+default: true/);
  assert.doesNotMatch(workflow, /pull_request_target|npm (?:ci|install)|client_payload\./);
  const legacy = await readFile(new URL("../workflows/release.yml", import.meta.url), "utf8");
  assert.doesNotMatch(legacy, /\n {2}push:/);
  assert.match(legacy, /if: inputs\.publish_legacy_source/);
});

test("verifies source ancestry, annotated tags, manifests and exact artifact pair", async () => {
  assert.equal((await inspect(responses())).artifacts.length, 2);
  const annotated = responses();
  annotated.set(`repos/${sourceRepo}/git/ref/tags/${candidate.tag}`, { object: { type: "tag", sha: "c".repeat(40) } });
  annotated.set(`repos/${sourceRepo}/git/tags/${"c".repeat(40)}`, { object: { type: "commit", sha: candidate.source_sha } });
  await inspect(annotated);
  for (const status of ["ahead", "diverged"]) {
    const map = responses();
    map.set(`repos/${sourceRepo}/compare/main...${candidate.source_sha}`, { status });
    await assert.rejects(inspect(map), /main/);
  }
  const moved = responses();
  moved.get(`repos/${sourceRepo}/git/ref/tags/${candidate.tag}`).object.sha = "b".repeat(40);
  await assert.rejects(inspect(moved), /tag/);
  const manifest = responses();
  manifest.get(`repos/${sourceRepo}/contents/packages/plureslm/package.json?ref=${candidate.source_sha}`).content =
    Buffer.from('{"version":"9.9.9"}').toString("base64");
  await assert.rejects(inspect(manifest), /manifests/);
  for (const patch of [
    { expired: true }, { digest: null }, { workflow_run: { id: 124, head_sha: candidate.source_sha } },
    { workflow_run: { id: 123, head_sha: "b".repeat(40) } }, { size_in_bytes: 0 },
  ]) {
    const map = responses();
    Object.assign(map.get(`repos/${sourceRepo}/actions/runs/123/artifacts?per_page=100`).artifacts[0], patch);
    await assert.rejects(inspect(map), /artifact/);
  }
  for (const collection of [[artifacts[0]], [artifacts[0], artifacts[0], artifacts[1]]]) {
    const map = responses();
    map.set(`repos/${sourceRepo}/actions/runs/123/artifacts?per_page=100`, { total_count: collection.length, artifacts: collection });
    await assert.rejects(inspect(map), /artifact/);
  }
  await assert.rejects(inspectCandidate(candidate, async () => { throw new Error("API unavailable"); }), /API unavailable/);
});

async function fixture(directory) {
  for (const target of targets) {
    for (const filename of payloadNames(candidate.version, target)) {
      const bytes = Buffer.from(`fixture ${filename}`);
      const sha256 = digest(bytes);
      await writeFile(join(directory, filename), bytes);
      await writeFile(join(directory, `${filename}.sha256`), `${sha256}  ${filename}\n`);
      await writeFile(join(directory, `${filename}.provenance.json`), JSON.stringify({
        schemaVersion: 1, package: "@plures/plureslm", version: candidate.version, target, filename, sha256,
        sourceSha: candidate.source_sha, workflowUrl: `https://github.com/${sourceRepo}/actions/runs/123`,
        bundledNode: true, installSmokePassed: true, offlineInstallPassed: true,
      }));
    }
  }
}

test("checks every payload, exact file set, run binding and lifecycle evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plureslm-assets-test-"));
  try {
    await fixture(directory);
    assert.equal((await verifyAssets(directory, candidate)).length, 15);
    const metadataFile = join(directory, "plureslm-2.4.0-win32-x64-msvc.msi.provenance.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    for (const patch of [
      { sourceSha: "b".repeat(40) }, { workflowUrl: `https://github.com/${sourceRepo}/actions/runs/124` },
      { bundledNode: false }, { installSmokePassed: false }, { offlineInstallPassed: false },
      { version: "2.4.1" }, { target: "linux-x64-gnu" },
    ]) {
      await writeFile(metadataFile, JSON.stringify({ ...metadata, ...patch }));
      await assert.rejects(verifyAssets(directory, candidate), /metadata|evidence/);
    }
    await writeFile(metadataFile, JSON.stringify(metadata));
    await writeFile(join(directory, "unexpected.txt"), "not publishable");
    await assert.rejects(verifyAssets(directory, candidate), /fifteen/);
    await rm(join(directory, "unexpected.txt"));
    await writeFile(join(directory, "plureslm-2.4.0-win32-x64-msvc.msi"), "tampered");
    await assert.rejects(verifyAssets(directory, candidate), /Checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluates the closed PX boolean contract and rejects every missing gate", async () => {
  const source = await readFile(new URL("../release/publication.px", import.meta.url), "utf8");
  const evidence = {
    trusted_workflow: true, successful_run: true, tag_matches_source: true, source_on_main: true,
    manifests_agree: true, exact_artifacts: true, exact_assets: true, checksums_verified: true,
    install_evidence_verified: true, reviewer_required: true, stable_version_advances: true, existing_release: false,
  };
  evaluatePublicationContract(source, evidence);
  for (const [key, value] of Object.entries(evidence)) {
    assert.throws(() => evaluatePublicationContract(source, { ...evidence, [key]: !value }), /rejected/);
    const missing = { ...evidence };
    delete missing[key];
    assert.throws(() => evaluatePublicationContract(source, missing), /rejected/);
  }
  assert.throws(() => evaluatePublicationContract(source.replace(" AND ", " OR "), evidence), /Unsupported/);
  assert.throws(() => evaluatePublicationContract(source.replace("reviewer_required == true", "reviewer_required == false"), evidence), /changed/);
  assert.throws(() => evaluatePublicationContract(`${source}\nconstraint extra:\n`, evidence), /Unsupported/);
});

test("atomically claims the public tag before creating a verified-tag draft", () => {
  const calls = [];
  const sha = "d".repeat(40);
  createReleaseDraft(candidate, sha, ["installer.msi"], "notes", (args) => calls.push(args));
  assert.deepEqual(calls[0], ["api", "--method", "POST", "repos/plures/pluresLM/git/refs",
    "--raw-field", `ref=refs/tags/${candidate.tag}`, "--raw-field", `sha=${sha}`]);
  assert.equal(calls[1][0], "release");
  assert.ok(calls[1].includes("--verify-tag"));
  assert.ok(calls[1].includes("--latest=false"));
  assert.ok(!calls[1].includes("--target"));
  let attempts = 0;
  assert.throws(() => createReleaseDraft(candidate, sha, [], "notes", () => {
    attempts++;
    throw new Error("Reference already exists");
  }), /Reference already exists/);
  assert.equal(attempts, 1, "a conflicting writer must prevent draft creation");
  assert.throws(() => createReleaseDraft(candidate, "invalid", [], "notes", () => assert.fail("unexpected write")));
});

test("out-of-order stable recovery never regresses the stable download", async () => {
  const published = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
  await assert.rejects(assertStableVersionAdvances(candidate, async () => [published("plureslm-v2.5.0")]), /newer/);
  await assert.rejects(assertStableVersionAdvances(candidate, async () => [published("plureslm-v2.4.0")]), /newer/);
  await assertStableVersionAdvances(candidate, async () => [published("v2.3.0")]);
  await assertStableVersionAdvances({ ...candidate, version: "2.10.0" }, async () => [published("plureslm-v2.9.0")]);
  await assertStableVersionAdvances(candidate, async () => [
    published("plureslm-v3.0.0", { draft: true }), published("plureslm-v3.0.0-rc.1", { prerelease: true }),
  ]);
  await assertStableVersionAdvances({ ...candidate, version: "2.4.0-rc.1" }, async () => assert.fail("prereleases never promote stable"));
  await assert.rejects(assertStableVersionAdvances(candidate, async () => { throw new Error("Forbidden"); }), /Forbidden/);
  await assert.rejects(assertStableVersionAdvances(candidate, async () => [published("unknown-stable")]), /Unrecognized/);
  let page = 0;
  await assert.rejects(assertStableVersionAdvances(candidate, async () =>
    ++page === 1 ? Array(100).fill(published("v2.3.0")) : [published("plureslm-v2.5.0")]), /newer/);
});

test("ZIP transport digest and flat allowlist prevent arbitrary extraction", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "plureslm-zip-test-"));
  try {
    const directory = join(scratch, "fixture");
    const output = join(scratch, "output");
    await mkdir(directory);
    await mkdir(output);
    await fixture(directory);
    const names = assetNames(candidate.version, targets[0]);
    const archive = join(scratch, "fixture.zip");
    execFileSync("python", ["-c", "import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[1],'w'); root=pathlib.Path(sys.argv[2]); [z.write(root/n,n) for n in sys.argv[3:]]; z.close()", archive, directory, ...names]);
    const bytes = await readFile(archive);
    const artifact = { id: 1, digest: `sha256:${digest(bytes)}`, target: targets[0] };
    await unpackArtifact(bytes, artifact, output, candidate, scratch);
    assert.equal((await readFile(join(output, names[0]))).length > 0, true);
    await assert.rejects(unpackArtifact(Buffer.from("tampered"), artifact, output, candidate, scratch), /digest/);
    for (const badName of ["../escape", "nested/unexpected", names[0]]) {
      execFileSync("python", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'a'); z.writestr(sys.argv[2],'bad'); z.close()", archive, badName]);
      const bad = await readFile(archive);
      await assert.rejects(unpackArtifact(bad, { ...artifact, digest: `sha256:${digest(bad)}` }, output, candidate, scratch), /unexpected or duplicate/);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
