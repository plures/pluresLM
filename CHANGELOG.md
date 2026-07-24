## [2.2.0] — 2026-07-24

- ci(release): trigger release pipeline on merge to main (#153) (31922c8)
- ci: migrate Tech Doc Writer to shared reusable (73c926d)
- fix(ci): repair tech-doc-writer YAML indentation / remove empty workflow (54baae8)
- ci: add security-aware Dependabot auto-merge workflow (org backfill) (bf86cef)
- feat(reliability): session recovery across MCP daemon restarts (#146) (#152) (16a2f74)
- feat(reliability): daemon health + degraded-mode + clear error states (#147, #150) (#151) (d125bc3)
- fix: add svelte as direct dependency + load smoke test (a649e44)
- ci: change release trigger from push-to-main to tag-only (b52c1f3)
- refactor: replace inline lifecycle with reusable workflow call (dd6d962)
- docs: refresh ROADMAP.md with OASIS strategic alignment (3d85073)
- fix: add category diversity cap to vectorSearchBoosted (#145) (a5afb06)
- fix: downgrade no-explicit-any to warn to unblock CI (9abb456)
- docs: update copilot-instructions with praxis, design-dojo, automation rules (0bac645)
- feat(release): add target_version input for milestone-driven releases (4c16743)
- feat(lifecycle): milestone-close triggers roadmap-aware release (fab35cc)
- feat(lifecycle v12): auto-release when milestone completes (8a5e1b6)
- feat(lifecycle v11): smart CI failure handling — infra vs code (b13adaa)
- fix(lifecycle): label-based retry counter + CI fix priority (e719dcf)
- feat: before_tool_call constraint enforcement (praxis enforcement layer) (c9a93ea)
- feat: brain-first authorization gate (ADR-0012 update) (5cbaf94)
- feat: implement authorization gate for procedure actions (ADR-0012) (3faadac)
- feat: reactive procedure dispatch + cognitive architecture bridge (9ebbd14)
- feat: session-start recall now surfaces stale tasks and hard constraints (3f64f3e)
- ci: inline lifecycle workflow — fix schedule failures (a13102e)
- fix: auto-reset MCP session on any error, not just session-specific codes (b5bf848)
- fix: rewire graph tools to dedicated daemon endpoints (3fc84f8)
- docs: add structured ROADMAP.md for automated issue generation (47b1390)
- Initial plan (#144) (18ead30)
- fix: resolve ESLint CI failures across 18 source files (#143) (eb9869f)
- fix: resolve TypeScript build errors blocking CI (api-handlers + migrate-to-pluresdb) (#139) (fa99f15)
- chore: centralize CI to org-wide reusable workflow (dee8193)
- ci: standardize Node version to lts/* — remove hardcoded versions (fddde10)
- fix: restore archived sources, fix @plures/praxis dep, implement missing API handlers (#137) (1f45aa2)
- ci: centralize lifecycle — event-driven with schedule guard (fe599f2)
- fix(lifecycle): v9.1 — fix QA dispatch (client_payload as JSON object) (b2a6c0a)
- fix(lifecycle): rewrite v9 — apply suggestions, merge, no nudges (e68f532)
- feat: Phase 2 — decision-ledger analysis coprocessor in PluresLM (#132) (fc05ab7)
- Initial plan (#131) (9cc6044)
- Initial plan (#130) (c808331)
- feat: compact JSONL format for memory recall injection (6b28e45)
- fix: improve auto-capture quality filters (b8333eb)
- feat: re-enable praxis via @plures/praxis/core subpath (Svelte-free) (509b63e)
- fix: disable @plures/praxis entirely until npm package ships Svelte-free (#317) (648f88d)
- fix: use require() instead of top-level await for optional praxis import (fadab64)
- fix: make @plures/praxis optional — svelte/internal/client breaks in Node (3e96977)
- fix: build dist with vector search fix, add missing @plures/praxis dep, fix TS strict errors (4c9f46d)
- fix: route pluresLM_search to vector search instead of text search (c6fd62e)
- chore: license BSL 1.1 (commercial product) (a929751)
- chore: standardize copilot-pr-lifecycle.yml to canonical version (3688d40)
- docs: add ROADMAP.md (e3648f2)
- chore: cleanup and housekeeping (741ba77)
- chore: add standard CI workflow (59b6389)
- chore: enforce strict type-safety across org (b9e76f3)
- chore: standardize lint-clean across org (ea55d62)
- chore: apply org-standard automation files (#129) (a4af78e)
- feat: adopt @plures/praxis for declarative logic management (#128) (2b22ec5)
- Initial plan (#71) (639c044)
- feat: dynamic context budget based on model contextWindow (#126) (318accc)
- fix: add content-hash dedup cache to prevent duplicate auto-captures (234ccaf)
- feat: expose procedure tools (create, run, list, update, delete) (4b7ac68)
- refactor: rewrite as thin MCP client plugin (588af50)
- docs: clarify relationship to pluresLM-mcp v2.0 (bfbf50a)
- docs: rewrite README for v2.0 MCP service architecture (cbb77be)
- fix: revert to directory paths for pluresDB after removing sqlite (fa065c9)
- feat(mcp): expose bundle/pack restore-import and training export tools (b9be190)
- fix(pluresdb): enforce embedding-enabled init and clarify dbPath semantics (194225b)
- fix: bump @plures/pluresdb to 2.9.7 to resolve missing postinstall script (#125) (9b1ed45)
- docs: plan pluresLM installers, MCP docker registration, and policy-controlled multi-client service (f037ed2)
- feat(plugin): default to service mode; require PLURESLM_MODE=plugin-local to bypass (abde889)
- fix(service-bridge): set default service store path for spawned service (9ca2944)
- feat(plugin): add service-mode bridge for core memory tools (20f489e)
- feat(service): introduce plureslm-service entrypoint and explicit store path mode (9bf35e3)
- docs+test: add stable MCP contract and smoke check (119121b)
- feat: add pluresLM standalone MCP server entrypoint (07f35a8)
- feat: optimization-trap memory schema + retrieval hooks (#123) (4265b9f)
- ci: add PR lane event relay to centralized merge FSM (65ef493)
- feat: classifier signal pipeline for optimization training data (#121) (b501be9)
- Rename Superlocalmemory to Plures Local Memory (12bb694)
- fix(ci): prevent sync-version failures on closed PRs; align release.yml with org standard (#119) (d78d416)
- feat: Memory Module Packs — shareable, signed, versioned curated memory sets (#118) (1751900)
- feat: tiered memory storage with archive policy engine and selective attach/detach (#117) (9740b35)
- feat(index): add training data export APIs (#116) (4ce81fa)
- fix(docs): align DESIGN.md with v2.0.0 implementation (#114) (1e028dc)
- Revert "feat(boundary): enforce PluresDB engine vs pluresLM memory application layer" (#111) (a91ddbb)
- feat(boundary): enforce PluresDB engine vs pluresLM memory application layer (#106) (193841b)
- feat(capture-quality): detect training signals from conversation turns (#104) (7663fe8)
- feat: add document ingestion API endpoint (#103) (8d5466a)
- feat(types): extend memory schema with training data fields (#102) (cc3be76)
- feat: add document processing and chunking pipeline (#101) (11eee27)
- feat(google-drive): add GoogleDriveClient with gog CLI integration (#100) (e1db7b1)
- fix(sync): add DB adapter layer to decouple sync protocol from PluresDB backend (#99) (b779d8c)
- feat(sync): add data exchange logging — memories sent/received/deduped per peer (#97) (367773b)
- feat(types): add document content type schemas (#95) (0528736)
- fix(sync): make Hyperswarm sync fire-and-forget — never block plugin startup (#94) (b7f3dc9)
- fix(ci): add id-token permission to release workflow (#90) (a01ca5b)
- fix: add 30s timeout to Hyperswarm DHT bootstrap in sync.start() (#81) (a264156)
- feat: Rust-native recall/capture API for Pares Agens (#79) (9bcbab5)
- fix: tighten capture quality gate and category detection (#77) (03fc057)
- fix: wire IPC handler startup + show full memory IDs in forget (#76) (4d675ec)
- chore: organize root files into proper directories (#75) (9467eea)
- fix: normalize plugin id to plureslm (#74) (9559b08)
- fix: align plugin id with npm package name (#73) (cf0e7e3)
- test: integration tests for hooks (#69) (b57e155)
- feat: wire PatternEngine into agent_end auto-capture pipeline (#67) (7314f84)
- feat: quality gate for auto-capture — skip noise, keep signal (#70) (ef6a520)
- refactor: ContextManager uses vectorSearchBoosted instead of word overlap (#68) (f46e2c1)
- chore: sane config defaults + npm publish preparation (#72) (629df68)
- refactor: simplify CompatibilityLayer to mode detection + feature gating (#66) (a9c64a5)
- feat: exclude project-context from auto-recall by default (2665c93)
- fix: preemptive mitigations for memory bloat and feedback loops (60c8b87)
- fix: enforce hard character budget on context injection (23ba263)
- chore: remove SQLite dead code, stub tests, and stale docs (46e8dcf)
- chore: sync openclaw.plugin.json version to 2.0.0 [skip ci] (6f176e6)
- refactor: migrate all test setup to PluresDBBackend, remove better-sqlite3 from tests (4706f48)
- test: migrate importance-boost tests and db helper to PluresDB backend (7e06f16)
- fix: make better-sqlite3 import lazy in memory-db.ts to fix CI test failures (2a547de)
- fix: address PR review feedback on graph operations integration (30e2c7e)
- fix: address PR review feedback on graph operations integration (8f4fcb8)
- chore: sync openclaw.plugin.json version to 1.0.0 [skip ci] (e966a69)
- feat: integrate Phase 2A graph operations and enable memory relationship discovery (e45134c)
- Initial plan (d3e07f9)

## [2.0.0] — 2026-02-25

- chore: add .fastembed_cache to .gitignore (afb649c)
- fix: dashboard CLI uses gateway IPC when gateway is running (3a892a8)
- fix: simplify CLI logic - no fallback, clean gateway/IPC detection (5fab6fc)
- ✅ IMPLEMENTED: Smart database lock handling with fallback strategy (0679baa)
- 🔧 FIX: Process isolation database conflicts (7d4c2cc)
- 🔄 DUAL-MODE ARCHITECTURE: Enhanced + Vanilla OpenClaw compatibility (e5bbe10)
- 🔧 DATABASE DIRECTORY OVERRIDE: Configurable base path with process isolation (aa2495a)
- 🚀 SMART MEMORY ARCHITECTURE: Process isolation + Auto memory.md + Real-time context (f33c8b5)
- SECURITY: Remove unsafe direct indexing paths (ad3c85c)
- docs: comprehensive Phase 2 implementation status and handoff roadmap (e91e668)
- docs: add comprehensive PluresDB procedures documentation (c3a6afc)
- feat: update PluresDB to v2.1.0 with procedures support (232c3c6)
- feat: add PluresDB procedures query interface (Phase 1) (bc93a03)
- feat: auto-consolidate on startup (e4fab96)
- fix: rename SLM references, gate migration commands behind PLURESLM_DEV (7764cc6)
- fix: await ensureDbOpen in dashboard, rename remaining UI strings (5a5c674)
- refactor: rename superlocalmemory_ tools to pluresLM_ (fa9a9ec)
- feat: add MEMORY.md ingestion script (4e1aa9d)
- chore: sync openclaw.plugin.json version to 1.0.0 [skip ci] (7015209)
- feat: wire PluresDB persistence + background vector index (0b7d02a)
- chore(release): v1.0.0 (f0b1b23)
- feat: register memoryStatus provider for openclaw status display (6bb1646)
- feat: prepare for production install with npm package support (4f4de05)
- chore: sync openclaw.plugin.json version to 0.20.0 [skip ci] (a87d881)
- feat!: replace SQLite/Deno shim with PluresDB native NAPI backend (8248713)
- chore(release): v0.20.0 (5a43570)
- test: comprehensive vitest suite for pluresLM v1.0 (#54) (388479f)
- feat: YAML-extensible operational memory patterns (#52) (a77548d)
- feat(ops): absorb rock-lobster operational memory modules into pluresLM (#50) (3b0589c)
- chore(release): v0.19.1 (4409d08)
- fix: opts metadata lost on dedup merge in PluresDB and MemoryDB backends (#46) (541e520)
- chore(release): v0.19.0 (921956c)
- feat: automatic conversation tagging via vector similarity (#44) (81fbbc1)
- chore(release): v0.18.0 (8b7e3be)
- feat: memory attribution + implicit claims for multi-agent coordination (#43) (a70f2f8)
- chore: add copilot instructions and org standards (3c6d47a)
- chore(release): v0.17.0 (ca4d708)
- feat: SQLite → PluresDB data migration script (#42) (c281629)
- chore(release): v0.16.1 (0eedc4b)
- fix: prefer PluresDB backend over better-sqlite3 in auto-detection (#40) (38fe74d)
- chore(release): v0.16.0 (633306c)
- feat: native PluresDB CRDT backend — replace better-sqlite3 compatibility shim (#36) (5126f28)
- chore(release): v0.15.2 (7170eb3)
- fix: eliminate dual-clone deployment — single source of truth for plugin code (#29) (80c384a)
- chore(release): v0.15.1 (451dcd7)
- fix: add startup self-test — verify embeddings, dimensions, kind, and DB integrity on load (#28) (a5f717a)
- ci: sync openclaw.plugin.json version with package.json in release workflow (#30) (9ef229e)
- chore(release): v0.15.0 (cdf76a0)
- feat: add importance_score for memory importance boosting in time-decay recall (#27) (a4d2685)
- chore(release): v0.14.0 (ea0a56f)
- feat: migration path from manual files to SLM-only memory (#21) (b3f11b8)
- chore(release): v0.13.0 (55eda8b)
- feat: automatic daily summary generation from captured memories (#20) (42a85e2)
- chore(release): v0.12.2 (f5feba5)
- fix: plugin kind must be 'extension' not 'memory' (1b0d366)
- chore(release): v0.12.1 (68903d5)
- fix: sync openclaw.plugin.json version with package.json (0.12.0) (4e615d1)
- docs: add ROADMAP.md, upgrade script, fix TS2590 in embeddings (55fed2f)
- chore(release): v0.12.0 (766fa77)
- feat: replace Ollama with Transformers.js as default embeddings (7e04aca)
- chore(release): v0.10.0 (23e52a4)
- feat: session-start context injection (#13) (25edfa8)
- chore(release): v0.8.0 (0a056df)
- feat: Automated memory consolidation with priority scoring and staleness detection (#19) (fd42689)
- chore(release): v0.7.0 (f868585)
- feat: add before_compaction lifecycle hook to capture context before conversation reset (#17) (4f7cf59)
- chore(release): v0.6.0 (ff3ca2c)
- chore: rename to Plures LM (@plures/pluresLM) (32faacd)
- feat: dual local Ollama (GPU primary + CPU fallback) (957806c)
- feat: switch to 100% local Ollama embeddings (snowflake-arctic-embed2, 1024-dim) (1db8d60)
- docs: add DESIGN.md and ROADMAP.md (f933c27)
- chore(release): v0.4.1 (e7c1f6b)
- ci: add standardized release pipeline (658248c)
- Add PluresDB backend with async interface migration (#9) (e51db4b)
- feat: add slm dashboard CLI for memory system health (#8) (d9e2f9f)
- feat: time-decay scoring and semantic dedup v2 (#7) (2ebd92b)
- fix: plugin lifecycle hooks never fired due to incorrect kind declaration (#6) (3efd438)
- fix: resolve stale DB, embedding auth, and Node compat issues (#1) (ecba5e5)
- feat: superlocalmemory v0.3.0 — vector memory + code intelligence + Hyperswarm sync (bd6e330)
- Initial commit (4849ef3)

## [1.0.0] — 2026-02-23

- feat: register memoryStatus provider for openclaw status display (df7ac02)
- feat: prepare for production install with npm package support (ea50a1f)
- chore: sync openclaw.plugin.json version to 0.20.0 [skip ci] (08e1a1f)
- feat!: replace SQLite/Deno shim with PluresDB native NAPI backend (d4aa9b4)

## [0.20.0] — 2026-02-23

- test: comprehensive vitest suite for pluresLM v1.0 (#54) (6ab220a)
- feat: YAML-extensible operational memory patterns (#52) (aecc771)
- feat(ops): absorb rock-lobster operational memory modules into pluresLM (#50) (f3ef252)

## [0.19.1] — 2026-02-23

- fix: opts metadata lost on dedup merge in PluresDB and MemoryDB backends (#46) (b7d7e65)

## [0.19.0] — 2026-02-23

- feat: automatic conversation tagging via vector similarity (#44) (bd3b178)

## [0.18.0] — 2026-02-23

- feat: memory attribution + implicit claims for multi-agent coordination (#43) (a724f35)
- chore: add copilot instructions and org standards (0390dd9)

## [0.17.0] — 2026-02-23

- feat: SQLite → PluresDB data migration script (#42) (a80dff3)

## [0.16.1] — 2026-02-22

- fix: prefer PluresDB backend over better-sqlite3 in auto-detection (#40) (563c11a)

## [0.16.0] — 2026-02-22

- feat: native PluresDB CRDT backend — replace better-sqlite3 compatibility shim (#36) (8f57c44)

## [0.15.2] — 2026-02-21

- fix: eliminate dual-clone deployment — single source of truth for plugin code (#29) (ec4afe6)

## [0.15.1] — 2026-02-20

- fix: add startup self-test — verify embeddings, dimensions, kind, and DB integrity on load (#28) (6715bf6)
- ci: sync openclaw.plugin.json version with package.json in release workflow (#30) (e92c01e)

## [0.15.0] — 2026-02-20

- feat: add importance_score for memory importance boosting in time-decay recall (#27) (553853e)

## [0.14.0] — 2026-02-20

- feat: migration path from manual files to SLM-only memory (#21) (92409cc)

## [0.13.0] — 2026-02-19

- feat: automatic daily summary generation from captured memories (#20) (c3e8434)

## [Unreleased]

### Added
- **Daily summary generation**: Automatically generate structured summaries from captured memories
  - `generateDailySummary(date)` method to create summaries for a specific date
  - `getDailySummaries(days)` method to retrieve recent summaries
  - Two new tools: `superlocalmemory_generate_daily_summary` and `superlocalmemory_get_daily_summaries`
  - Summaries stored as memories with category `daily-summary` and tag `daily-summary:YYYY-MM-DD`
  - Organized by category with time-ordered entries
  - Significantly reduces token costs by eliminating manual daily file writes
## [0.12.2] — 2026-02-19

- fix: plugin kind must be 'extension' not 'memory' (7a5156c)

## [0.12.1] — 2026-02-19

- fix: sync openclaw.plugin.json version with package.json (0.12.0) (83ed06e)
- docs: add ROADMAP.md, upgrade script, fix TS2590 in embeddings (c1a9827)

## [0.12.0] — 2026-02-18

- feat: replace Ollama with Transformers.js as default embeddings (c454a6d)

## [0.10.0] — 2026-02-18

- feat: session-start context injection (#13) (0e1c629)

## [0.9.0] — 2026-02-18

### Major Features

- **Session-start context injection** — Proactively injects important memories at session start (before first user message)
  - Replaces manual MEMORY.md reading ritual that burns tokens
  - Configurable via `sessionStartRecall` with priority categories and recency bias
  - Includes user profile and up to 20 priority memories by default
  - Smart weighted sampling favors recent memories while maintaining diversity

### New Configuration

- Added `sessionStartRecall` configuration object:
  - `enabled` (default: true) — Enable/disable session-start injection
  - `maxMemories` (default: 20) — Max memories to inject at session start
  - `priorityCategories` (default: decision, preference, explicit, work-in-progress) — Categories to prioritize
  - `recencyBias` (default: 0.7) — Weight for recent vs older memories (0-1)

### Backend API

- Added `getMemoriesByCategories()` method to IMemoryBackend interface
- Implemented in both MemoryDB (better-sqlite3) and PluresDBBackend
- Uses exponential decay with recency bias for smart memory selection

### Testing

- New comprehensive test suite in `test-session-start.ts` (20 tests, all passing)
- Validates category filtering, limit enforcement, recency bias, and profile integration

## [0.8.0] — 2026-02-18

- feat: Automated memory consolidation with priority scoring and staleness detection (#19) (a68debf)

## [0.7.0] — 2026-02-17

- feat: add before_compaction lifecycle hook to capture context before conversation reset (#17) (ac4f8e8)

## [Unreleased]

### Added

- **Compaction lifecycle hook** — New `before_compaction` hook captures critical context before OpenClaw conversation resets
  - Stores full compaction summary with session metadata
  - Extracts code patterns, decisions, and WIP items from summary
  - Tags all memories with `category: 'compaction-snapshot'` for easy retrieval
  - Eliminates need for manual pre-compaction memory flush to markdown files
## [0.6.0] — 2026-02-17

- chore: rename to Plures LM (@plures/pluresLM) (afeac4a)
- feat: dual local Ollama (GPU primary + CPU fallback) (452b25d)
- feat: switch to 100% local Ollama embeddings (snowflake-arctic-embed2, 1024-dim) (db40c4a)
- docs: add DESIGN.md and ROADMAP.md (56d3f58)

## [0.4.1] — 2026-02-14

- ci: add standardized release pipeline (90a5173)
- Add PluresDB backend with async interface migration (#9) (c4f1e5f)
- feat: add slm dashboard CLI for memory system health (#8) (fbc3a77)
- feat: time-decay scoring and semantic dedup v2 (#7) (15f4e3e)
- fix: plugin lifecycle hooks never fired due to incorrect kind declaration (#6) (05cb838)
- fix: resolve stale DB, embedding auth, and Node compat issues (#1) (e32f1da)
- feat: superlocalmemory v0.3.0 — vector memory + code intelligence + Hyperswarm sync (7db5a6b)
- Initial commit (5dd8262)

# Changelog

## v0.4.0 (PluresDB Migration)

### Major Changes

- **PluresDB backend support** — Added `@plures/pluresdb` as an optional peer dependency and alternative backend
- **Backend factory pattern** — New `backend-factory.ts` with `createBackend()` for runtime backend selection
- **Fully async interface** — All MemoryDB methods now return Promises for PluresDB compatibility
- **Migration utility** — New `migrate.ts` script to migrate data from better-sqlite3 to PluresDB

### Configuration

- New `backend` config option: `"better-sqlite3"` (default) or `"pluresdb"`
- Updated documentation with PluresDB migration guide
- Added rollback instructions

### Breaking Changes

- All database methods are now async (return Promises instead of direct values)
- Code using MemoryDB must add `await` to all method calls

### Migration Notes

- Existing better-sqlite3 databases continue to work by default
- To use PluresDB: `npm install @plures/pluresdb` and set `backend: "pluresdb"` in config
- Run `npm run migrate <source> <target>` to migrate existing data

## v0.3.0

- Hyperswarm-based P2P sync (optional): full sync + delta sync over NDJSON
- New tools: `superlocalmemory_sync_status`, `superlocalmemory_sync_keygen`
- New slash command: `/sync-status`

## v0.2.0

- Code intelligence: code pattern extraction from conversations (functions, types, module composition, API patterns)
- Error → fix pair capture with graph edges (`fixed-by`)
- Work-in-progress (WIP) detection and boosted recall for WIP items
- Project indexing: chunk & embed project files as `project-context`

## v0.1.0

- Initial release: SQLite-backed memory store with embeddings, vector search, dedupe, and basic OpenClaw integration
