# pluresLM Roadmap

> Local-first long-term memory for AI agents. Zero config. No cloud required.

## Current State — v0.11.0

pluresLM is a production-ready OpenClaw extension plugin providing persistent vector memory with semantic search, code intelligence, and P2P sync.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  pluresLM Plugin                │
├──────────┬──────────┬──────────┬────────────────┤
│ 10 Tools │ 3 Hooks  │  Sync    │ Project Index  │
├──────────┴──────────┴──────────┴────────────────┤
│             Embedding Providers                  │
│  ┌──────────────────┐  ┌─────────────────────┐  │
│  │ Transformers.js  │  │  Ollama (optional)  │  │
│  │ bge-small 384d   │  │ arctic-embed 1024d  │  │
│  │ 33MB, in-process │  │ 1.2GB, GPU accel    │  │
│  └──────────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────┤
│              Storage Backends                    │
│  ┌──────────────────┐  ┌─────────────────────┐  │
│  │  better-sqlite3  │  │  PluresDB (optional)│  │
│  │  (default)       │  │  (peer dep)         │  │
│  └──────────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────┤
│           Hyperswarm P2P Sync                    │
│  (available, disabled by default)                │
└─────────────────────────────────────────────────┘
```

### What Works Today

| Feature | Status | Notes |
|---------|--------|-------|
| **Embeddings: Transformers.js** | ✅ Default | `Xenova/bge-small-en-v1.5`, 384-dim, 33MB, in-process |
| **Embeddings: Ollama** | ✅ Optional | `snowflake-arctic-embed2`, 1024-dim, GPU-accelerated |
| **Storage: better-sqlite3** | ✅ Default | In-process cosine similarity, graph edges |
| **Storage: PluresDB** | ✅ Optional | Peer dependency, async interface |
| **Auto-recall** | ✅ | Injects relevant memories before each agent turn |
| **Auto-capture** | ✅ | Captures memories after each turn (code patterns, error-fix pairs, WIP) |
| **Session-start injection** | ✅ | Priority memories injected at session start (#13) |
| **Compaction hook** | ✅ | Captures context before conversation reset (#17) |
| **Memory consolidation** | ✅ | Merge duplicates, demote stale, promote reinforced (#14) |
| **Project indexing** | ✅ | Recursive .ts/.md/.rs/.py chunking + embedding |
| **Hyperswarm P2P sync** | ✅ | Key-based peer discovery, delta sync |
| **Profile building** | ✅ | Auto-distilled user profile from memories |
| **Semantic dedup** | ✅ | Configurable cosine threshold |
| **Code intelligence** | ✅ | Pattern extraction, type definitions, architecture decisions |
| **Graph edges** | ✅ | Error→fix pairs, related memories |
| **10 tools exposed** | ✅ | store, search, forget, profile, index, sync_keygen, sync_status, consolidate, world_state, find_stale |

### What's Missing

| Gap | Issue | Priority |
|-----|-------|----------|
| Daily summary generation | #15 | High |
| Migration from manual files | #16 | High |
| Time-decay memory weighting | #11 | Medium |
| Plugin hook reliability | #10 | Medium |

---

## Phase 1 — Complete SLM Takeover (v0.12–v0.14)

**Goal**: pluresLM handles ALL memory functions. No more triple-redundant memory systems (built-in memory_search + pluresLM + manual MEMORY.md files).

### v0.12.0 — Daily Summaries (#15)
- Auto-generate daily activity summaries from captured memories
- Replace manual `memory/YYYY-MM-DD.md` files
- Summaries stored as `daily-summary` category with date tags
- Configurable: `dailySummary.enabled`, `dailySummary.generateAt` (hour)
- Hook: `agent_end` triggers accumulation; cron or session-start triggers summary generation

### v0.13.0 — File Migration Tool (#16)
- CLI command: `slm migrate --source ./memory/ --source ./MEMORY.md`
- Parse markdown files → extract facts/decisions/preferences
- Embed and store as categorized memories with provenance tags
- Dedup against existing DB content
- Dry-run mode with preview
- One-time migration, not ongoing sync

### v0.14.0 — Time-Decay & Hook Hardening (#11, #10)
- Exponential time-decay weighting in vector search scoring
- Configurable half-life (default: 30 days)
- Access-time refresh: recalled memories reset their decay clock
- Harden lifecycle hook reliability (#10): retry logic, timeout guards, graceful degradation

**Exit criteria**: Agent can operate with ZERO manual memory files. All continuity provided by pluresLM.

---

## Phase 2 — Zero-Dependency Distribution (v0.15–v0.17)

**Goal**: `npm install @plures/pluresLM` → works. No native compilation. No external services. No model downloads blocking startup.

### v0.15.0 — Remove Native Compilation Requirement
- **Evaluate pure-JS SQLite alternatives**: `sql.js` (Emscripten SQLite) or `better-sqlite3-multiple-ciphers`
- If `sql.js` performance is acceptable (benchmark: <5ms per vector search at 10K memories), switch default
- Keep `better-sqlite3` as optional high-performance backend
- Goal: eliminate `node-gyp` / native addon compilation entirely for default installs

### v0.16.0 — Lazy Model Loading
- Model download happens on **first embed call**, not plugin init
- Progress callback for download status
- Cache models in `~/.cache/pluresLM/models/` (XDG-compliant)
- Offline mode: if model already cached, skip network entirely
- Startup time: <100ms (no model load until needed)

### v0.17.0 — Dimension Migration Tool
- Detect dimension mismatch on startup (e.g., 1024-dim DB + 384-dim model)
- Offer automatic re-embedding: batch process all memories with new model
- Progress reporting for large DBs
- Backup original DB before migration
- `slm migrate-embeddings --from 1024 --to 384` CLI command

**Exit criteria**: Fresh `npm install` on any platform (Windows, macOS, Linux) → plugin loads → embeddings work. Zero manual setup.

---

## Phase 3 — PluresDB Native Backend (v0.18–v0.20)

**Goal**: Replace better-sqlite3 with PluresDB for CRDT sync, graph queries, and unified Plures ecosystem storage.

> Blocked by: `@plures/pluresdb-native` N-API binary publication ([pluresdb#74](https://github.com/plures/pluresdb/issues/74))

### v0.18.0 — PluresDB Backend Parity
- Map all 47 prepared statements from `memory-db.ts` to PluresDB `query(sql, params)` + `exec(sql)` API
- Integration tests: identical behavior for all IMemoryBackend methods
- Benchmark: PluresDB vs better-sqlite3 for vector search at 1K/10K/100K memories
- Consolidation, world state, stale detection on PluresDB backend

### v0.19.0 — PluresDB Default + Migration
- Switch default backend from `better-sqlite3` to `pluresdb`
- Migration tool: `slm migrate-backend --from sqlite --to pluresdb`
- Export/import all memories including embeddings, edges, profile, sync state
- Automatic migration on first start if old SQLite DB detected
- Rollback: `slm migrate-backend --from pluresdb --to sqlite`

### v0.20.0 — CRDT-Powered Sync
- Replace Hyperswarm-based sync protocol with PluresDB's built-in CRDT sync
- Sync operates at the database level, not memory-by-memory
- Conflict resolution: PluresDB CRDT merge (last-writer-wins per field)
- Multi-device: same PluresDB topic key = same memory mesh
- Offline changes merge automatically when reconnected

**Exit criteria**: PluresDB is the default. CRDT sync replaces custom Hyperswarm protocol. better-sqlite3 remains as a lightweight alternative.

---

## Phase 4 — Commercial Release (v1.0)

**Goal**: Ship pluresLM as a commercial product with two tiers.

### pluresLM Pro — $10/year
- Everything in Phase 1–2
- Transformers.js embeddings (zero config)
- better-sqlite3 storage
- All 10+ tools
- All lifecycle hooks
- Project indexing
- Daily summaries
- File migration
- Open source (AGPL-3.0)

### Plures LM+ — $25/year
- Everything in Pro, plus:
- PluresDB native backend
- CRDT P2P sync (Hyperswarm)
- Multi-device memory mesh
- Priority memory consolidation
- Advanced analytics (memory health dashboard)
- Commercial license (no AGPL copyleft)

### Distribution
- npm: `@plures/pluresLM`
- OpenClaw plugin marketplace (when available)
- Gumroad / LemonSqueezy for license keys
- GitHub Sponsors tier

---

## Phase 5 — Agent Intelligence Layer (v2.0+)

**Goal**: pluresLM evolves from "memory plugin" to "agent intelligence layer" — the brain behind Pares Agens.

### Perception
- Receive structured events from capability nodes (screen captures, audio transcriptions, UI states)
- Categorize and embed incoming perception data automatically
- Store with provenance: which node, when, what context

### Action Memory
- Record agent actions and their outcomes
- Build action→result patterns over time
- Enable "I did this before and it worked/failed" reasoning

### Praxis Scripts (.pxs)
- Executable memory presentations
- Live data binding from pluresLM queries
- Shareable via P2P sync

### Desktop Memory (Pares Manus Integration)
- Windows: UI interactions, screenshots, app states, build results
- Linux: AT-SPI2 accessibility events, PipeWire audio
- macOS: Accessibility API, screen recordings
- All platforms: PluresDB command channel for capture commands

### Mobile Memory (Plures LM Mobile)
- Audio transcription (on-device Whisper)
- Keyboard capture (custom IME)
- Share sheet integration
- GPS context
- P2P sync to desktop pluresLM via Hyperswarm

---

## Dependency Map

```
Phase 1 (SLM Takeover)
  └── No blockers. Pure feature work.

Phase 2 (Zero-Dependency)
  └── No blockers. Evaluate sql.js, implement lazy loading.

Phase 3 (PluresDB)
  └── Blocked by: pluresdb#74 (@plures/pluresdb-native N-API binary)
  └── Blocked by: pluresdb#86 (PluresDB ← Hyperswarm wiring)

Phase 4 (Commercial)
  └── Depends on: Phase 1 + Phase 2 (Pro tier)
  └── Depends on: Phase 3 (LM+ tier)

Phase 5 (Intelligence Layer)
  └── Depends on: Phase 3 (PluresDB backend)
  └── Depends on: Pares Manus (desktop capture)
  └── Depends on: pluresLM-mobile (mobile capture)
```

---

## Non-Goals

- **Cloud storage**: pluresLM is local-first. No S3, no Firebase, no cloud DB.
- **Cloud embeddings**: Transformers.js runs in-process. No OpenAI API calls for embeddings.
- **Custom ML training**: We use pre-trained models. No fine-tuning pipeline.
- **Multi-user**: One user per DB. Multi-device via P2P sync, not multi-tenancy.
- **Real-time collaboration**: Sync is eventual-consistency, not real-time CRDT editing.

---

## Timeline (Estimated)

| Phase | Target | Duration |
|-------|--------|----------|
| Phase 1 | v0.12–0.14 | 2–3 weeks |
| Phase 2 | v0.15–0.17 | 2–3 weeks |
| Phase 3 | v0.18–0.20 | 4–6 weeks (blocked on pluresdb#74) |
| Phase 4 | v1.0 | 2 weeks (packaging + distribution) |
| Phase 5 | v2.0+ | Ongoing, parallel to Pares development |

---

## Contributing

Issues labeled `copilot` are assigned to GitHub Copilot coding agent. Issues labeled `enhancement` are open for community contribution.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.
