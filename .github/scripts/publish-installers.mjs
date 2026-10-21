import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const sourceRepo = "plures/praxis-platform";
export const publicRepo = "plures/pluresLM";
export const workflowPath = ".github/workflows/plureslm-package-artifact.yml";
export const targets = ["win32-x64-msvc", "linux-x64-gnu"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function identity(payload) {
  if (!payload || Object.keys(payload).sort().join(",") !== "run_id,source_sha,tag" ||
      !Number.isSafeInteger(payload.run_id) || payload.run_id <= 0 ||
      !/^[0-9a-f]{40}$/.test(payload.source_sha ?? "") ||
      !/^plureslm-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(payload.tag ?? "")) {
    throw new Error("Invalid candidate identity");
  }
  return { ...payload, version: payload.tag.slice("plureslm-v".length) };
}

export function payloadNames(version, target) {
  return [
    `plures-plureslm-${version}-${target}.tgz`,
    ...(target === "win32-x64-msvc" ? [`plureslm-${version}-${target}.msi`]
      : [`plureslm-${version}-${target}.deb`, `plureslm-${version}-${target}.rpm`]),
  ];
}

export function assetNames(version, target) {
  return payloadNames(version, target).flatMap((name) => [name, `${name}.sha256`, `${name}.provenance.json`]).sort();
}

export function validateRun(run, candidate, workflowId) {
  if (run.id !== candidate.run_id || run.workflow_id !== workflowId || run.path !== workflowPath ||
      run.repository?.full_name?.toLowerCase() !== sourceRepo.toLowerCase() ||
      run.head_repository?.full_name?.toLowerCase() !== sourceRepo.toLowerCase() ||
      !["push", "workflow_dispatch"].includes(run.event) || run.head_branch !== candidate.tag ||
      run.head_sha !== candidate.source_sha) throw new Error("Candidate is not an exact tagged build from the trusted source workflow");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("Candidate run has not completed successfully");
}

export async function inspectCandidate(candidate, api) {
  const workflow = await api(`repos/${sourceRepo}/actions/workflows/plureslm-package-artifact.yml`);
  const run = await api(`repos/${sourceRepo}/actions/runs/${candidate.run_id}`);
  validateRun(run, candidate, workflow.id);
  let object = (await api(`repos/${sourceRepo}/git/ref/tags/${candidate.tag}`)).object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    object = (await api(`repos/${sourceRepo}/git/tags/${object.sha}`)).object;
  }
  if (object.type !== "commit" || object.sha !== candidate.source_sha) throw new Error("Release tag does not resolve to the build source");
  const comparison = await api(`repos/${sourceRepo}/compare/main...${candidate.source_sha}`);
  if (!["behind", "identical"].includes(comparison.status)) throw new Error("Candidate source is not on current main");
  const files = await Promise.all(["package.json", "package-lock.json", "openclaw.plugin.json"].map(async (name) => {
    const file = await api(`repos/${sourceRepo}/contents/packages/plureslm/${name}?ref=${candidate.source_sha}`);
    if (file.encoding !== "base64") throw new Error(`Unexpected source encoding: ${name}`);
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }));
  if (files[0].name !== "@plures/plureslm" || files.some((file) => file.version !== candidate.version) ||
      files[1].packages?.[""]?.version !== candidate.version) throw new Error("Component manifests do not match the release tag");
  const artifacts = await api(`repos/${sourceRepo}/actions/runs/${candidate.run_id}/artifacts?per_page=100`);
  if (artifacts.total_count > 100) throw new Error("Unexpected artifact count");
  const selected = targets.map((target) => {
    const matches = artifacts.artifacts.filter((artifact) => artifact.name === `plureslm-npm-${target}-${candidate.source_sha}`);
    if (matches.length !== 1) throw new Error(`Missing or duplicate target artifact: ${target}`);
    const artifact = matches[0];
    if (artifact.expired || artifact.workflow_run?.id !== candidate.run_id ||
        artifact.workflow_run?.head_sha !== candidate.source_sha || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? "") ||
        !Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
        !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 512 * 1024 * 1024) {
      throw new Error(`Invalid artifact identity, digest or size: ${target}`);
    }
    return { ...artifact, target };
  });
  return { run, artifacts: selected };
}

export async function verifyAssets(directory, candidate) {
  const expected = targets.flatMap((target) => assetNames(candidate.version, target)).sort();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile()) || !same(entries.map((entry) => entry.name).sort(), expected)) {
    throw new Error("Release must contain exactly the fifteen expected payload, checksum and metadata files");
  }

  for (const target of targets) {
    for (const filename of payloadNames(candidate.version, target)) {
      const sha256 = hash(await readFile(join(directory, filename)));
      if (await readFile(join(directory, `${filename}.sha256`), "utf8") !== `${sha256}  ${filename}\n`) {
        throw new Error(`Checksum mismatch: ${filename}`);
      }
      const metadata = JSON.parse(await readFile(join(directory, `${filename}.provenance.json`), "utf8"));
      if (metadata.schemaVersion !== 1 || metadata.package !== "@plures/plureslm" || metadata.version !== candidate.version ||
          metadata.target !== target || metadata.filename !== filename || metadata.sha256 !== sha256 ||
          metadata.sourceSha !== candidate.source_sha ||
          metadata.workflowUrl !== `https://github.com/${sourceRepo}/actions/runs/${candidate.run_id}`) {
        throw new Error(`Source/run metadata mismatch: ${filename}`);
      }
      if (!filename.endsWith(".tgz") &&
          (metadata.bundledNode !== true || metadata.installSmokePassed !== true || metadata.offlineInstallPassed !== true)) {
        throw new Error(`Missing native installer lifecycle evidence: ${filename}`);
      }
    }
  }
  return expected;
}

export async function releaseExists(tag, api) {
  const refs = await api(`repos/${publicRepo}/git/matching-refs/tags/${tag}`);
  if (refs.some((ref) => ref.ref === `refs/tags/${tag}`)) return true;
  // Draft releases may not have a Git tag yet; API errors are never absence.
  for (let page = 1; page <= 20; page++) {
    const releases = await api(`repos/${publicRepo}/releases?per_page=100&page=${page}`);
    if (releases.some((release) => release.tag_name === tag)) return true;
    if (releases.length < 100) return false;
  }
  throw new Error("Release history exceeds the bounded collision check");
}

// This closed adapter accepts only this contract's boolean conjunction grammar,
// not arbitrary PX programs. Unsupported syntax fails rather than being ignored.
export function evaluatePublicationContract(source, evidence) {
  const match = /^constraint verified_public_release:\r?\n  when: action_type == "publish_plureslm_release"\r?\n  require: ([^\r\n]+)\r?\n  severity: error\r?\n  message: "[^"\r\n]+"\r?\n?$/.exec(source);
  if (!match) throw new Error("Unsupported publication PX contract");
  const expected = [
    "trusted_workflow", "successful_run", "tag_matches_source", "source_on_main", "manifests_agree",
    "exact_artifacts", "exact_assets", "checksums_verified", "install_evidence_verified", "reviewer_required", "existing_release",
  ];
  const clauses = match[1].split(" AND ").map((clause) => {
    const parsed = /^([a-z_]+) == (true|false)$/.exec(clause);
    if (!parsed) throw new Error("Unsupported PX boolean expression");
    return { key: parsed[1], value: parsed[2] === "true" };
  });
  if (!same(clauses.map((clause) => clause.key), expected) ||
      clauses.some((clause) => clause.value !== (clause.key !== "existing_release"))) {
    throw new Error("Publication PX constraints changed without updating their adapter");
  }
  const violations = clauses.filter(({ key, value }) => evidence[key] !== value).map(({ key }) => key);
  if (violations.length) throw new Error(`Publication PX rejected: ${violations.join(", ")}`);
}

function gh(args, token, binary = false) {
  if (!token) throw new Error("Required GitHub token is unavailable");
  return execFileSync("gh", args, {
    env: { ...process.env, GH_TOKEN: token },
    encoding: binary ? undefined : "utf8", maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function apiFor(token) {
  return async (path) => JSON.parse(gh(["api", path], token));
}

export async function unpackArtifact(bytes, artifact, directory, candidate, scratch) {
  if (`sha256:${hash(bytes)}` !== artifact.digest) throw new Error("Downloaded artifact digest mismatch");
  const archive = join(scratch, `${artifact.id}.zip`);
  await writeFile(archive, bytes);
  const listed = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trimEnd().split("\n");
  if (!same(listed.sort(), assetNames(candidate.version, artifact.target))) throw new Error("Artifact ZIP contains an unexpected or duplicate path");
  // Never extract paths or execute payloads from the private artifact.
  for (const name of listed) {
    const contents = execFileSync("unzip", ["-p", archive, name], { maxBuffer: 512 * 1024 * 1024 });
    await writeFile(join(directory, name), contents, { flag: "wx" });
  }
}

async function main() {
  if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== publicRepo.toLowerCase() ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !["repository_dispatch", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)) {
    throw new Error("Publisher must run by dispatch on public pluresLM main");
  }
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (process.env.GITHUB_EVENT_NAME === "repository_dispatch" && event.action !== "plureslm-release-candidate") {
    throw new Error("Unexpected release notification type");
  }
  const candidate = identity(process.env.GITHUB_EVENT_NAME === "repository_dispatch" ? event.client_payload : {
    tag: event.inputs?.tag, source_sha: event.inputs?.source_sha, run_id: Number(event.inputs?.run_id),
  });
  const sourceApi = apiFor(process.env.PRAXIS_PLATFORM_ARTIFACT_READ_TOKEN);
  const publicApi = apiFor(process.env.GH_TOKEN);
  // Notification is sent by the source run's final job. Wait only for that
  // exact run to close; all failures and timeouts remain explicit failures.
  for (let attempt = 0; attempt < 30; attempt++) {
    const run = await sourceApi(`repos/${sourceRepo}/actions/runs/${candidate.run_id}`);
    if (run.status === "completed") break;
    if (run.head_sha !== candidate.source_sha || run.path !== workflowPath ||
        run.head_repository?.full_name?.toLowerCase() !== sourceRepo.toLowerCase()) throw new Error("Untrusted pending source run");
    if (attempt === 29) throw new Error("Source run did not complete within five minutes");
    await delay(10_000);
  }
  const verified = await inspectCandidate(candidate, sourceApi);
  const environment = await publicApi(`repos/${publicRepo}/environments/plureslm-release`);
  const reviewerRequired = environment.protection_rules?.some((rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0) === true;
  // Probe the tag directly, not a bounded release list. Any pre-existing tag,
  // including one left by a partial publication, requires operator inspection.
  const existing = await releaseExists(candidate.tag, publicApi);
  const evidence = {
    trusted_workflow: true, successful_run: true, tag_matches_source: true, source_on_main: true, manifests_agree: true,
    exact_artifacts: true, exact_assets: false, checksums_verified: false, install_evidence_verified: false,
    reviewer_required: reviewerRequired, existing_release: existing,
  };
  if (!reviewerRequired || existing) throw new Error("Required reviewer missing or destination release tag already exists");
  const scratch = await mkdtemp(join(tmpdir(), "plureslm-publish-"));
  const directory = join(scratch, "assets");
  await mkdir(directory);
  try {
    for (const artifact of verified.artifacts) {
      const bytes = gh(["api", `repos/${sourceRepo}/actions/artifacts/${artifact.id}/zip`], process.env.PRAXIS_PLATFORM_ARTIFACT_READ_TOKEN, true);
      await unpackArtifact(bytes, artifact, directory, candidate, scratch);
    }
    const names = await verifyAssets(directory, candidate);
    // Revalidate the tag and source after downloading, before the first write.
    const latest = await inspectCandidate(candidate, sourceApi);
    if (!same(latest.artifacts.map((a) => [a.id, a.digest]), verified.artifacts.map((a) => [a.id, a.digest]))) {
      throw new Error("Source artifact identity changed during verification");
    }
    evaluatePublicationContract(await readFile(new URL("../release/publication.px", import.meta.url), "utf8"), {
      ...evidence, exact_assets: true, checksums_verified: true, install_evidence_verified: true,
    });
    if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && event.inputs?.verify_only === "true") {
      process.stdout.write(`${JSON.stringify({ event: "plureslm_release_verified_without_publication", tag: candidate.tag, run: candidate.run_id })}\n`);
      return;
    }
    const notes = `PluresLM ${candidate.version}

One product installation per OS/architecture; harnesses connect to the same broker.
Windows x64 MSI; Linux x64 DEB/RPM (glibc >= 2.39), plus supplemental developer tarballs.
Verify the matching SHA-256 before installation. Installers bundle Node and install offline.
Unsigned packages: checksums and build metadata are not code signatures.
Start/stop the per-user owner explicitly; client-config prints the service-only MCP configuration.
Automatic harness configuration and migration from legacy Scout installations are not implemented.
Do not run competing owners against the same store. Uninstall preserves memory and credentials.
No macOS, ARM64, npm-registry publication, or automatic startup is implied.

Source commit: ${candidate.source_sha}
Verified private build run: ${candidate.run_id}
The public tag labels distribution; it is not the private source commit.
`;
    gh(["release", "create", candidate.tag, ...names.map((name) => join(directory, name)),
      "--repo", publicRepo, "--target", process.env.GITHUB_SHA, "--draft", "--title", `PluresLM ${candidate.version}`,
      "--notes", notes, ...(candidate.version.includes("-") ? ["--prerelease"] : [])], process.env.GH_TOKEN);
    gh(["release", "edit", candidate.tag, "--repo", publicRepo, "--draft=false",
      ...(candidate.version.includes("-") ? [] : ["--latest"])], process.env.GH_TOKEN);
    process.stdout.write(`${JSON.stringify({ event: "plureslm_release_published", tag: candidate.tag, source: candidate.source_sha, run: candidate.run_id })}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "plureslm_publication_failed", error: error.message })}\n`);
    process.exitCode = 1;
  });
}
