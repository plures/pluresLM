#!/usr/bin/env node
/**
 * MCP smoke test — verifies the plureslm-mcp stdio server starts,
 * completes initialize, and exposes expected tools.
 *
 * Usage: node scripts/mcp-smoke.mjs [--ci]
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "dist", "mcp-server.js");
const TIMEOUT_MS = 20_000;

const EXPECTED_TOOLS = [
  "plureslm_store",
  "plureslm_list",
  "plureslm_search_text",
  "plureslm_query_dsl",
  "plureslm_world_state",
  "plureslm_health",
  "plureslm_stats",
];

const tmpDb = mkdtempSync(resolve(tmpdir(), "plureslm-smoke-"));
const proc = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    OPENCLAW_SERVICE_KIND: "test",
    PLURESLM_DB_PATH: tmpDb,
  },
});

let stdout = "";
let stderr = "";
let buffer = "";
let nextId = 1;

function send(method, params = {}, withId = true) {
  const msg = withId
    ? { jsonrpc: "2.0", id: nextId++, method, params }
    : { jsonrpc: "2.0", method, params };
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

function cleanup(code) {
  clearTimeout(timer);
  clearInterval(poll);
  try { proc.kill(); } catch {}
  try { rmSync(tmpDb, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

function parseJsonLines(chunk) {
  buffer += chunk;
  const out = [];
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue; // ignore backend logs
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

const timer = setTimeout(() => {
  console.error("FAIL: timed out waiting for MCP responses");
  if (stderr.trim()) console.error("stderr:", stderr.trim());
  cleanup(1);
}, TIMEOUT_MS);

proc.on("error", (err) => {
  console.error("FAIL: could not start server:", err.message);
  cleanup(1);
});

proc.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`FAIL: server exited with code ${code}`);
    if (stderr.trim()) console.error("stderr:", stderr.trim());
    cleanup(1);
  }
});

proc.stderr.on("data", (d) => { stderr += d.toString(); });
proc.stdout.on("data", (d) => { stdout += d.toString(); });

send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-smoke", version: "1.0.0" },
});
send("notifications/initialized", {}, false);
send("tools/list", {});

let initResult = null;
let toolsResult = null;
let triedLegacyListTools = false;

const poll = setInterval(() => {
  const msgs = parseJsonLines(stdout);
  stdout = "";

  for (const m of msgs) {
    if (m?.result?.serverInfo) initResult = m;
    if (Array.isArray(m?.result?.tools)) toolsResult = m;
  }

  if (initResult && !toolsResult && !triedLegacyListTools) {
    triedLegacyListTools = true;
    send("list_tools", {});
  }

  if (!initResult || !toolsResult) return;

  const info = initResult.result.serverInfo;
  if (!["plureslm-service", "plureslm-mcp"].includes(info.name)) {
    console.error(`FAIL: unexpected server name: ${info.name}`);
    cleanup(1);
    return;
  }

  const toolNames = toolsResult.result.tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !toolNames.includes(t));

  if (missing.length) {
    console.error(`FAIL: missing tools: ${missing.join(", ")}`);
    cleanup(1);
    return;
  }

  console.log(`PASS: server=\"${info.name}\" v${info.version}`);
  console.log(`PASS: ${toolNames.length} tools: ${toolNames.join(", ")}`);
  cleanup(0);
}, 100);
