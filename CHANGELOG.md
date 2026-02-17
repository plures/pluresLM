## [0.5.0] — 2026-02-17

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
