/**
 * HTTP-based MCP client for pluresLM-mcp service.
 *
 * Connects to the pluresLM-mcp daemon via HTTP Streamable MCP transport
 * (SSE responses). Maintains a persistent session to avoid re-initializing
 * on every tool call.
 *
 * Session recovery across daemon restarts (#146): when the daemon restarts, the
 * persistent `mcp-session-id` it issued becomes invalid. Depending on timing
 * this surfaces either as a transport failure (connection refused / reset while
 * the daemon is down or coming back) or as a daemon-returned "Session not found"
 * error (daemon is back up but no longer recognizes our session). Both are
 * *recoverable*: we re-establish a fresh session and retry the interrupted op
 * exactly once. Genuine tool-side errors (validation failures, "memory not
 * found", …) are NOT session problems and are never retried — retrying them
 * would be wasteful and could double-execute a mutating op (e.g. `store`). If a
 * single recovery attempt still fails, a clear, user-facing
 * {@link DaemonUnavailableError} is surfaced and the shared health state (#150)
 * is marked degraded.
 *
 * Config (env vars):
 *   PLURESLM_MCP_URL   – base URL, default http://localhost:3100
 *   MCP_API_KEY         – API key for x-api-key header
 */

import {
  DaemonUnavailableError,
  type FailureKind,
  classifyError,
  recordFailure,
  recordSuccess,
  toUserFacingError,
  userFacingMessage,
} from "./health.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpSession {
  sessionId: string | null;
  initialized: boolean;
}

let session: McpSession = { sessionId: null, initialized: false };
let nextId = 1;
let initPromise: Promise<void> | null = null;

function getBaseUrl(): string {
  return (process.env.PLURESLM_MCP_URL ?? "http://localhost:3100").replace(/\/+$/, "");
}

function getApiKey(): string {
  return process.env.MCP_API_KEY ?? "";
}

function buildHeaders(sess: McpSession): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const key = getApiKey();
  if (key) h["x-api-key"] = key;
  if (sess.sessionId) h["mcp-session-id"] = sess.sessionId;
  return h;
}

/**
 * Send a JSON-RPC request and parse the SSE response.
 * Returns the parsed result from the first `event: message` data line.
 */
async function mcpPost(req: JsonRpcRequest, sess: McpSession): Promise<JsonRpcResponse> {
  const url = `${getBaseUrl()}/mcp`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(sess),
      body: JSON.stringify(req),
    });
  } catch (err) {
    // Transport-level failure (connection refused, DNS, abort/timeout): turn the
    // opaque `fetch failed`/`ECONNREFUSED` into a typed, user-facing error (#147)
    // and flag the daemon as degraded (#150).
    recordFailure(err);
    throw toUserFacingError(err);
  }

  if (!res.ok && res.status >= 500) {
    // 5xx from the daemon/proxy => treat as a (likely transient) protocol/
    // availability failure rather than a tool error.
    const kind = res.status === 503 ? "down" : "protocol";
    const text = await res.text().catch(() => "");
    const e = new DaemonUnavailableError(
      kind,
      userFacingMessage(kind, `HTTP ${res.status} ${truncate(text, 120)}`.trim()),
    );
    recordFailure(e);
    throw e;
  }

  // Capture session id from response header
  const sid = res.headers.get("mcp-session-id");
  if (sid) sess.sessionId = sid;

  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    // Parse SSE — we only need the first `data:` after `event: message`
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (payload) {
          return JSON.parse(payload) as JsonRpcResponse;
        }
      }
    }
    throw new Error(`No data line in SSE response: ${text.slice(0, 200)}`);
  }

  // Plain JSON response (error cases)
  const json = await res.json();

  // Handle non-JSONRPC errors (e.g. {"error":"Session not found"})
  if (json.error && typeof json.error === "string") {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code: -32000, message: json.error },
    };
  }

  return json as JsonRpcResponse;
}

async function ensureInitialized(): Promise<void> {
  if (session.initialized) return;

  // Prevent concurrent init races
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const initReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "plureslm-plugin-http", version: "1.0.0" },
      },
    };

    const resp = await mcpPost(initReq, session);
    if (resp.error) {
      throw new Error(`MCP init failed: ${resp.error.message}`);
    }

    // Send initialized notification (no id = notification)
    const notifyReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    };
    // Fire-and-forget notification
    await mcpPost(notifyReq, session).catch(() => {});

    session.initialized = true;
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Map stdio service tool names (lowercase) to MCP daemon tool names (camelCase).
 * Falls through unchanged if no mapping exists.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  // Core CRUD
  plureslm_store: "pluresLM_store",
  plureslm_search: "pluresLM_search",
  plureslm_search_text: "pluresLM_search_text",
  plureslm_forget: "pluresLM_forget",
  plureslm_list: "pluresLM_list",
  plureslm_get: "pluresLM_get",
  plureslm_update: "pluresLM_update",
  // Query & analytics
  plureslm_query_dsl: "pluresLM_query_dsl",
  plureslm_stats: "pluresLM_status",
  plureslm_status: "pluresLM_status",
  plureslm_health: "pluresLM_health",
  plureslm_profile: "pluresLM_profile",
  // Maintenance
  plureslm_consolidate: "pluresLM_consolidate",
  plureslm_find_stale: "pluresLM_find_stale",
  plureslm_world_state: "pluresLM_world_state",
  plureslm_daily_summary: "pluresLM_daily_summary",
  // Sync
  plureslm_sync_status: "pluresLM_sync_status",
  // Indexing
  plureslm_index: "pluresLM_index",
  // Graph & relationship tools
  plureslm_autolink: "pluresLM_autolink",
  plureslm_graph_neighbors: "pluresLM_graph_neighbors",
  plureslm_graph_insights: "pluresLM_graph_insights",
  // Packs & bundles
  plureslm_export_bundle: "pluresLM_export_bundle",
  plureslm_restore_bundle: "pluresLM_restore_bundle",
  plureslm_export_pack: "pluresLM_export_pack",
  plureslm_import_pack: "pluresLM_import_pack",
  plureslm_list_packs: "pluresLM_list_packs",
  plureslm_uninstall_pack: "pluresLM_uninstall_pack",
};

/**
 * Decide whether a failure from a daemon round-trip is a *session/connectivity*
 * problem that warrants re-establishing the session and retrying once (#146),
 * versus a genuine tool-side error that must be surfaced as-is.
 *
 * Recoverable (daemon restart / stale session):
 *   - transport failures classified as `down` / `timeout` / `protocol`
 *     (connection refused/reset, deadline, malformed handshake mid-restart);
 *   - an explicit daemon "session not found" / "session expired" /
 *     "no valid session" response (daemon is back up but dropped our session).
 *
 * NOT recoverable (do not retry — would waste work / risk double-execution):
 *   - `tool-error` and `config` kinds, and any other daemon-acknowledged error.
 */
export function isSessionRecoverable(err: unknown): boolean {
  const kind: FailureKind =
    err instanceof DaemonUnavailableError ? err.kind : classifyError(err);

  if (kind === "down" || kind === "timeout" || kind === "protocol") return true;
  if (kind === "config") return false;

  // `tool-error` (or anything else): only recover if the daemon explicitly told
  // us the session is gone/invalid (a restarted-but-up daemon).
  return isSessionInvalidationMessage(errMessage(err));
}

function isSessionInvalidationMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("session not found") ||
    m.includes("session expired") ||
    m.includes("no valid session") ||
    m.includes("unknown session") ||
    m.includes("invalid session") ||
    m.includes("session id required") ||
    m.includes("missing session")
  );
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "");
  }
  return String(err ?? "");
}

/**
 * Perform a single tool round-trip with the current session: ensure the session
 * is initialized, send the request, and return the extracted text. A
 * daemon-returned `resp.error` is thrown (so the caller's recovery logic can
 * inspect it) — a session-invalidation error is thrown verbatim so
 * {@link isSessionRecoverable} can detect it; a genuine tool error is thrown as
 * an `MCP service error …` (a `tool-error` per {@link classifyError}).
 */
async function callToolOnce(req: JsonRpcRequest): Promise<string> {
  await ensureInitialized();
  const resp = await mcpPost(req, session);
  if (resp.error) {
    throw new Error(`MCP service error ${resp.error.code}: ${resp.error.message}`);
  }
  return extractText(resp);
}

/**
 * Run a tool call with session recovery across daemon restarts (#146).
 *
 * 1. Attempt the call on the existing session.
 * 2. If it fails with a *recoverable* (session/connectivity) error, reset the
 *    session, re-initialize, and retry the SAME logical operation exactly once.
 * 3. On success (first try or after recovery) record a health success (#150).
 * 4. If the single retry also fails — or the original failure was not
 *    recoverable — record the failure and surface a clear, typed error.
 *
 * Genuine tool-side errors are never retried and are re-thrown unchanged.
 *
 * @param build constructs a fresh request (with a new id) for each attempt, so
 *              the retry is a clean, idempotent re-send rather than a replay of
 *              a request whose id was already consumed.
 */
async function callWithSessionRecovery(build: () => JsonRpcRequest): Promise<unknown> {
  try {
    const out = await callToolOnce(build());
    recordSuccess();
    return out;
  } catch (firstErr) {
    if (!isSessionRecoverable(firstErr)) {
      // Genuine tool-error (daemon healthy) — do not reset/retry. Tool errors
      // are passed through unchanged; the daemon is reachable so health is not
      // marked degraded here (recordFailure treats tool-error as non-degrading).
      recordFailure(firstErr);
      throw firstErr;
    }

    // Recoverable: the session is stale/dead (daemon restarted) or the daemon is
    // briefly unreachable. Re-establish a fresh session and retry exactly once.
    resetMcpSession();
    try {
      const out = await callToolOnce(build());
      recordSuccess();
      return out;
    } catch (secondErr) {
      // Recovery failed: surface a clear, user-facing error and mark degraded.
      recordFailure(secondErr);
      if (secondErr instanceof DaemonUnavailableError) throw secondErr;
      const kind = classifyError(secondErr);
      const detail = `session recovery failed: ${errMessage(secondErr)}`;
      throw new DaemonUnavailableError(
        kind === "tool-error" ? "protocol" : kind,
        userFacingMessage(kind === "tool-error" ? "protocol" : kind, detail),
        secondErr,
      );
    }
  }
}

/**
 * Call a tool on the pluresLM-mcp service via HTTP.
 * Drop-in replacement for the stdio-based `callPluresLMServiceTool`.
 */
export async function callPluresLMServiceToolHttp(
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const mappedName = TOOL_NAME_MAP[name] ?? name;
  // A fresh request (new id) is built for each attempt so a recovery retry is a
  // clean re-send, not a replay of an already-consumed id.
  const build = (): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name: mappedName, arguments: args },
  });

  try {
    return await callWithSessionRecovery(build);
  } catch (err) {
    // callWithSessionRecovery already recorded health and produced a typed
    // error for recoverable failures. For anything still untyped (e.g. an abort
    // fired by our own timeout that slipped through), classify + record here so
    // the shared health state and the caller-facing error stay consistent
    // (#147 / #150).
    if (!(err instanceof DaemonUnavailableError)) {
      const kind = classifyError(err);
      if (kind !== "tool-error") {
        recordFailure(err);
        throw toUserFacingError(err);
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Lightweight active health probe (#150). Performs a real daemon round-trip via
 * the cheapest available tool and folds the outcome into the shared health
 * state. Returns the parsed health/status payload on success.
 */
export async function probeDaemonHealth(timeoutMs = 5000): Promise<unknown> {
  // pluresLM_health is preferred; the tool-name map aliases it to the daemon's
  // camelCase name. Falls back to status if health is unimplemented daemon-side.
  try {
    return await callPluresLMServiceToolHttp("plureslm_health", {}, timeoutMs);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) throw err;
    return await callPluresLMServiceToolHttp("plureslm_status", {}, timeoutMs);
  }
}

type TextContentBlock = { type: "text"; text?: string };

type RpcResultWithContent = {
  content?: unknown;
};

function isTextContentBlock(value: unknown): value is TextContentBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as { type?: unknown; text?: unknown };
  return block.type === "text" && (block.text === undefined || typeof block.text === "string");
}

function extractText(resp: JsonRpcResponse): string {
  const result = resp.result;
  if (!result || typeof result !== "object") return JSON.stringify(result ?? "");

  const { content } = result as RpcResultWithContent;
  if (Array.isArray(content) && content.length > 0 && isTextContentBlock(content[0])) {
    return String(content[0].text ?? "");
  }
  return JSON.stringify(result ?? "");
}

/**
 * Reset session state (e.g. if the MCP server restarts).
 */
export function resetMcpSession(): void {
  session = { sessionId: null, initialized: false };
}
