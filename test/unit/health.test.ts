import { describe, it, expect, beforeEach } from "vitest";
import {
  DaemonUnavailableError,
  classifyError,
  userFacingMessage,
  toUserFacingError,
  getHealthState,
  isDegraded,
  recordSuccess,
  recordFailure,
  resetHealthState,
  probeHealth,
} from "../../src/health.js";

const ORIG_URL = process.env.PLURESLM_MCP_URL;

beforeEach(() => {
  resetHealthState();
  process.env.PLURESLM_MCP_URL = "http://localhost:3100";
});

function err(message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), extra);
}

describe("classifyError", () => {
  it("classifies connection-refused as down", () => {
    expect(classifyError(err("connect ECONNREFUSED 127.0.0.1:3100"))).toBe("down");
    expect(classifyError(err("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe("down");
    expect(classifyError(err("getaddrinfo ENOTFOUND localhost"))).toBe("down");
    expect(classifyError(err("socket hang up"))).toBe("down");
  });

  it("classifies aborts and deadline messages as timeout", () => {
    const abort = err("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyError(abort)).toBe("timeout");
    expect(classifyError(err("request timed out after 15s"))).toBe("timeout");
    expect(classifyError(err("boom", { code: "ETIMEDOUT" }))).toBe("timeout");
  });

  it("classifies malformed MCP responses as protocol", () => {
    expect(classifyError(err("No data line in SSE response: <html>"))).toBe("protocol");
    expect(classifyError(err("MCP init failed: bad handshake"))).toBe("protocol");
    expect(classifyError(err("Unexpected token < in JSON at position 0"))).toBe("protocol");
  });

  it("defaults to tool-error for daemon-side failures", () => {
    expect(classifyError(err("MCP service error -32000: memory not found"))).toBe("tool-error");
    expect(classifyError(err("validation failed: category required"))).toBe("tool-error");
  });

  it("preserves the kind of an existing DaemonUnavailableError", () => {
    const e = new DaemonUnavailableError("down", "x");
    expect(classifyError(e)).toBe("down");
  });
});

describe("userFacingMessage", () => {
  it("includes the configured URL and is actionable for down", () => {
    process.env.PLURESLM_MCP_URL = "http://127.0.0.1:9999";
    const msg = userFacingMessage("down");
    expect(msg).toContain("http://127.0.0.1:9999");
    expect(msg.toLowerCase()).toContain("not responding");
    expect(msg).toContain("PLURESLM_MCP_URL");
  });

  it("never leaks raw socket noise but can append a short detail", () => {
    const msg = userFacingMessage("timeout", "aborted");
    expect(msg.toLowerCase()).toContain("timed out");
    expect(msg).toContain("(aborted)");
  });

  it("gives a config-specific message", () => {
    expect(userFacingMessage("config").toLowerCase()).toContain("not configured");
  });
});

describe("toUserFacingError", () => {
  it("wraps transport failures in DaemonUnavailableError", () => {
    const out = toUserFacingError(err("connect ECONNREFUSED 127.0.0.1:3100"));
    expect(out).toBeInstanceOf(DaemonUnavailableError);
    expect((out as DaemonUnavailableError).kind).toBe("down");
    expect((out as DaemonUnavailableError).userMessage.toLowerCase()).toContain("unavailable");
  });

  it("passes genuine tool errors through unchanged", () => {
    const original = err("MCP service error -32000: not found");
    expect(toUserFacingError(original)).toBe(original);
  });
});

describe("degraded-mode state machine", () => {
  it("starts unknown, not degraded", () => {
    expect(getHealthState().status).toBe("unknown");
    expect(isDegraded()).toBe(false);
  });

  it("transport failure flips to degraded and counts consecutively", () => {
    recordFailure(err("fetch failed", { cause: { code: "ECONNREFUSED" } }), 1000);
    expect(isDegraded()).toBe(true);
    let s = getHealthState();
    expect(s.status).toBe("degraded");
    expect(s.lastFailureKind).toBe("down");
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastFailAt).toBe(1000);

    recordFailure(err("request timed out"), 2000);
    s = getHealthState();
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastFailureKind).toBe("timeout");
  });

  it("tool errors do NOT flip the connection to degraded", () => {
    const kind = recordFailure(err("MCP service error -32000: not found"));
    expect(kind).toBe("tool-error");
    expect(isDegraded()).toBe(false);
    expect(getHealthState().consecutiveFailures).toBe(0);
  });

  it("a success clears degraded state and resets the counter", () => {
    recordFailure(err("connect ECONNREFUSED"), 1000);
    expect(isDegraded()).toBe(true);
    recordSuccess(3000);
    const s = getHealthState();
    expect(s.status).toBe("healthy");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastFailureKind).toBeUndefined();
    expect(s.lastOkAt).toBe(3000);
    expect(s.reason).toBe("recovered");
    expect(isDegraded()).toBe(false);
  });
});

describe("probeHealth", () => {
  it("records success on a healthy round-trip", async () => {
    let t = 100;
    const now = () => (t += 10);
    const res = await probeHealth(async () => ({ ok: true }), now);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("healthy");
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(getHealthState().status).toBe("healthy");
  });

  it("records degraded on a transport failure and returns an actionable message", async () => {
    const res = await probeHealth(async () => {
      throw err("connect ECONNREFUSED 127.0.0.1:3100");
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("degraded");
    expect(res.kind).toBe("down");
    expect(res.message.toLowerCase()).toContain("not responding");
    expect(isDegraded()).toBe(true);
  });

  it("does not mark degraded when the health tool itself errors (daemon reachable)", async () => {
    const res = await probeHealth(async () => {
      throw err("MCP service error -32601: method not found");
    });
    // Daemon answered (tool-error) => connection considered healthy for liveness.
    expect(res.kind).toBe("tool-error");
    expect(res.status).toBe("healthy");
    expect(isDegraded()).toBe(false);
  });
});

if (ORIG_URL === undefined) {
  delete process.env.PLURESLM_MCP_URL;
} else {
  process.env.PLURESLM_MCP_URL = ORIG_URL;
}
