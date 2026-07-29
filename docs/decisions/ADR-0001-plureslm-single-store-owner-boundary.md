# ADR-0001: Enforce the PluresLM Single-Store-Owner Boundary

**Status:** Proposed — audit and design only; this ADR authorizes no migrations.

**Date:** 2026-07-24

**Deciders:** PluresLM, Pares Agens, and host-integration maintainers

**Related:** Pares Agens ADR-0014, ADR-0016, ADR-0017 (plures/pares-agens); OpenClaw ADR-0002 and ADR-0003 (plures/plureslm-openclaw); PluresDB service-boundary document (link or add to this repo so this reference is resolvable).

## Context

`PLURESDB-SERVICE-BOUNDARIES.md` requires exactly one lock-owning service/manager whenever a PluresDB store can be used by more than one runtime. Adapters must use that service rather than open its live store. This is not an abstract precaution: the original OpenClaw integration made the plugin both adapter and store owner. The resulting exclusive lock made independent probes unable to open the store, while OpenClaw's embedded `active-memory` lane could not reach plugin tools.

This ADR records a source audit of the five requested integration surfaces. **Agency is the Pares Agens product/codename, not a separate repository**; it is reported separately because its external-memory bridge has a distinct policy boundary.

## Decision

The canonical seam is the **PluresLM Memory Service**. It is the only component permitted to open a shared live PluresDB memory store. Its stable client API is `health`, `status`, `search/recall`, `get`, `store/capture`, `forget`, `index`, `sync`, `consolidate`, and `migrate`; transport is local IPC/in-process for native callers and the service's MCP/HTTP adapter only for external callers.

An adapter may retain a directly opened store only when it is an explicitly selected, documented **single-consumer independent-store mode**, has a distinct path/topic, and is prevented from targeting the shared PluresLM service store. A direct opening of a shared PluresLM path is prohibited.

## Audit findings

| Surface | Classification | Evidence | Required migration path |
|---|---|---|---|
| **Pares Agens** (`plures/pares-agens`) | **Violates boundary** | `crates/core/src/memory/store.rs` constructs the PluresDB-backed memory store, opening `SledStorage`/`CrdtStore` in the core adapter path (captured source lines below). This is independently identified by ADR-0016. | Implement the already-designed ADR-0016 topology: move the lock-owning store plus sync/index logic into one `plureslm-memory-service`; replace `core::memory::PluresLm` with an IPC/in-process client; register memory capability only after `health()` succeeds. TUI, CLI, Tauri, channels, delegation, and MCP are clients. |
| **Scout** (`plures/plureslm-openclaw`, `scout-hooks/` and `scout-mcp/`) | **Violates boundary in shared-store configuration** | Scout MCP and hook code import the native PluresDB module and accept/use `dbPath`; ADR-0003 records that both seams open the store directly. Multiple Scout/OpenClaw processes can therefore contend for the same path. | Remove shared-store `dbPath` ownership from hook and normal MCP service mode. The hook calls the Scout MCP/service client for recall; Scout MCP calls the PluresLM service. Retain direct mode only behind an explicit `singleConsumerDirectStore` configuration that rejects the configured PluresLM service path/topic and cannot be the default when a service endpoint is present. |
| **VS Code** (`plures/pluresLM-vscode`) | **No direct-CrdtStore-open finding; legacy local-store exception needs a guard** | `src/memory-provider.ts` selects `PluresLMServiceClient` in service mode. Its legacy provider opens `MemoryDB`, and `src/memory-db.ts` opens a separate `better-sqlite3` database—not `CrdtStore`. | Keep service mode as the shared-memory path. Legacy mode remains supported only as an independent VS Code database and must reject a configured PluresLM service-store path; it must never become a compatibility fallback that opens a PluresDB store. The current fallback from failed service initialization to legacy mode must be changed in its future migration PR to fail closed when the user selected shared service mode. |
| **Agency** (Pares Agens external-memory bridge) | **Violates through the same native-core path; bridge design itself is compliant** | Agency is Pares Agens. Its native core memory path is the violating `crates/core/src/memory/store.rs` path above. ADR-0017 specifies a distinct, optional MCP bridge that uses `pluresLM_search`/`status` and never opens the remote store. | Apply the Pares Agens migration above to the native path. Preserve ADR-0017's bridge: opt-in, read-mostly, externally labeled, MCP-only, and never wired into implicit recall/capture. Do not “fix” the native path by routing core per-turn memory through MCP. |
| **OpenClaw** (`plures/plureslm-openclaw`) | **Violates boundary** | The OpenClaw plugin's native PluresDB manager owns the memory store inside the host plugin process (captured source lines below); this is the known incident described in `PLURESDB-SERVICE-BOUNDARIES.md` and ADR-0002. | Split adapter from ownership: the plugin registers OpenClaw-facing tools only and sends all operations to the PluresLM Memory Service. Main agent, `active-memory`, cron, CLI, Scout, and MCP call the same service. Capability advertisement is health-gated and service failure returns an explicit unavailable error—not empty recall results. |

### Source evidence captured from the audited revisions

The following mechanically captured locations are deliberately retained with the ADR so a reviewer can verify the classification against the exact source revision. `NO_MATCH` is evidence that the requested direct-CrdtStore pattern was not found, not an assertion that the repository has no other persistence code.

```text
pares-agens: crates\core\src\memory\store.rs:6: use pluresdb::{CrdtStore, MemoryStorage, SledStorage, StorageEngine};
pares-agens: crates\core\src\memory\store.rs:208: /// Generate a new sync shared key payload accepted by [`PluresDbStore::open_with_sync`].
pares-agens: crates\core\src\memory\store.rs:225: /// A [`MemoryStore`] backed by a PluresDB [`CrdtStore`].
pares-agens: crates\core\src\memory\store.rs:228: /// [`PluresDbStore::open`].  An ephemeral variant (backed by
pares-agens: crates\core\src\memory\store.rs:234: /// [`CrdtStore::put_with_embedding`]) so that future vector-search queries can
pares-agens: crates\core\src\memory\store.rs:237: store: Arc<CrdtStore>,
pares-agens: crates\core\src\memory\store.rs:243: /// Return a reference to the underlying [`CrdtStore`].
pares-agens: crates\core\src\memory\store.rs:247: pub fn crdt_store(&self) -> &CrdtStore {
pares-agens: crates\core\src\memory\store.rs:251: /// Return a shared reference-counted handle to the underlying [`CrdtStore`].
pares-agens: crates\core\src\memory\store.rs:252: pub fn crdt_store_arc(&self) -> Arc<CrdtStore> {
pares-agens: crates\core\src\memory\store.rs:264: SledStorage::open(path).map_err(|e| Error::Store(format!("open failed: {e}")))?,
pares-agens: crates\core\src\memory\store.rs:266: let store = CrdtStore::default().with_persistence(storage);
pares-agens: crates\core\src\memory\store.rs:288: SledStorage::open(&path).map_err(|e| Error::Store(format!("open failed: {e}")))?,
pares-agens: crates\core\src\memory\store.rs:292: let store = CrdtStore::default()
pares-agens: crates\core\src\memory\store.rs:298: CrdtStore::spawn_embedding_worker(Arc::clone(&arc_store));
pares-agens: crates\core\src\memory\store.rs:303: // The worker holds an Arc, and we hold a clone of the CrdtStore.
scout: scout-mcp\plureslm-mcp.mjs:51: dbPath: argValue("db-path") ?? process.env.PLURESLM_DB_PATH,
scout: scout-mcp\plureslm-mcp.mjs:80: if (!config.dbPath) {
scout: scout-mcp\plureslm-mcp.mjs:89: dbPath: config.dbPath,
scout: scout-mcp\plureslm-mcp.mjs:261: description: "Recall memories from PluresDB using vector search, text fallback, and optional graph expansion.",
scout: scout-mcp\plureslm-mcp.mjs:324: dbPath: status.dbPath,
scout: scout-hooks\hooks\plureslm-autorecall.mjs:16: * - PLURESLM_DB_PATH: absolute path to the PluresDB store.
scout: scout-hooks\hooks\plureslm-autorecall.mjs:115: `Backend: ${status.dbPath}`,
scout: scout-hooks\hooks\plureslm-autorecall.mjs:154: const dbPath = process.env.PLURESLM_DB_PATH;
scout: scout-hooks\hooks\plureslm-autorecall.mjs:155: if (!dbPath) {
scout: scout-hooks\hooks\plureslm-autorecall.mjs:172: dbPath,
vscode: src\memory-provider.ts:29: const { PluresLMServiceClient } = await import('./service-client');
vscode: src\memory-provider.ts:30: const client = new PluresLMServiceClient(
vscode: src\memory-provider.ts:121: this.db = new MemoryDB(dbPath, this.embeddings.dimension);
vscode: src\memory-db.ts:69: this.db = new Database(dbPath);
vscode: src\memory-db.ts:586: this.db = new Database(this.dbPath);
openclaw: src\index.ts:14: *   - dbPath:        absolute path to the PluresDB store directory
openclaw: src\index.ts:35: dbPath?: string;
openclaw: src\index.ts:48: const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : undefined;
openclaw: src\index.ts:62: return { dbPath, serviceUrl, embeddingModel, vectorThreshold, maxResults, sourceDir, compressAboveTokens, reactivePx, reactivePxPolicy };
openclaw: src\index.ts:97: if (!cfg.dbPath) return null;
openclaw: src\index.ts:99: dbPath: cfg.dbPath,
openclaw: src\index.ts:122: if (!cfg.serviceUrl && !cfg.dbPath) return null;
openclaw: src\index.ts:146: return toolJson({ disabled: true, unavailable: true, error: "serviceUrl or dbPath not configured" });
openclaw: src\index.ts:172: if (!cfg.serviceUrl && !cfg.dbPath) return null;
openclaw: src\index.ts:200: return toolJson({ disabled: true, unavailable: true, error: "serviceUrl or dbPath not configured" });
openclaw: src\index.ts:222: } else if (cfg.dbPath) {
openclaw: src\index.ts:224: `[plureslm] registering read+write memory capability over ${cfg.dbPath}`,
openclaw: src\index.ts:228: "[plureslm] no serviceUrl or dbPath configured; registering an inert memory capability.",
openclaw: src\memory-capability.ts:204: dbPath: string;
openclaw: src\memory-capability.ts:232: dbPath: cfg.dbPath,
openclaw: src\memory-capability.ts:389: * A `MemorySearchManager` backed by one PluresDB store. Exposed for the test
```

## Required enforcement (not manual guidance)

This decision is not satisfied by documentation or code review alone. Before any migration ships, the following CI controls are mandatory and every affected repository must make them required on pull requests:

1. **`plureslm-single-store-owner` static policy:** a versioned shared checker accepts an allowlist of the one service-owner module per product and fails on production-source imports or calls matching `pluresdb::CrdtStore`, `SledStorage::open`, native `PluresDB` constructors, or direct store-path configuration outside that owner. Tests, fixtures, generated files, and explicitly declared independent local-store backends are scoped exclusions—not blanket path exclusions.
2. **Configuration policy:** service-mode adapters must fail closed if service startup/health fails. They may not silently fallback to a direct/shared-store configuration. Any independent local-store mode requires a distinct path/topic and an explicit `singleConsumerDirectStore` declaration validated by the checker.
3. **Praxis constraint:** each product’s live model exposes `memoryStoreOwner` and every adapter's memory transport. A severity-`error` expectation fails if more than one owner exists for a topic/path or if an adapter has `direct_store_open=true`. The constraint must run in CI with real configuration fixtures.
4. **Integration regression test:** start a real disposable service; concurrently drive at least two independent clients; then kill/restart the service and verify reconnect plus explicit unavailable behavior. A second out-of-band direct open of that store must fail and must be treated as a regression signal. No channel adapter is part of this test.

The initial checker and Praxis expectation are required deliverables of the first migration implementation PR; a migration PR may not be merged until both are enabled as required checks. This fulfils C-DRIFT-001's requirement for an enforceable invariant rather than manual-only guidance.

## Consequences

- All shared PluresLM users gain one consistent ownership, recovery, and capability-health model.
- The performance-sensitive Pares Agens native loop remains local IPC/in-process; it does not acquire a network/MCP dependency.
- Existing direct modes become explicit and narrow instead of accidental compatibility paths.
- The migration is staged: this ADR changes no runtime behavior. Each product will need a separate implementation PR with tests, an ownership allowlist entry, and the CI/Praxis enforcement enabled.

## Verification gate for follow-up implementation PRs

A follow-up is incomplete unless it demonstrates:

1. no production direct-store opening outside the service owner;
2. two concurrent clients work through the service;
3. service restart/reconnect preserves data and avoids stale locks;
4. service-mode failure does not fall back to a shared direct store or claim empty results;
5. the shared checker and Praxis constraint fail a deliberately introduced prohibited direct open.
