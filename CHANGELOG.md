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
