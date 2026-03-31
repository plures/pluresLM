/**
 * Decision-Ledger Analysis Worker
 *
 * Background analysis side-process that consumes captured praxis primitives
 * and persists analysis artifacts via the PluresLM MCP service.
 *
 * Design goals:
 * - Non-blocking: analysis is enqueued and processed after the capture path
 *   completes, so the agent_end handler is never delayed.
 * - Deterministic error state: any analysis failure is caught and stored as an
 *   `analysis.error`-tagged analysis artifact (via the configured
 *   `analysis-artifact` category) so the failure is always observable.
 * - Linkable artifacts: every artifact carries the `sourceIds` of the
 *   primitives it was derived from.
 */

import { PraxisRegistry, createPraxisEngine } from "@plures/praxis";
import {
  analysisCoprocessorModule,
  defaultAnalysisContext,
  ANALYSIS_FACTS,
  type AnalysisPrimitive,
  type AnalysisContext,
} from "./praxis/analysis-coprocessor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A batch of primitives to analyze, tagged with a session identifier. */
export interface AnalysisBatch {
  /** Unique identifier for this analysis run — links artifacts to their source turn. */
  sessionId: string;
  /** Pre-computed objective alignment score [0, 1] for this batch. */
  objectiveAlignmentScore: number;
  /** True when at least one risk primitive is linked to an objective/decision. */
  hasLinkedRisk: boolean;
  /** Primitives extracted from the turn. */
  primitives: AnalysisPrimitive[];
}

/** Shape of a stored analysis artifact. */
export interface AnalysisArtifact {
  /** The Praxis fact tag that generated this artifact. */
  factTag: string;
  /** Human-readable summary of the artifact. */
  summary: string;
  /** IDs of the source primitives that produced this artifact. */
  sourceIds: string[];
  /** The full fact payload for programmatic consumers. */
  payload: Record<string, unknown>;
  /** Analysis session identifier. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Praxis registry (module-level singleton — created once, reused per batch)
// ---------------------------------------------------------------------------

const _analysisRegistry = new PraxisRegistry<AnalysisContext>();
_analysisRegistry.registerModule(analysisCoprocessorModule);

// ---------------------------------------------------------------------------
// Internal queue
// ---------------------------------------------------------------------------

/** FIFO queue of batches waiting to be analysed. */
const _queue: AnalysisBatch[] = [];
/** Whether the drain loop is currently running. */
let _draining = false;

// ---------------------------------------------------------------------------
// Artifact store callback
// ---------------------------------------------------------------------------

/**
 * Callback invoked for each generated artifact.  In production this will be
 * wired to the MCP service storage call; in tests it can be overridden via
 * `setArtifactStore`.
 */
type ArtifactStore = (artifact: AnalysisArtifact) => Promise<void>;
let _artifactStore: ArtifactStore = async () => {
  /* no-op default — replaced by wireAnalysisWorker() */
};

/**
 * Replace the artifact persistence callback.
 * Called during plugin initialisation to wire in the real MCP storage call.
 */
export function setArtifactStore(store: ArtifactStore): void {
  _artifactStore = store;
}

// ---------------------------------------------------------------------------
// Error logger callback
// ---------------------------------------------------------------------------

type ErrorLogger = (message: string) => void;
let _errorLogger: ErrorLogger = () => {
  /* no-op default */
};

/**
 * Replace the error logger.
 * Called during plugin initialisation to wire in the real logger.
 */
export function setErrorLogger(logger: ErrorLogger): void {
  _errorLogger = logger;
}

// ---------------------------------------------------------------------------
// Core analysis logic
// ---------------------------------------------------------------------------

/**
 * Run the analysis coprocessor engine over a single batch and return the
 * generated artifacts.  Pure function — does not call the artifact store.
 */
export function runAnalysis(batch: AnalysisBatch): AnalysisArtifact[] {
  const ctx = defaultAnalysisContext({
    primitives: batch.primitives,
    objectiveAlignmentScore: batch.objectiveAlignmentScore,
    hasLinkedRisk: batch.hasLinkedRisk,
    analysisSessionId: batch.sessionId,
  });

  const engine = createPraxisEngine({
    initialContext: ctx,
    registry: _analysisRegistry,
  });

  const { state } = engine.step([]);
  const artifacts: AnalysisArtifact[] = [];

  for (const f of state.facts) {
    // Skip the "no-op" empty-batch sentinel — nothing to store
    if (f.tag === ANALYSIS_FACTS.SKIPPED_EMPTY) continue;

    const payload = (f.payload ?? {}) as Record<string, unknown>;

    // Collect all source IDs referenced in the payload
    const sourceIds: string[] = [];
    if (Array.isArray(payload["primitiveIds"])) {
      for (const id of payload["primitiveIds"]) {
        if (typeof id === "string") sourceIds.push(id);
      }
    }
    if (Array.isArray(payload["riskIds"])) {
      for (const id of payload["riskIds"]) {
        if (typeof id === "string") sourceIds.push(id);
      }
    }
    if (Array.isArray(payload["targetIds"])) {
      for (const id of payload["targetIds"]) {
        if (typeof id === "string") sourceIds.push(id);
      }
    }

    // Map fact tags to human-readable summaries
    const summary = buildSummary(f.tag, payload);

    artifacts.push({
      factTag: f.tag,
      summary,
      sourceIds: sourceIds.length > 0 ? sourceIds : batch.primitives.map((p) => p.id),
      payload,
      sessionId: batch.sessionId,
    });
  }

  return artifacts;
}

function buildSummary(tag: string, payload: Record<string, unknown>): string {
  switch (tag) {
    case ANALYSIS_FACTS.CONFLICT_DETECTED: {
      const ids = (payload["primitiveIds"] as string[] | undefined) ?? [];
      return `Conflict detected between primitives: ${ids.join(", ")}`;
    }
    case ANALYSIS_FACTS.OBJECTIVE_ALIGNED: {
      const score = payload["score"] as number | undefined;
      return `Objective alignment: ALIGNED (score ${score?.toFixed(2) ?? "n/a"})`;
    }
    case ANALYSIS_FACTS.OBJECTIVE_MISALIGNED: {
      const score = payload["score"] as number | undefined;
      return `Objective alignment: MISALIGNED (score ${score?.toFixed(2) ?? "n/a"})`;
    }
    case ANALYSIS_FACTS.RISK_PROPAGATED: {
      const riskIds = (payload["riskIds"] as string[] | undefined) ?? [];
      return `Risk propagated from: ${riskIds.join(", ")}`;
    }
    case ANALYSIS_FACTS.EVIDENCE_MISSING: {
      const ids = (payload["primitiveIds"] as string[] | undefined) ?? [];
      return `Missing evidence for: ${ids.join(", ")}`;
    }
    case ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED: {
      const actions = payload["actions"] as Array<{ action: string }> | undefined;
      const count = actions?.length ?? 0;
      return `${count} next action(s) recommended`;
    }
    default:
      return `Analysis fact: ${tag}`;
  }
}

// ---------------------------------------------------------------------------
// Async drain loop
// ---------------------------------------------------------------------------

async function drain(): Promise<void> {
  if (_draining) return;
  _draining = true;

  while (_queue.length > 0) {
    const batch = _queue.shift()!;
    try {
      const artifacts = runAnalysis(batch);
      for (const artifact of artifacts) {
        await _artifactStore(artifact);
      }
    } catch (err) {
      // Deterministic error state: store an error artifact so the failure is
      // always observable and linkable to the originating session.
      const errorArtifact: AnalysisArtifact = {
        factTag: "analysis.error",
        summary: `Analysis failed for session '${batch.sessionId}': ${String(err)}`,
        sourceIds: batch.primitives.map((p) => p.id),
        payload: {
          error: String(err),
          sessionId: batch.sessionId,
          primitiveCount: batch.primitives.length,
        },
        sessionId: batch.sessionId,
      };
      try {
        await _artifactStore(errorArtifact);
      } catch {
        // If even storing the error fails, fall back to the logger
        _errorLogger(
          `pluresLM analysis-worker: failed to store error artifact for session '${batch.sessionId}': ${String(err)}`,
        );
      }
    }
  }

  _draining = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a batch of primitives for background analysis.
 * Returns immediately (non-blocking).  The drain loop runs on the next
 * microtask tick so it never delays the caller.
 */
export function enqueueAnalysis(batch: AnalysisBatch): void {
  _queue.push(batch);
  // Schedule drain without awaiting — fire and forget
  void Promise.resolve().then(drain);
}

/**
 * Exposed for testing: returns the current queue length.
 */
export function pendingAnalysisCount(): number {
  return _queue.length;
}

/**
 * Exposed for testing: reset the worker state (queue, drain flag, callbacks).
 */
export function _resetAnalysisWorker(): void {
  _queue.length = 0;
  _draining = false;
  _artifactStore = async () => {/* no-op */};
  _errorLogger = () => {/* no-op */};
}
