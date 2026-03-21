/**
 * Sync Policy — Praxis Module
 *
 * Declarative logic for which memories are eligible for Hyperswarm P2P sync,
 * what encryption is required, and how to handle peer trust and conflict
 * resolution.
 *
 * Exported:
 * - `SyncPolicyContext` — typed context for this module
 * - `syncPolicyModule`  — ready-to-register PraxisModule
 */

import {
  defineModule,
  defineContract,
  RuleResult,
  fact,
} from "@plures/praxis";
import type { MemoryPriority } from "../types.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Categories that are always kept local — never synced to peers.
 * Callers may override via `localOnlyCategories`.
 */
export const DEFAULT_LOCAL_ONLY_CATEGORIES = [
  "compaction-snapshot",
  "work-in-progress",
] as const;

/**
 * Categories that require a trusted peer connection before syncing.
 */
export const DEFAULT_SENSITIVE_CATEGORIES = [
  "decision",
  "preference",
  "entity",
] as const;

export interface SyncPolicyContext {
  /** Memory identifier. */
  memoryId: string;
  /** Memory category. */
  category: string;
  /** Memory priority. */
  priority: MemoryPriority;
  /** Tags on the memory. */
  tags: string[];
  /** True when the session has an active encryption key configured. */
  hasEncryptionKey: boolean;
  /** True when the remote peer is in the local trust list. */
  isTrustedPeer: boolean;
  /** Remote peer identifier (for audit facts). */
  peerId: string;
  /**
   * Timestamp of the local copy of this memory.
   * Used for last-write-wins conflict resolution.
   */
  localTimestamp: number;
  /**
   * Timestamp of the remote peer's copy of this memory.
   * Used for last-write-wins conflict resolution.
   */
  remoteTimestamp: number;
  /** Categories that must never leave this device. */
  localOnlyCategories: readonly string[];
  /** Categories that require a trusted peer before syncing. */
  sensitiveCategories: readonly string[];
}

// ---------------------------------------------------------------------------
// Default context factory
// ---------------------------------------------------------------------------

export function defaultSyncPolicyContext(
  overrides: Partial<SyncPolicyContext> = {},
): SyncPolicyContext {
  return {
    memoryId: "",
    category: "conversation",
    priority: "normal",
    tags: [],
    hasEncryptionKey: false,
    isTrustedPeer: false,
    peerId: "",
    localTimestamp: 0,
    remoteTimestamp: 0,
    localOnlyCategories: DEFAULT_LOCAL_ONLY_CATEGORIES,
    sensitiveCategories: DEFAULT_SENSITIVE_CATEGORIES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fact tags
// ---------------------------------------------------------------------------

export const SYNC_FACTS = {
  ELIGIBLE: "sync.eligible",
  BLOCKED_NO_KEY: "sync.blocked.no-encryption-key",
  BLOCKED_LOCAL_ONLY: "sync.blocked.local-only-category",
  BLOCKED_UNTRUSTED: "sync.blocked.untrusted-peer",
  CONFLICT_KEEP_LOCAL: "sync.conflict.keep-local",
  CONFLICT_ACCEPT_REMOTE: "sync.conflict.accept-remote",
} as const;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const encryptionGateContract = defineContract({
  ruleId: "sync.encryption-gate",
  behavior: "Block sync for any memory when no encryption key is configured",
  examples: [
    {
      given: "hasEncryptionKey is false",
      when: "sync.encryption-gate evaluates",
      then: "emits sync.blocked.no-encryption-key fact",
    },
    {
      given: "hasEncryptionKey is true",
      when: "sync.encryption-gate evaluates",
      then: "returns noop",
    },
  ],
  invariants: [
    "no memory is ever synced without an active encryption key",
  ],
});

const categoryEligibilityContract = defineContract({
  ruleId: "sync.category-eligibility",
  behavior: "Block sync for memories in localOnlyCategories",
  examples: [
    {
      given: "category is 'compaction-snapshot'",
      when: "sync.category-eligibility evaluates",
      then: "emits sync.blocked.local-only-category fact",
    },
    {
      given: "category is 'decision'",
      when: "sync.category-eligibility evaluates",
      then: "returns noop (decision is not in localOnlyCategories)",
    },
  ],
  invariants: [
    "localOnlyCategories members always produce a blocked fact",
  ],
});

const peerTrustContract = defineContract({
  ruleId: "sync.peer-trust",
  behavior:
    "Block sync of sensitive-category or critical-priority memories to untrusted peers",
  examples: [
    {
      given: "category is 'decision', isTrustedPeer is false",
      when: "sync.peer-trust evaluates",
      then: "emits sync.blocked.untrusted-peer fact",
    },
    {
      given: "category is 'decision', isTrustedPeer is true",
      when: "sync.peer-trust evaluates",
      then: "returns noop",
    },
    {
      given: "priority is 'critical', isTrustedPeer is false",
      when: "sync.peer-trust evaluates",
      then: "emits sync.blocked.untrusted-peer fact",
    },
  ],
  invariants: [
    "sensitive categories and critical priority memories require a trusted peer",
  ],
});

const conflictResolutionContract = defineContract({
  ruleId: "sync.conflict-resolution",
  behavior:
    "Resolve write conflicts using last-write-wins: keep the copy with the higher timestamp",
  examples: [
    {
      given: "localTimestamp is 1000, remoteTimestamp is 2000",
      when: "sync.conflict-resolution evaluates",
      then: "emits sync.conflict.accept-remote fact",
    },
    {
      given: "localTimestamp is 3000, remoteTimestamp is 2000",
      when: "sync.conflict-resolution evaluates",
      then: "emits sync.conflict.keep-local fact",
    },
    {
      given: "localTimestamp equals remoteTimestamp",
      when: "sync.conflict-resolution evaluates",
      then: "emits sync.conflict.keep-local fact (tie goes to local)",
    },
  ],
  invariants: [
    "the copy with the higher timestamp wins",
    "on equal timestamps, local copy is preferred",
  ],
});

const eligibleContract = defineContract({
  ruleId: "sync.eligible",
  behavior:
    "Emit sync.eligible fact when the memory passes all sync gates",
  examples: [
    {
      given: "hasEncryptionKey is true, category is 'conversation', isTrustedPeer is true",
      when: "sync.eligible evaluates",
      then: "emits sync.eligible fact",
    },
  ],
  invariants: [
    "sync.eligible is only emitted when no blocking fact conditions are present",
  ],
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * Praxis module for Hyperswarm sync policy.
 *
 * Rules:
 * 1. `sync.encryption-gate`       — require encryption key
 * 2. `sync.category-eligibility`  — block local-only categories
 * 3. `sync.peer-trust`            — require trusted peer for sensitive data
 * 4. `sync.conflict-resolution`   — last-write-wins conflict resolution
 * 5. `sync.eligible`              — emit eligible fact when all gates pass
 */
export const syncPolicyModule = defineModule<SyncPolicyContext>({
  rules: [
    {
      id: "sync.encryption-gate",
      description: "Block sync when no encryption key is configured",
      contract: encryptionGateContract,
      impl(state) {
        if (!state.context.hasEncryptionKey) {
          return RuleResult.emit([
            fact(SYNC_FACTS.BLOCKED_NO_KEY, {
              memoryId: state.context.memoryId,
              peerId: state.context.peerId,
            }),
          ]);
        }
        return RuleResult.noop("encryption key present");
      },
    },
    {
      id: "sync.category-eligibility",
      description: "Block sync for memories in localOnlyCategories",
      contract: categoryEligibilityContract,
      impl(state) {
        const { category, localOnlyCategories, memoryId } = state.context;
        if ((localOnlyCategories as readonly string[]).includes(category)) {
          return RuleResult.emit([
            fact(SYNC_FACTS.BLOCKED_LOCAL_ONLY, { memoryId, category }),
          ]);
        }
        return RuleResult.noop("category is sync-eligible");
      },
    },
    {
      id: "sync.peer-trust",
      description: "Block sync of sensitive/critical memories to untrusted peers",
      contract: peerTrustContract,
      impl(state) {
        const { category, priority, isTrustedPeer, sensitiveCategories, memoryId, peerId } =
          state.context;
        const isSensitive =
          priority === "critical" ||
          (sensitiveCategories as readonly string[]).includes(category);
        if (isSensitive && !isTrustedPeer) {
          return RuleResult.emit([
            fact(SYNC_FACTS.BLOCKED_UNTRUSTED, { memoryId, category, priority, peerId }),
          ]);
        }
        return RuleResult.noop("peer trust check passed");
      },
    },
    {
      id: "sync.conflict-resolution",
      description: "Last-write-wins conflict resolution",
      contract: conflictResolutionContract,
      impl(state) {
        const { localTimestamp, remoteTimestamp, memoryId } = state.context;
        // Only run conflict resolution when we have a non-zero remote timestamp
        if (remoteTimestamp === 0) {
          return RuleResult.skip("no remote version present");
        }
        if (remoteTimestamp > localTimestamp) {
          return RuleResult.emit([
            fact(SYNC_FACTS.CONFLICT_ACCEPT_REMOTE, { memoryId, localTimestamp, remoteTimestamp }),
          ]);
        }
        return RuleResult.emit([
          fact(SYNC_FACTS.CONFLICT_KEEP_LOCAL, { memoryId, localTimestamp, remoteTimestamp }),
        ]);
      },
    },
    {
      id: "sync.eligible",
      description: "Emit sync.eligible when all gates pass",
      contract: eligibleContract,
      impl(state) {
        const {
          hasEncryptionKey,
          category,
          priority,
          localOnlyCategories,
          sensitiveCategories,
          isTrustedPeer,
          memoryId,
        } = state.context;

        if (!hasEncryptionKey) return RuleResult.skip("no encryption key");

        if ((localOnlyCategories as readonly string[]).includes(category)) {
          return RuleResult.skip("local-only category");
        }

        const isSensitive =
          priority === "critical" ||
          (sensitiveCategories as readonly string[]).includes(category);
        if (isSensitive && !isTrustedPeer) {
          return RuleResult.skip("untrusted peer for sensitive category");
        }

        return RuleResult.emit([
          fact(SYNC_FACTS.ELIGIBLE, { memoryId, category, priority }),
        ]);
      },
    },
  ],
  constraints: [],
  meta: {
    module: "sync-policy",
    version: "1.0.0",
  },
});
