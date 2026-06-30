/**
 * Session recovery across MCP daemon restarts (#146).
 *
 * These tests exercise the REAL recovery path inside the HTTP MCP client by
 * stubbing the global `fetch` to faithfully simulate a daemon round-trip at the
 * JSON-RPC / SSE protocol level — including the two ways a daemon restart shows
 * up to a client:
 *
 *   1. Transport failure: the daemon is down / coming back, so the socket is
 *      refused or reset (`ECONNREFUSED` / `fetch failed`).
 *   2. "Session not found": the daemon is back up but no longer recognizes the
 *      persistent `mcp-session-id` it issued before the restart, so it answers
 *      with a plain-JSON `{"error":"Session not found"}`.
 *
 * Both must recover: re-establish a fresh session and retry the interrupted op
 * exactly once. A genuine tool-side error must NOT be retried. A recovery that
 * still fails must surface a clear, typed `DaemonUnavailableError` and mark the
 * shared health state degraded.
 *
 * C-TEST-002: no channel adapter is involved — the core
 * `callPluresLMServiceToolHttp` path is driven directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  callPluresLMServiceToolHttp,
  resetMcpSession,
  isSessionRecoverable,
} from "../../src/http-service-client.js";
import {
  DaemonUnavailableError,
  getHealthState,
  isDegraded,
  resetHealthState,
} from "../../src/health.js";

const ORIG_URL = process.env.PLURESLM_MCP_URL;
const ORIG_KEY = process.env.MCP_API_KEY;

// ---------------------------------------------------------------------------
// A minimal, faithful fake of the pluresLM-mcp HTTP daemon.
//
// It speaks the same wire shapes the real client parses: an SSE body with a
// `data: <json-rpc>` line for successful calls, and a plain-JSON error body for
// the "Session not found" case. It can be scripted per-call so a test can model
// a restart (fail/expire on the first attempt, succeed after the client
// re-initializes a fresh session).
// ---------------------------------------------------------------------------

type DaemonStep =
  | { kind: "down" } // socket refused/reset (daemon not reachable)
  | { kind: "session-not-found" } // daemon up, our session is stale
  | { kind: "tool-error"; code: number; message: string }
  | { kind: "ok"; text: string }; // successful tool result

/**
 * Build a fetch stub that walks `steps` for `tools/call` requests, while always
 * answering `initialize` + `notifications/initialized` successfully (issuing a
 * fresh session id each time the client re-initializes). Returns the stub plus
 * counters the tests assert on.
 */
function makeDaemon(steps: DaemonStep[]) {
  let toolCallIndex = 0;
  let sessionSeq = 0;
  const counters = { initialize: 0, toolCalls: 0 };

  const sse = (body: unknown, sessionId: string): Response =>
    new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "mcp-session-id": sessionId,
      },
    });

  const stub = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method: string;
      };

      if (req.method === "initialize") {
        counters.initialize += 1;
        sessionSeq += 1;
        return sse(
          { jsonrpc: "2.0", id: req.id ?? null, result: { protocolVersion: "2025-03-26" } },
          `sess-${sessionSeq}`,
        );
      }

      if (req.method === "notifications/initialized") {
        // Fire-and-forget notification; any 2xx is fine.
        return sse({ jsonrpc: "2.0", result: {} }, `sess-${sessionSeq}`);
      }

      if (req.method === "tools/call") {
        counters.toolCalls += 1;
        const step = steps[Math.min(toolCallIndex, steps.length - 1)];
        toolCallIndex += 1;
        const sid = `sess-${sessionSeq || 1}`;
        switch (step.kind) {
          case "down": {
            // Transport-level failure — fetch itself rejects.
            const e = new Error("fetch failed");
            (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
            throw e;
          }
          case "session-not-found":
            // Daemon is up but dropped our session: plain-JSON string error,
            // exactly as the real daemon emits it after a restart.
            return new Response(JSON.stringify({ error: "Session not found" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          case "tool-error":
            return sse(
              {
                jsonrpc: "2.0",
                id: req.id ?? null,
                error: { code: step.code, message: step.message },
              },
              sid,
            );
          case "ok":
            return sse(
              {
                jsonrpc: "2.0",
                id: req.id ?? null,
                result: { content: [{ type: "text", text: step.text }] },
              },
              sid,
            );
        }
      }

      throw new Error(`unexpected method ${req.method}`);
    },
  );

  return { stub, counters };
}

beforeEach(() => {
  process.env.PLURESLM_MCP_URL = "http://localhost:3100";
  delete process.env.MCP_API_KEY;
  resetMcpSession();
  resetHealthState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isSessionRecoverable — the classification boundary that decides retry vs not
// ---------------------------------------------------------------------------

describe("isSessionRecoverable", () => {
  it("treats transport down / timeout / protocol failures as recoverable", () => {
    const down = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(isSessionRecoverable(down)).toBe(true);

    const timeout = Object.assign(new Error("request timed out"), {});
    expect(isSessionRecoverable(timeout)).toBe(true);

    expect(isSessionRecoverable(new Error("No data line in SSE response: <html>"))).toBe(true);
    expect(isSessionRecoverable(new DaemonUnavailableError("down", "x"))).toBe(true);
  });

  it("treats an explicit session-invalidation error as recoverable", () => {
    expect(isSessionRecoverable(new Error("MCP service error -32000: Session not found"))).toBe(
      true,
    );
    expect(isSessionRecoverable(new Error("session expired"))).toBe(true);
    expect(isSessionRecoverable(new Error("no valid session for request"))).toBe(true);
  });

  it("does NOT treat a genuine tool error as recoverable", () => {
    expect(isSessionRecoverable(new Error("MCP service error -32000: memory not found"))).toBe(
      false,
    );
    expect(isSessionRecoverable(new Error("validation failed: category required"))).toBe(false);
    expect(isSessionRecoverable(new DaemonUnavailableError("config", "x"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end recovery through the real callPluresLMServiceToolHttp path
// ---------------------------------------------------------------------------

describe("session recovery across a daemon restart", () => {
  it("recovers from a transport drop (daemon restart) and retries the op exactly once", async () => {
    // First tool call: socket refused (daemon mid-restart). Recovery re-inits a
    // fresh session and the retry succeeds.
    const { stub, counters } = makeDaemon([{ kind: "down" }, { kind: "ok", text: "recovered-1" }]);
    vi.stubGlobal("fetch", stub);

    const out = await callPluresLMServiceToolHttp("plureslm_search", { query: "x" });

    expect(out).toBe("recovered-1");
    // Exactly two tool-call attempts: the failed one + the single retry.
    expect(counters.toolCalls).toBe(2);
    // The client re-initialized a brand-new session for the retry.
    expect(counters.initialize).toBe(2);
    // Health rolled back to healthy after the successful recovery.
    expect(getHealthState().status).toBe("healthy");
    expect(isDegraded()).toBe(false);
  });

  it('recovers from a "Session not found" (restarted-but-up daemon) and retries once', async () => {
    const { stub, counters } = makeDaemon([
      { kind: "session-not-found" },
      { kind: "ok", text: "recovered-2" },
    ]);
    vi.stubGlobal("fetch", stub);

    const out = await callPluresLMServiceToolHttp("plureslm_get", { id: "m1" });

    expect(out).toBe("recovered-2");
    expect(counters.toolCalls).toBe(2);
    expect(counters.initialize).toBe(2);
    expect(isDegraded()).toBe(false);
  });

  it("retries at most once — a persistent outage surfaces a clear DaemonUnavailableError", async () => {
    // Every tool attempt fails at the transport level: the single retry is not
    // enough, so recovery fails.
    const { stub, counters } = makeDaemon([{ kind: "down" }]);
    vi.stubGlobal("fetch", stub);

    await expect(
      callPluresLMServiceToolHttp("plureslm_search", { query: "x" }),
    ).rejects.toBeInstanceOf(DaemonUnavailableError);

    // Bounded recovery: the original attempt + exactly one retry == 2. Never more.
    expect(counters.toolCalls).toBe(2);
    expect(isDegraded()).toBe(true);
    expect(getHealthState().lastFailureKind).toBe("down");
  });

  it("surfaces an actionable, non-leaky message when recovery fails", async () => {
    const { stub } = makeDaemon([{ kind: "down" }]);
    vi.stubGlobal("fetch", stub);

    let caught: unknown;
    try {
      await callPluresLMServiceToolHttp("plureslm_search", { query: "x" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DaemonUnavailableError);
    const msg = (caught as DaemonUnavailableError).userMessage;
    expect(msg.toLowerCase()).toContain("not responding");
    expect(msg).toContain("http://localhost:3100");
    // No raw socket noise leaked to the user-facing message.
    expect(msg).not.toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Genuine tool errors must NOT trigger a session reset / retry
// ---------------------------------------------------------------------------

describe("genuine tool errors are not session problems", () => {
  it("passes a tool error through unchanged without retrying or resetting the session", async () => {
    // One successful init, then a single tool-call that returns a tool error.
    // No recovery should happen: exactly ONE tool-call attempt, ONE init.
    const { stub, counters } = makeDaemon([
      { kind: "tool-error", code: -32000, message: "memory not found" },
    ]);
    vi.stubGlobal("fetch", stub);

    await expect(callPluresLMServiceToolHttp("plureslm_get", { id: "missing" })).rejects.toThrow(
      /memory not found/,
    );

    // No retry — the failed call is the only tool-call attempt.
    expect(counters.toolCalls).toBe(1);
    // The session was never reset/re-initialized for a tool error.
    expect(counters.initialize).toBe(1);
    // Daemon answered, so the connection is NOT marked degraded.
    expect(isDegraded()).toBe(false);
  });

  it("does not double-execute a mutating op on a tool error", async () => {
    // A store that the daemon rejects with a validation error must be attempted
    // exactly once — retrying could create a duplicate memory.
    const { stub, counters } = makeDaemon([
      { kind: "tool-error", code: -32602, message: "validation failed: content required" },
    ]);
    vi.stubGlobal("fetch", stub);

    await expect(
      callPluresLMServiceToolHttp("plureslm_store", { category: "decision" }),
    ).rejects.toThrow(/validation failed/);

    expect(counters.toolCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A clean, single-session happy path still works (no regression)
// ---------------------------------------------------------------------------

describe("no-restart happy path", () => {
  it("returns the tool result with a single session and no extra init", async () => {
    const { stub, counters } = makeDaemon([{ kind: "ok", text: "hello" }]);
    vi.stubGlobal("fetch", stub);

    const out = await callPluresLMServiceToolHttp("plureslm_search", { query: "x" });

    expect(out).toBe("hello");
    expect(counters.toolCalls).toBe(1);
    expect(counters.initialize).toBe(1);
    expect(getHealthState().status).toBe("healthy");
  });
});

if (ORIG_URL === undefined) {
  delete process.env.PLURESLM_MCP_URL;
} else {
  process.env.PLURESLM_MCP_URL = ORIG_URL;
}
if (ORIG_KEY === undefined) {
  delete process.env.MCP_API_KEY;
} else {
  process.env.MCP_API_KEY = ORIG_KEY;
}
