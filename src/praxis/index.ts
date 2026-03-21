/**
 * @plures/plureslm — Praxis Logic Modules
 *
 * Barrel export for all PluresLM Praxis modules.
 *
 * Modules:
 * - `memoryAdmissionModule` — store/reject gates, dedup detection
 * - `autoCaptureModule`     — auto-capture pattern rules
 * - `consolidationModule`   — staleness, merge, promotion/demotion
 * - `syncPolicyModule`      — Hyperswarm peer eligibility, encryption gates
 *
 * Factories:
 * - `inputRules(config?)`  — input validation module factory
 * - `dataRules(config?)`   — data scoring/threshold module factory
 * - `stateRules(config?)`  — lifecycle state-transition module factory
 */

export {
  memoryAdmissionModule,
  defaultMemoryAdmissionContext,
  ADMISSION_FACTS,
  type MemoryAdmissionContext,
} from "./memory-admission.js";

export {
  autoCaptureModule,
  defaultAutoCaptureContext,
  CAPTURE_FACTS,
  type AutoCaptureContext,
  type QueuedCapturePayload,
} from "./auto-capture.js";

export {
  consolidationModule,
  defaultConsolidationContext,
  CONSOLIDATION_FACTS,
  type ConsolidationContext,
  type ConsolidationMemory,
} from "./consolidation.js";

export {
  syncPolicyModule,
  defaultSyncPolicyContext,
  SYNC_FACTS,
  DEFAULT_LOCAL_ONLY_CATEGORIES,
  DEFAULT_SENSITIVE_CATEGORIES,
  type SyncPolicyContext,
} from "./sync-policy.js";

export {
  inputRules,
  dataRules,
  stateRules,
  INPUT_FACTS,
  DATA_FACTS,
  STATE_FACTS,
  type InputRulesConfig,
  type DataRulesConfig,
  type StateRulesConfig,
  type InputContext,
  type DataContext,
  type StateContext,
  type MemoryLifecycleState,
} from "./factory.js";
