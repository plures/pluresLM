/**
 * Tests for PluresLM Praxis modules.
 *
 * Covers all four logic modules and the three factory functions:
 * - memoryAdmissionModule
 * - autoCaptureModule
 * - consolidationModule
 * - syncPolicyModule
 * - inputRules()
 * - dataRules()
 * - stateRules()
 */

import { describe, expect, it } from "vitest";
import {
  PraxisRegistry,
  createPraxisEngine,
} from "@plures/praxis";

// Memory Admission
import {
  memoryAdmissionModule,
  defaultMemoryAdmissionContext,
  ADMISSION_FACTS,
  type MemoryAdmissionContext,
} from "../../src/praxis/memory-admission.js";

// Auto Capture
import {
  autoCaptureModule,
  defaultAutoCaptureContext,
  CAPTURE_FACTS,
} from "../../src/praxis/auto-capture.js";

// Consolidation
import {
  consolidationModule,
  defaultConsolidationContext,
  CONSOLIDATION_FACTS,
} from "../../src/praxis/consolidation.js";

// Sync Policy
import {
  syncPolicyModule,
  defaultSyncPolicyContext,
  SYNC_FACTS,
} from "../../src/praxis/sync-policy.js";

// Factory
import {
  inputRules,
  dataRules,
  stateRules,
  INPUT_FACTS,
  DATA_FACTS,
  STATE_FACTS,
} from "../../src/praxis/factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdmissionEngine(ctx: Partial<MemoryAdmissionContext> = {}) {
  const registry = new PraxisRegistry<MemoryAdmissionContext>();
  registry.registerModule(memoryAdmissionModule);
  return createPraxisEngine({
    initialContext: defaultMemoryAdmissionContext(ctx),
    registry,
  });
}

function hasFactTag(facts: { tag: string }[], tag: string): boolean {
  return facts.some((f) => f.tag === tag);
}

// ---------------------------------------------------------------------------
// Memory Admission Module
// ---------------------------------------------------------------------------

describe("memoryAdmissionModule", () => {
  describe("admission.length-gate", () => {
    it("emits rejected.length for content below minContentLength", () => {
      const engine = makeAdmissionEngine({ content: "short" });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_LENGTH)).toBe(true);
    });

    it("does not emit rejected.length for content at exactly minContentLength", () => {
      const engine = makeAdmissionEngine({ content: "A".repeat(50) });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_LENGTH)).toBe(false);
    });

    it("does not emit rejected.length for long content", () => {
      const engine = makeAdmissionEngine({ content: "A".repeat(200) });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_LENGTH)).toBe(false);
    });
  });

  describe("admission.noise-filter", () => {
    it("emits rejected.noise for JSON tool output", () => {
      const engine = makeAdmissionEngine({
        content: `{"type":"tool_result","data":"something long enough to pass the length gate here"}`,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_NOISE)).toBe(true);
    });

    it("emits rejected.noise for <tool_result XML", () => {
      const engine = makeAdmissionEngine({
        content: `<tool_result>some content that is long enough to pass the length gate here</tool_result>`,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_NOISE)).toBe(true);
    });

    it("does not emit rejected.noise for clean substantive text", () => {
      const engine = makeAdmissionEngine({
        content: "TypeScript interfaces provide compile-time type checking for object shapes and function signatures.",
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_NOISE)).toBe(false);
    });
  });

  describe("admission.duplicate-hash", () => {
    it("emits rejected.duplicate-hash when isDuplicateHash is true", () => {
      const engine = makeAdmissionEngine({
        content: "A".repeat(80),
        isDuplicateHash: true,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_DUPLICATE_HASH)).toBe(true);
    });

    it("does not emit rejected.duplicate-hash when isDuplicateHash is false", () => {
      const engine = makeAdmissionEngine({
        content: "A".repeat(80),
        isDuplicateHash: false,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.REJECTED_DUPLICATE_HASH)).toBe(false);
    });
  });

  describe("admission.dedup-vector", () => {
    it("emits dedup.candidate when vectorNeighbourScore >= dedupeThreshold", () => {
      const engine = makeAdmissionEngine({
        content: "A".repeat(80),
        vectorNeighbourScore: 0.97,
        dedupeThreshold: 0.95,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.DEDUP_CANDIDATE)).toBe(true);
    });

    it("does not emit dedup.candidate when below threshold", () => {
      const engine = makeAdmissionEngine({
        content: "A".repeat(80),
        vectorNeighbourScore: 0.80,
        dedupeThreshold: 0.95,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.DEDUP_CANDIDATE)).toBe(false);
    });
  });

  describe("admission.admit", () => {
    it("emits admitted for clean, non-duplicate content", () => {
      const engine = makeAdmissionEngine({
        content: "TypeScript interfaces provide compile-time type checking for object shapes.",
        isDuplicateHash: false,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.ADMITTED)).toBe(true);
    });

    it("does not emit admitted for hash duplicate", () => {
      const engine = makeAdmissionEngine({
        content: "TypeScript interfaces provide compile-time type checking for object shapes.",
        isDuplicateHash: true,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.ADMITTED)).toBe(false);
    });

    it("does not emit admitted for noise content", () => {
      const engine = makeAdmissionEngine({
        content: `{"type":"tool_result","data":"some long tool output data here that is long enough to pass"}`,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, ADMISSION_FACTS.ADMITTED)).toBe(false);
    });
  });

  describe("constraints", () => {
    it("passes constraints for valid context", () => {
      const engine = makeAdmissionEngine({ content: "A".repeat(80) });
      const violations = engine.checkConstraints();
      expect(violations).toHaveLength(0);
    });

    it("dedupeThreshold of 1.1 violates threshold-range constraint", () => {
      const engine = makeAdmissionEngine({
        content: "A".repeat(80),
        dedupeThreshold: 1.1,
      });
      const violations = engine.checkConstraints();
      expect(violations.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-Capture Module
// ---------------------------------------------------------------------------

describe("autoCaptureModule", () => {
  function makeEngine(overrides = {}) {
    const registry = new PraxisRegistry();
    registry.registerModule(autoCaptureModule);
    return createPraxisEngine({
      initialContext: defaultAutoCaptureContext(overrides),
      registry,
    });
  }

  it("emits capture.queued for capturable texts", () => {
    const engine = makeEngine({
      texts: [
        "TypeScript provides static type checking and interfaces for large-scale applications.",
        "Short", // should be filtered out
      ],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.QUEUED)).toBe(true);
    const queuedFact = result.state.facts.find((f) => f.tag === CAPTURE_FACTS.QUEUED);
    expect((queuedFact?.payload as { texts: string[] }).texts).toHaveLength(1);
  });

  it("emits skipped.no-capturable-texts when all texts are noise", () => {
    const engine = makeEngine({
      texts: ["Short"],
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.SKIPPED_EMPTY)).toBe(true);
  });

  it("emits skipped.max-turn-cap when at maxCapturesPerTurn", () => {
    const engine = makeEngine({
      texts: ["x".repeat(80)],
      captureCount: 5,
      maxCapturesPerTurn: 5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.SKIPPED_MAX)).toBe(true);
  });

  it("does not emit capture.queued when at maxCapturesPerTurn", () => {
    const engine = makeEngine({
      texts: ["TypeScript interfaces provide compile-time type checking for object shapes."],
      captureCount: 5,
      maxCapturesPerTurn: 5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.QUEUED)).toBe(false);
  });

  it("emits capture.code-pattern when hasCodePattern is true", () => {
    const engine = makeEngine({
      texts: ["x".repeat(80)],
      hasCodePattern: true,
      captureCount: 0,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.CODE_PATTERN)).toBe(true);
  });

  it("does not emit capture.code-pattern when hasCodePattern is false", () => {
    const engine = makeEngine({
      texts: ["x".repeat(80)],
      hasCodePattern: false,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.CODE_PATTERN)).toBe(false);
  });

  it("emits capture.error-fix when hasErrorFix is true", () => {
    const engine = makeEngine({ hasErrorFix: true, texts: ["x".repeat(80)] });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.ERROR_FIX)).toBe(true);
  });

  it("emits capture.wip when isWorkInProgress is true", () => {
    const engine = makeEngine({ isWorkInProgress: true, texts: ["x".repeat(80)] });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.WIP)).toBe(true);
  });

  it("does not emit code-pattern when at max turn cap", () => {
    const engine = makeEngine({
      hasCodePattern: true,
      captureCount: 5,
      maxCapturesPerTurn: 5,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CAPTURE_FACTS.CODE_PATTERN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consolidation Module
// ---------------------------------------------------------------------------

describe("consolidationModule", () => {
  function makeEngine(overrides = {}) {
    const registry = new PraxisRegistry();
    registry.registerModule(consolidationModule);
    return createPraxisEngine({
      initialContext: defaultConsolidationContext(overrides),
      registry,
    });
  }

  it("emits memory.stale when daysSinceAccess > stalenessDays", () => {
    const engine = makeEngine({
      memory: {
        id: "m1", category: "conversation", priority: "normal",
        daysSinceAccess: 45, reinforcement_count: 0, tier: "hot", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.STALE)).toBe(true);
  });

  it("does not emit memory.stale for fresh memory", () => {
    const engine = makeEngine({
      memory: {
        id: "m2", category: "conversation", priority: "normal",
        daysSinceAccess: 10, reinforcement_count: 0, tier: "hot", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.STALE)).toBe(false);
  });

  it("does not emit memory.stale for critical memories", () => {
    const engine = makeEngine({
      memory: {
        id: "m3", category: "decision", priority: "critical",
        daysSinceAccess: 100, reinforcement_count: 0, tier: "hot", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.STALE)).toBe(false);
  });

  it("emits memory.merge.candidate when vectorNeighbourScore >= dedupeThreshold", () => {
    const engine = makeEngine({
      memory: {
        id: "m4", category: "conversation", priority: "normal",
        daysSinceAccess: 5, reinforcement_count: 0, tier: "hot", vectorNeighbourScore: 0.97,
      },
      dedupeThreshold: 0.95,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.MERGE_CANDIDATE)).toBe(true);
  });

  it("emits memory.promote.candidate when reinforcement_count >= threshold and not hot", () => {
    const engine = makeEngine({
      memory: {
        id: "m5", category: "decision", priority: "high",
        daysSinceAccess: 5, reinforcement_count: 5, tier: "warm", vectorNeighbourScore: 0,
      },
      promotionThreshold: 3,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.PROMOTE_CANDIDATE)).toBe(true);
  });

  it("does not emit promote.candidate when already hot", () => {
    const engine = makeEngine({
      memory: {
        id: "m6", category: "decision", priority: "high",
        daysSinceAccess: 5, reinforcement_count: 10, tier: "hot", vectorNeighbourScore: 0,
      },
      promotionThreshold: 3,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.PROMOTE_CANDIDATE)).toBe(false);
  });

  it("emits demote.candidate for stale hot memory", () => {
    const engine = makeEngine({
      memory: {
        id: "m7", category: "conversation", priority: "normal",
        daysSinceAccess: 45, reinforcement_count: 0, tier: "hot", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    const demoteFact = result.state.facts.find((f) => f.tag === CONSOLIDATION_FACTS.DEMOTE_CANDIDATE);
    expect(demoteFact).toBeDefined();
    expect((demoteFact?.payload as { targetTier: string }).targetTier).toBe("warm");
  });

  it("emits demote.candidate from warm to cold", () => {
    const engine = makeEngine({
      memory: {
        id: "m8", category: "conversation", priority: "normal",
        daysSinceAccess: 45, reinforcement_count: 0, tier: "warm", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    const demoteFact = result.state.facts.find((f) => f.tag === CONSOLIDATION_FACTS.DEMOTE_CANDIDATE);
    expect(demoteFact).toBeDefined();
    expect((demoteFact?.payload as { targetTier: string }).targetTier).toBe("cold");
  });

  it("does not demote critical memories", () => {
    const engine = makeEngine({
      memory: {
        id: "m9", category: "decision", priority: "critical",
        daysSinceAccess: 100, reinforcement_count: 0, tier: "hot", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.DEMOTE_CANDIDATE)).toBe(false);
  });

  it("does not demote cold memories further", () => {
    const engine = makeEngine({
      memory: {
        id: "m10", category: "conversation", priority: "normal",
        daysSinceAccess: 200, reinforcement_count: 0, tier: "cold", vectorNeighbourScore: 0,
      },
      stalenessDays: 30,
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, CONSOLIDATION_FACTS.DEMOTE_CANDIDATE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sync Policy Module
// ---------------------------------------------------------------------------

describe("syncPolicyModule", () => {
  function makeEngine(overrides = {}) {
    const registry = new PraxisRegistry();
    registry.registerModule(syncPolicyModule);
    return createPraxisEngine({
      initialContext: defaultSyncPolicyContext({ peerId: "peer-1", ...overrides }),
      registry,
    });
  }

  it("emits sync.blocked.no-encryption-key when hasEncryptionKey is false", () => {
    const engine = makeEngine({ hasEncryptionKey: false, category: "conversation" });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.BLOCKED_NO_KEY)).toBe(true);
  });

  it("emits sync.eligible when all gates pass", () => {
    const engine = makeEngine({
      hasEncryptionKey: true,
      isTrustedPeer: true,
      category: "conversation",
      priority: "normal",
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.ELIGIBLE)).toBe(true);
  });

  it("emits sync.blocked.local-only-category for compaction-snapshot", () => {
    const engine = makeEngine({
      hasEncryptionKey: true,
      category: "compaction-snapshot",
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.BLOCKED_LOCAL_ONLY)).toBe(true);
  });

  it("emits sync.blocked.local-only-category for work-in-progress", () => {
    const engine = makeEngine({
      hasEncryptionKey: true,
      category: "work-in-progress",
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.BLOCKED_LOCAL_ONLY)).toBe(true);
  });

  it("emits sync.blocked.untrusted-peer for sensitive category with untrusted peer", () => {
    const engine = makeEngine({
      hasEncryptionKey: true,
      isTrustedPeer: false,
      category: "decision",
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.BLOCKED_UNTRUSTED)).toBe(true);
  });

  it("emits sync.blocked.untrusted-peer for critical priority with untrusted peer", () => {
    const engine = makeEngine({
      hasEncryptionKey: true,
      isTrustedPeer: false,
      category: "conversation",
      priority: "critical",
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.BLOCKED_UNTRUSTED)).toBe(true);
  });

  it("allows sensitive category to trusted peer", () => {
    const engine = makeEngine({
      hasEncryptionKey: true,
      isTrustedPeer: true,
      category: "decision",
      priority: "high",
    });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.BLOCKED_UNTRUSTED)).toBe(false);
    expect(hasFactTag(result.state.facts, SYNC_FACTS.ELIGIBLE)).toBe(true);
  });

  describe("conflict resolution", () => {
    it("emits accept-remote when remoteTimestamp is newer", () => {
      const engine = makeEngine({
        hasEncryptionKey: true,
        isTrustedPeer: true,
        category: "conversation",
        localTimestamp: 1000,
        remoteTimestamp: 2000,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, SYNC_FACTS.CONFLICT_ACCEPT_REMOTE)).toBe(true);
      expect(hasFactTag(result.state.facts, SYNC_FACTS.CONFLICT_KEEP_LOCAL)).toBe(false);
    });

    it("emits keep-local when localTimestamp is newer", () => {
      const engine = makeEngine({
        hasEncryptionKey: true,
        isTrustedPeer: true,
        category: "conversation",
        localTimestamp: 3000,
        remoteTimestamp: 2000,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, SYNC_FACTS.CONFLICT_KEEP_LOCAL)).toBe(true);
    });

    it("emits keep-local on equal timestamps (tie goes to local)", () => {
      const engine = makeEngine({
        hasEncryptionKey: true,
        isTrustedPeer: true,
        category: "conversation",
        localTimestamp: 2000,
        remoteTimestamp: 2000,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, SYNC_FACTS.CONFLICT_KEEP_LOCAL)).toBe(true);
    });

    it("skips conflict resolution when remoteTimestamp is 0 (no remote version)", () => {
      const engine = makeEngine({
        hasEncryptionKey: true,
        isTrustedPeer: true,
        category: "conversation",
        localTimestamp: 1000,
        remoteTimestamp: 0,
      });
      const result = engine.step([]);
      expect(hasFactTag(result.state.facts, SYNC_FACTS.CONFLICT_ACCEPT_REMOTE)).toBe(false);
      expect(hasFactTag(result.state.facts, SYNC_FACTS.CONFLICT_KEEP_LOCAL)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// inputRules factory
// ---------------------------------------------------------------------------

describe("inputRules factory", () => {
  function makeEngine(ctx: { content: string; tags?: string[]; isSearchQuery?: boolean; category?: string }, config = {}) {
    const module = inputRules(config);
    const registry = new PraxisRegistry();
    registry.registerModule(module);
    return createPraxisEngine({
      initialContext: {
        content: ctx.content,
        tags: ctx.tags ?? [],
        isSearchQuery: ctx.isSearchQuery ?? false,
        category: ctx.category ?? "conversation",
      },
      registry,
    });
  }

  it("emits input.valid for well-formed store payload", () => {
    const engine = makeEngine({ content: "A valid memory about TypeScript type safety and generics." });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.VALID)).toBe(true);
  });

  it("emits content-too-short for short content", () => {
    const engine = makeEngine({ content: "short" });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.INVALID_CONTENT_TOO_SHORT)).toBe(true);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.VALID)).toBe(false);
  });

  it("emits too-many-tags when tag count exceeds maxTags", () => {
    const engine = makeEngine(
      { content: "A valid memory about TypeScript type safety and generics.", tags: Array.from({ length: 25 }, (_, i) => `tag-${i}`) },
      { maxTags: 20 },
    );
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.INVALID_TOO_MANY_TAGS)).toBe(true);
  });

  it("emits search-query-too-short for very short query", () => {
    const engine = makeEngine({ content: "ty", isSearchQuery: true });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.INVALID_SEARCH_QUERY_TOO_SHORT)).toBe(true);
  });

  it("emits input.valid for a valid search query", () => {
    const engine = makeEngine({ content: "TypeScript generics", isSearchQuery: true });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.VALID)).toBe(true);
  });

  it("respects custom minContentLength config", () => {
    const engine = makeEngine({ content: "short enough with custom config!" }, { minContentLength: 10 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, INPUT_FACTS.VALID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dataRules factory
// ---------------------------------------------------------------------------

describe("dataRules factory", () => {
  function makeEngine(ctx: { relevanceScore?: number; daysSinceAccess?: number; vectorNeighbourScore?: number; priority?: string }, config = {}) {
    const module = dataRules(config);
    const registry = new PraxisRegistry();
    registry.registerModule(module);
    return createPraxisEngine({
      initialContext: {
        relevanceScore: ctx.relevanceScore ?? 1.0,
        daysSinceAccess: ctx.daysSinceAccess ?? 0,
        vectorNeighbourScore: ctx.vectorNeighbourScore ?? 0,
        priority: (ctx.priority ?? "normal") as any,
      },
      registry,
    });
  }

  it("emits data.relevant for score above threshold", () => {
    const engine = makeEngine({ relevanceScore: 0.8 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, DATA_FACTS.RELEVANT)).toBe(true);
  });

  it("emits data.below-relevance-threshold for low score", () => {
    const engine = makeEngine({ relevanceScore: 0.3 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, DATA_FACTS.BELOW_THRESHOLD)).toBe(true);
  });

  it("emits data.stale when daysSinceAccess exceeds stalenessDays", () => {
    const engine = makeEngine({ daysSinceAccess: 45 }, { stalenessDays: 30 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, DATA_FACTS.STALE)).toBe(true);
  });

  it("does not emit data.stale for critical memories", () => {
    const engine = makeEngine({ daysSinceAccess: 100, priority: "critical" });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, DATA_FACTS.STALE)).toBe(false);
  });

  it("emits data.dedup-candidate when vectorNeighbourScore >= threshold", () => {
    const engine = makeEngine({ vectorNeighbourScore: 0.97 }, { dedupeThreshold: 0.95 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, DATA_FACTS.DEDUP_CANDIDATE)).toBe(true);
  });

  it("does not emit data.dedup-candidate below threshold", () => {
    const engine = makeEngine({ vectorNeighbourScore: 0.80 }, { dedupeThreshold: 0.95 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, DATA_FACTS.DEDUP_CANDIDATE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stateRules factory
// ---------------------------------------------------------------------------

describe("stateRules factory", () => {
  function makeEngine(ctx: Partial<{
    memoryId: string;
    currentState: string;
    currentTier: string;
    priority: string;
    daysSinceAccess: number;
    reinforcement_count: number;
  }>, config = {}) {
    const module = stateRules(config);
    const registry = new PraxisRegistry();
    registry.registerModule(module);
    return createPraxisEngine({
      initialContext: {
        memoryId: ctx.memoryId ?? "m1",
        currentState: (ctx.currentState ?? "active") as any,
        currentTier: (ctx.currentTier ?? "hot") as any,
        priority: (ctx.priority ?? "normal") as any,
        daysSinceAccess: ctx.daysSinceAccess ?? 0,
        reinforcement_count: ctx.reinforcement_count ?? 0,
      },
      registry,
    });
  }

  it("emits active-to-stale when daysSinceAccess > staleDays", () => {
    const engine = makeEngine({ currentState: "active", daysSinceAccess: 35 }, { staleDays: 30 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_STALE)).toBe(true);
  });

  it("does not emit active-to-stale for fresh active memory", () => {
    const engine = makeEngine({ currentState: "active", daysSinceAccess: 10 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_STALE)).toBe(false);
  });

  it("emits stale-to-demoted when stale and daysSinceAccess > demoteDays", () => {
    const engine = makeEngine({ currentState: "stale", daysSinceAccess: 100 }, { demoteDays: 90 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_DEMOTED)).toBe(true);
  });

  it("emits demoted-to-archived when demoted and daysSinceAccess > archiveDays", () => {
    const engine = makeEngine({ currentState: "demoted", daysSinceAccess: 200 }, { archiveDays: 180 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_ARCHIVED)).toBe(true);
  });

  it("emits promoted-to-hot when reinforcement_count >= threshold and not hot", () => {
    const engine = makeEngine({ currentTier: "warm", reinforcement_count: 5 }, { promotionThreshold: 3 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_HOT)).toBe(true);
  });

  it("does not emit promoted-to-hot when already in hot tier", () => {
    const engine = makeEngine({ currentTier: "hot", reinforcement_count: 10 }, { promotionThreshold: 3 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_HOT)).toBe(false);
  });

  it("does not transition active critical memories to stale", () => {
    const engine = makeEngine({ currentState: "active", priority: "critical", daysSinceAccess: 200 });
    const result = engine.step([]);
    expect(hasFactTag(result.state.facts, STATE_FACTS.TRANSITION_TO_STALE)).toBe(false);
  });
});
