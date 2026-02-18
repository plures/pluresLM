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
