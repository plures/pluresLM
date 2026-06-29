/**
 * Daemon health & degraded-mode state (Phase 1 — Reliability & Trust v2.5).
 *
 * Single source of truth for whether the pluresLM-mcp daemon is reachable, and
 * the bridge that turns opaque transport failures (`fetch failed`,
 * `ECONNREFUSED`, abort timeouts) into clear, user-facing, actionable error
 * messages.
 *
 * Implements:
 *   - #147 Clear user-facing error states when daemon unavailable
 *   - #150 Health checks for connectivity and degraded-mode behavior
 *
 * Design: pure, dependency-free, in-process. No DB, no network primitives of
 * its own beyond an injected probe — so it is trivially unit-testable and never
 * itself becomes a reason the memory layer is unavailable.
 */

/** How a memory operation failed, from the caller's point of view. */
export type FailureKind =
  | "down" // cannot reach the daemon at all (connection refused / DNS / network)
  | "timeout" // reached (or tried to reach) but exceeded the deadline
  | "protocol" // reached, but the MCP handshake/response was malformed
  | "config" // misconfiguration (e.g. PLURESLM_MCP_URL unset) — actionable by the user
  | "tool-error"; // daemon is healthy but the specific tool returned an error

/** Liveness classification for the daemon connection. */
export type HealthStatus = "healthy" | "degraded" | "unknown";

export interface HealthState {
  status: HealthStatus;
  /** Last failure kind observed, if currently degraded. */
  lastFailureKind?: FailureKind;
  /** Human-readable reason for the current status. */
  reason?: string;
  /** Epoch ms of the last successful daemon round-trip. */
  lastOkAt?: number;
  /** Epoch ms of the last observed failure. */
  lastFailAt?: number;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
}

/**
 * Error thrown when a memory operation cannot be served because the daemon is
 * unreachable, timed out, misconfigured, or spoke an unexpected protocol.
 *
 * The `message` is intentionally user-facing and actionable — callers can
 * surface it directly without leaking raw `fetch failed`/`ECONNREFUSED` noise.
 */
export class DaemonUnavailableError extends Error {
  readonly kind: FailureKind;
  readonly userMessage: string;
  readonly cause?: unknown;

  constructor(kind: FailureKind, userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = "DaemonUnavailableError";
    this.kind = kind;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

const DEFAULT_BASE_URL = "http://localhost:3100";

function baseUrl(): string {
  return (process.env.PLURESLM_MCP_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Classify a raw thrown value (from fetch / abort / JSON parse) into a
 * {@link FailureKind}. Conservative: anything we cannot positively identify as a
 * transport/connectivity failure is treated as a `tool-error` so we never
 * mislabel a genuine daemon-side error as "daemon down".
 */
export function classifyError(err: unknown): FailureKind {
  if (err instanceof DaemonUnavailableError) return err.kind;

  // AbortController-driven timeout.
  if (isAbortError(err)) return "timeout";

  const msg = errorMessage(err).toLowerCase();
  const code = errorCode(err).toLowerCase();

  // Connection-level failures => daemon is down / unreachable.
  const downSignals = [
    "econnrefused",
    "econnreset",
    "enotfound",
    "eai_again",
    "ehostunreach",
    "enetunreach",
    "fetch failed",
    "failed to fetch",
    "connect econnrefused",
    "socket hang up",
    "network error",
  ];
  if (downSignals.some((s) => msg.includes(s) || code.includes(s))) return "down";

  // Deadline signals.
  if (msg.includes("timed out") || msg.includes("timeout") || code.includes("etimedout")) {
    return "timeout";
  }

  // Malformed MCP responses surfaced by the transport.
  if (
    msg.includes("no data line in sse") ||
    msg.includes("mcp init failed") ||
    msg.includes("unexpected token") ||
    msg.includes("is not valid json")
  ) {
    return "protocol";
  }

  return "tool-error";
}

/**
 * Build a clear, actionable, user-facing message for a failure kind (#147).
 * Never includes stack traces or raw socket errors — just what happened and
 * what the user can do about it.
 */
export function userFacingMessage(kind: FailureKind, detail?: string): string {
  const url = baseUrl();
  const suffix = detail ? ` (${truncate(detail, 160)})` : "";
  switch (kind) {
    case "down":
      return (
        `Memory is unavailable: the pluresLM daemon at ${url} is not responding. ` +
        `Start it (e.g. \`pluresLM-mcp\` / your service manager) or set PLURESLM_MCP_URL to the correct address, then retry.${suffix}`
      );
    case "timeout":
      return (
        `Memory request timed out talking to the pluresLM daemon at ${url}. ` +
        `The daemon may be overloaded or mid-restart — retry shortly; if it persists, check the daemon logs.${suffix}`
      );
    case "protocol":
      return (
        `Memory is degraded: the pluresLM daemon at ${url} returned an unexpected (non-MCP) response. ` +
        `This usually means a version mismatch or the daemon is still starting up. Restart the daemon and retry.${suffix}`
      );
    case "config":
      return (
        `Memory is not configured: PLURESLM_MCP_URL is not set. ` +
        `Point it at the pluresLM-mcp daemon (default ${DEFAULT_BASE_URL}) and reload.${suffix}`
      );
    case "tool-error":
    default:
      return `Memory operation failed${suffix}.`;
  }
}

/**
 * Convert any thrown value from a service call into a typed, user-facing error.
 * Transport/connectivity/protocol failures become {@link DaemonUnavailableError};
 * genuine tool-side errors are passed through unchanged so callers can handle
 * them on their own terms.
 */
export function toUserFacingError(err: unknown): unknown {
  const kind = classifyError(err);
  if (kind === "tool-error") return err;
  return new DaemonUnavailableError(kind, userFacingMessage(kind, errorMessage(err)), err);
}

// ---------------------------------------------------------------------------
// Health-state singleton (degraded-mode tracking) — #150
// ---------------------------------------------------------------------------

const state: HealthState = {
  status: "unknown",
  consecutiveFailures: 0,
};

/** Snapshot of the current health state (defensive copy). */
export function getHealthState(): HealthState {
  return { ...state };
}

/** True when the daemon is currently considered unusable. */
export function isDegraded(): boolean {
  return state.status === "degraded";
}

/** Record a successful daemon round-trip; clears any degraded state. */
export function recordSuccess(now: number = Date.now()): void {
  const wasDegraded = state.status === "degraded";
  state.status = "healthy";
  state.lastOkAt = now;
  state.consecutiveFailures = 0;
  state.lastFailureKind = undefined;
  state.reason = wasDegraded ? "recovered" : undefined;
}

/**
 * Record a failure. A genuine `tool-error` does NOT flip the connection to
 * degraded (the daemon answered) — only transport/protocol/config failures do.
 * Returns the resolved {@link FailureKind}.
 */
export function recordFailure(err: unknown, now: number = Date.now()): FailureKind {
  const kind = err instanceof DaemonUnavailableError ? err.kind : classifyError(err);
  state.lastFailAt = now;

  if (kind === "tool-error") {
    // Daemon is reachable; do not mark the connection degraded.
    return kind;
  }

  state.consecutiveFailures += 1;
  state.status = "degraded";
  state.lastFailureKind = kind;
  state.reason = userFacingMessage(kind);
  return kind;
}

/** Reset health tracking to its initial unknown state (test/teardown helper). */
export function resetHealthState(): void {
  state.status = "unknown";
  state.consecutiveFailures = 0;
  state.lastFailureKind = undefined;
  state.reason = undefined;
  state.lastOkAt = undefined;
  state.lastFailAt = undefined;
}

// ---------------------------------------------------------------------------
// Active probe — #150
// ---------------------------------------------------------------------------

export interface ProbeResult {
  ok: boolean;
  status: HealthStatus;
  kind?: FailureKind;
  url: string;
  latencyMs: number;
  message: string;
}

/**
 * Actively probe daemon connectivity by calling an injected health caller and
 * fold the outcome into the shared health state. The caller is injected (rather
 * than importing the HTTP client) to avoid a circular dependency and to keep
 * this module pure and unit-testable.
 *
 * @param healthCall a function that performs a lightweight daemon round-trip
 *                   (typically the `pluresLM_health`/`pluresLM_status` tool).
 */
export async function probeHealth(
  healthCall: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const url = baseUrl();

  if (!process.env.PLURESLM_MCP_URL) {
    // Not strictly fatal (a default URL is used), but surface it as actionable.
    // We still attempt the probe against the default below; only flag config
    // if the probe also fails.
  }

  const start = now();
  try {
    await healthCall();
    recordSuccess(now());
    return {
      ok: true,
      status: "healthy",
      url,
      latencyMs: now() - start,
      message: `pluresLM daemon healthy at ${url}`,
    };
  } catch (err) {
    const kind = recordFailure(err, now());
    return {
      ok: false,
      status: kind === "tool-error" ? "healthy" : "degraded",
      kind,
      url,
      latencyMs: now() - start,
      message: userFacingMessage(kind, errorMessage(err)),
    };
  }
}

// ---------------------------------------------------------------------------
// small internal helpers
// ---------------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "");
  }
  return String(err ?? "");
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown; cause?: unknown }).code;
    if (c != null) return String(c);
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      return String((cause as { code?: unknown }).code ?? "");
    }
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
