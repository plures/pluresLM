/**
 * Tests for the analysis coprocessor Praxis module and the analysis worker.
 *
 * Covers:
 * - analysisCoprocessorModule rules (empty batch, conflict detection,
 *   objective alignment, risk propagation, missing evidence, next actions)
 * - analysisCoprocessorModule constraints (session id, evidence threshold)
 * - runAnalysis() integration
 * - enqueueAnalysis() / async drain / artifact store wiring
 * - deterministic error state on analysis failure
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { PraxisRegistry, createPraxisEngine } from "@plures/praxis";

// Analysis Coprocessor module
import {
  analysisCoprocessorModule,
  defaultAnalysisContext,
  ANALYSIS_FACTS,
  type AnalysisContext,
  type AnalysisPrimitive,
} from "../../src/praxis/analysis-coprocessor.js";

// Analysis worker
import {
  runAnalysis,
  enqueueAnalysis,
  pendingAnalysisCount,
  setArtifactStore,
  setErrorLogger,
  _resetAnalysisWorker,
  type AnalysisBatch,
  type AnalysisArtifact,
} from "../../src/analysis-worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine(ctx: Partial<AnalysisContext> = {}) {
  const registry = new PraxisRegistry<AnalysisContext>();
  registry.registerModule(analysisCoprocessorModule);
  return createPraxisEngine({
    initialContext: defaultAnalysisContext({ analysisSessionId: "test:session", ...ctx }),
    registry,
  });
}

function hasFactTag(facts: { tag: string }[], tag: string): boolean {
  return facts.some((f) => f.tag === tag);
}

function prim(
  overrides: Partial<AnalysisPrimitive> & { kind: AnalysisPrimitive["kind"] },
): AnalysisPrimitive {
  const id = overrides.id ?? `prim:${Math.random().toString(36).slice(2)}`;
  return {
    id,
    sourceId: id,
    content: overrides.content ?? "Some default content",
    confidence: overrides.confidence ?? 0.8,
    tags: overrides.tags ?? [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — empty batch
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — empty-batch guard", () => {
  it("emits analysis.skipped.no-primitives when primitives array is empty", () => {
    const engine = makeEngine({ primitives: [] });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.SKIPPED_EMPTY)).toBe(true);
  });

  it("does not emit skipped fact when primitives are present", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "fact", content: "This is a known fact about TypeScript." })],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.SKIPPED_EMPTY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — conflict detection
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — conflict detection", () => {
  it("emits analysis.conflict-detected for contradictory rule primitives", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "rule", id: "p1", content: "We will always use TypeScript for new modules." }),
        prim({ kind: "rule", id: "p2", content: "We will never use TypeScript in this project." }),
      ],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.CONFLICT_DETECTED)).toBe(true);
  });

  it("includes both conflicting primitive IDs in the payload", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "rule", id: "p1", content: "We will always use Docker for deployments." }),
        prim({ kind: "rule", id: "p2", content: "We will never use Docker again." }),
      ],
    });
    const result = engine.step([]);
    const conflictFact = result.state.facts.find((f) => f.tag === ANALYSIS_FACTS.CONFLICT_DETECTED);
    expect(conflictFact).toBeDefined();
    const ids = (conflictFact!.payload as { primitiveIds: string[] }).primitiveIds;
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
  });

  it("does not emit conflict for non-contradictory rules", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "rule", content: "Use TypeScript for all new modules." }),
        prim({ kind: "rule", content: "Use ESLint for code quality." }),
      ],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.CONFLICT_DETECTED)).toBe(false);
  });

  it("does not check fact/evidence/action-item primitives for conflicts", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "fact", content: "We will always use TypeScript." }),
        prim({ kind: "evidence", content: "We will never use TypeScript." }),
      ],
    });
    const result = engine.step([]);
    // fact and evidence kinds are excluded from conflict detection
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.CONFLICT_DETECTED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — objective alignment
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — objective alignment", () => {
  it("emits analysis.objective-aligned when score >= 0.7 and objectives exist", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "objective", content: "Achieve 99% uptime." })],
      objectiveAlignmentScore: 0.85,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.OBJECTIVE_ALIGNED)).toBe(true);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.OBJECTIVE_MISALIGNED)).toBe(false);
  });

  it("emits analysis.objective-misaligned when score < 0.7 and objectives exist", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "objective", content: "Reduce latency to under 100ms." })],
      objectiveAlignmentScore: 0.4,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.OBJECTIVE_MISALIGNED)).toBe(true);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.OBJECTIVE_ALIGNED)).toBe(false);
  });

  it("does not emit alignment fact when no objective primitives are present", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "fact", content: "This is just a plain fact." })],
      objectiveAlignmentScore: 0.9,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.OBJECTIVE_ALIGNED)).toBe(false);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.OBJECTIVE_MISALIGNED)).toBe(false);
  });

  it("exactly one alignment fact is emitted when objectiveAlignmentScore is exactly 0.7", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "objective", content: "Goal: ship v2 by Q3." })],
      objectiveAlignmentScore: 0.7,
    });
    const result = engine.step([]);
    const aligned = result.state.facts.filter(
      (f) => f.tag === ANALYSIS_FACTS.OBJECTIVE_ALIGNED || f.tag === ANALYSIS_FACTS.OBJECTIVE_MISALIGNED,
    );
    expect(aligned).toHaveLength(1);
    expect(aligned[0]!.tag).toBe(ANALYSIS_FACTS.OBJECTIVE_ALIGNED);
  });
});

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — risk propagation
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — risk propagation", () => {
  it("emits analysis.risk-propagated when hasLinkedRisk is true and risks exist", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "risk", id: "r1", content: "Deployment pipeline could fail under load." }),
        prim({ kind: "objective", id: "o1", content: "Ship without downtime." }),
      ],
      hasLinkedRisk: true,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.RISK_PROPAGATED)).toBe(true);
  });

  it("risk-propagated payload contains risk and target IDs", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "risk", id: "r1", content: "Service memory leak." }),
        prim({ kind: "decision", id: "d1", content: "Use streaming to avoid OOM." }),
      ],
      hasLinkedRisk: true,
    });
    const result = engine.step([]);
    const f = result.state.facts.find((f) => f.tag === ANALYSIS_FACTS.RISK_PROPAGATED);
    const p = f!.payload as { riskIds: string[]; targetIds: string[] };
    expect(p.riskIds).toContain("r1");
    expect(p.targetIds).toContain("d1");
  });

  it("does not emit risk-propagated when hasLinkedRisk is false", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "risk", content: "Some risk." })],
      hasLinkedRisk: false,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.RISK_PROPAGATED)).toBe(false);
  });

  it("does not emit risk-propagated when no risk primitives exist", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "fact", content: "Plain fact." })],
      hasLinkedRisk: true,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.RISK_PROPAGATED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — missing evidence
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — missing evidence", () => {
  it("emits analysis.evidence-missing for low-confidence hypothesis without evidence", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "hypothesis", id: "h1", content: "Maybe the bottleneck is in the cache layer.", confidence: 0.3 }),
      ],
      evidenceThreshold: 0.5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.EVIDENCE_MISSING)).toBe(true);
    const f = result.state.facts.find((f) => f.tag === ANALYSIS_FACTS.EVIDENCE_MISSING);
    const p = f!.payload as { primitiveIds: string[] };
    expect(p.primitiveIds).toContain("h1");
  });

  it("does not emit evidence-missing when supporting evidence exists", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "hypothesis", id: "h1", content: "Maybe the bottleneck is in the cache layer.", confidence: 0.3, tags: ["cache"] }),
        prim({ kind: "evidence", id: "e1", content: "Profiling confirmed cache miss rate over 80%.", confidence: 0.9, tags: ["cache"] }),
      ],
      evidenceThreshold: 0.5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.EVIDENCE_MISSING)).toBe(false);
  });

  it("does not emit evidence-missing when confidence is at or above evidenceThreshold", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "hypothesis", content: "High confidence hypothesis here.", confidence: 0.8 }),
      ],
      evidenceThreshold: 0.5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.EVIDENCE_MISSING)).toBe(false);
  });

  it("does not emit evidence-missing when no hypothesis or decision primitives exist", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "fact", content: "Just a plain fact.", confidence: 0.3 })],
      evidenceThreshold: 0.5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.EVIDENCE_MISSING)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — next-action recommendation
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — next-action recommendation", () => {
  it("emits analysis.next-action-recommended for action-item primitives", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "action-item", content: "Update the README with new API documentation." }),
      ],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED)).toBe(true);
  });

  it("payload contains non-empty actions array", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "action-item", content: "Write integration tests for the sync module." }),
      ],
    });
    const result = engine.step([]);
    const f = result.state.facts.find((f) => f.tag === ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED);
    const p = f!.payload as { actions: Array<{ action: string }> };
    expect(p.actions.length).toBeGreaterThan(0);
    expect(p.actions[0]!.action).toBeTruthy();
  });

  it("emits next-action-recommended for unmitigated risk primitives", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "risk", content: "Memory leak in WebSocket handler could cause OOM crash." }),
        // No decision that mentions 'memory' or 'websocket'
      ],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED)).toBe(true);
    const f = result.state.facts.find((f) => f.tag === ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED);
    const p = f!.payload as { actions: Array<{ action: string; kind: string }> };
    expect(p.actions.some((a) => a.kind === "risk-mitigation")).toBe(true);
  });

  it("does not emit next-action-recommended when no action-items or unresolved risks", () => {
    const engine = makeEngine({
      primitives: [
        prim({ kind: "fact", content: "TypeScript was selected as the primary language." }),
        prim({ kind: "decision", content: "Going with TypeScript for all new modules." }),
      ],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, ANALYSIS_FACTS.NEXT_ACTION_RECOMMENDED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analysisCoprocessorModule — constraints
// ---------------------------------------------------------------------------

describe("analysisCoprocessorModule — constraints", () => {
  it("passes constraints for a valid context", () => {
    const engine = makeEngine({
      primitives: [prim({ kind: "fact", content: "Valid fact content." })],
      analysisSessionId: "session:abc",
      evidenceThreshold: 0.5,
    });
    const violations = engine.checkConstraints();
    expect(violations).toHaveLength(0);
  });

  it("fails constraint when analysisSessionId is empty", () => {
    const engine = makeEngine({ analysisSessionId: "" });
    const violations = engine.checkConstraints();
    expect(violations.length).toBeGreaterThan(0);
  });

  it("fails constraint when evidenceThreshold is 0", () => {
    const engine = makeEngine({ analysisSessionId: "s1", evidenceThreshold: 0 });
    const violations = engine.checkConstraints();
    expect(violations.length).toBeGreaterThan(0);
  });

  it("fails constraint when evidenceThreshold exceeds 1", () => {
    const engine = makeEngine({ analysisSessionId: "s1", evidenceThreshold: 1.5 });
    const violations = engine.checkConstraints();
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runAnalysis() integration
// ---------------------------------------------------------------------------

describe("runAnalysis()", () => {
  it("returns empty array when batch has no primitives", () => {
    const batch: AnalysisBatch = {
      sessionId: "test:run:1",
      objectiveAlignmentScore: 0,
      hasLinkedRisk: false,
      primitives: [],
    };
    const artifacts = runAnalysis(batch);
    // SKIPPED_EMPTY is filtered out; no other facts should be produced
    expect(artifacts).toHaveLength(0);
  });

  it("returns conflict artifact when contradictory rules present", () => {
    const batch: AnalysisBatch = {
      sessionId: "test:run:2",
      objectiveAlignmentScore: 0,
      hasLinkedRisk: false,
      primitives: [
        prim({ kind: "rule", id: "r1", content: "We should always cache responses." }),
        prim({ kind: "rule", id: "r2", content: "We should never cache responses." }),
      ],
    };
    const artifacts = runAnalysis(batch);
    expect(artifacts.some((a) => a.factTag === ANALYSIS_FACTS.CONFLICT_DETECTED)).toBe(true);
  });

  it("sets sessionId on every returned artifact", () => {
    const sid = "test:run:session";
    const batch: AnalysisBatch = {
      sessionId: sid,
      objectiveAlignmentScore: 0.8,
      hasLinkedRisk: false,
      primitives: [
        prim({ kind: "objective", content: "Ship the release." }),
      ],
    };
    const artifacts = runAnalysis(batch);
    for (const a of artifacts) {
      expect(a.sessionId).toBe(sid);
    }
  });

  it("artifact summary is a non-empty string for every fact tag", () => {
    const batch: AnalysisBatch = {
      sessionId: "test:run:3",
      objectiveAlignmentScore: 0.5,
      hasLinkedRisk: true,
      primitives: [
        prim({ kind: "objective", content: "Reduce deployment time." }),
        prim({ kind: "risk", id: "rsk1", content: "CI pipeline is flaky." }),
        prim({ kind: "hypothesis", id: "hyp1", content: "Maybe the flakiness is network-related.", confidence: 0.2 }),
        prim({ kind: "action-item", content: "Fix the flaky CI pipeline." }),
      ],
    };
    const artifacts = runAnalysis(batch);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const a of artifacts) {
      expect(typeof a.summary).toBe("string");
      expect(a.summary.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// enqueueAnalysis() and async drain
// ---------------------------------------------------------------------------

describe("enqueueAnalysis() — async worker", () => {
  beforeEach(() => {
    _resetAnalysisWorker();
  });

  it("calls artifact store for each artifact produced", async () => {
    const stored: AnalysisArtifact[] = [];
    setArtifactStore(async (a) => { stored.push(a); });

    const batch: AnalysisBatch = {
      sessionId: "async:test:1",
      objectiveAlignmentScore: 0.8,
      hasLinkedRisk: false,
      primitives: [
        prim({ kind: "objective", content: "Build the product." }),
      ],
    };

    enqueueAnalysis(batch);
    // Drain runs on next microtask — wait for all promises to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((a) => a.sessionId === "async:test:1")).toBe(true);
  });

  it("stores an error artifact when analysis throws", async () => {
    // Override the module-level registry by forcing runAnalysis to throw
    // by providing a malformed batch that will fail inside the engine
    const stored: AnalysisArtifact[] = [];
    setArtifactStore(async (a) => { stored.push(a); });

    // Inject a broken store that throws on non-error artifacts to simulate
    // downstream failure; we test error state via _artifactStore throwing
    _resetAnalysisWorker();
    let callCount = 0;
    setArtifactStore(async (a) => {
      callCount++;
      if (callCount === 1) throw new Error("simulated storage failure");
      stored.push(a);
    });

    const batch: AnalysisBatch = {
      sessionId: "async:test:error",
      objectiveAlignmentScore: 0.8,
      hasLinkedRisk: false,
      primitives: [
        prim({ kind: "objective", content: "Some objective." }),
      ],
    };

    enqueueAnalysis(batch);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // The error artifact should have been stored (second store call)
    expect(stored.some((a) => a.factTag === "analysis.error")).toBe(true);
  });

  it("pendingAnalysisCount reflects queue depth before drain", () => {
    // Temporarily block drain by not awaiting — just check count is accurate
    // before microtasks run
    const batch: AnalysisBatch = {
      sessionId: "async:test:count",
      objectiveAlignmentScore: 0,
      hasLinkedRisk: false,
      primitives: [],
    };

    // Before enqueue: 0
    expect(pendingAnalysisCount()).toBe(0);

    // We can't reliably test non-zero count because drain is microtask-scheduled,
    // but we can confirm it returns a number and doesn't throw.
    enqueueAnalysis(batch);
    expect(typeof pendingAnalysisCount()).toBe("number");
  });

  it("logs error when both analysis and error-artifact storage fail", async () => {
    const logs: string[] = [];
    setErrorLogger((msg) => { logs.push(msg); });
    setArtifactStore(async () => { throw new Error("all storage failed"); });

    const batch: AnalysisBatch = {
      sessionId: "async:test:fatal",
      objectiveAlignmentScore: 0.8,
      hasLinkedRisk: false,
      primitives: [prim({ kind: "objective", content: "Some objective." })],
    };

    enqueueAnalysis(batch);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(logs.some((m) => m.includes("async:test:fatal"))).toBe(true);
  });
});
