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
