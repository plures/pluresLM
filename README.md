# Superlocalmemory — OpenClaw Plugin + Library

A local-first long-term memory system for OpenClaw with support for **SQLite (better-sqlite3)** and **PluresDB** backends, featuring **vector similarity search** (cosine similarity) and **graph edges** between memories.

This package can be used in two ways:

1. **As an OpenClaw plugin** (auto-recall, auto-capture, CLI commands)
2. **As a reusable library** (import `MemoryDB`, embeddings providers, and types)

> 🚀 **PluresDB Migration**: As of v0.4.0, PluresDB backend is available as an optional alternative to better-sqlite3, offering native CRDT sync and enhanced vector search capabilities.

## What's new in v0.5.0

- **Session-start context injection** — Proactively injects important memories at session start (before first user message)
- **Priority category filtering** — Configure which memory categories to surface at session start
- **Recency bias control** — Balance between recent and older memories with configurable weighting
- **Replaces manual MEMORY.md reading** — No more burning tokens on startup file reads

## What's new in v0.4.0

- **PluresDB backend support** — Use `@plures/pluresdb` as an optional backend (install separately)
- **Backend selection** — Configure via `backend: "pluresdb"` or `backend: "better-sqlite3"` (default)
- **Fully async interface** — All database methods are now Promise-based for compatibility with PluresDB
- **Zero-downtime migration** — Existing better-sqlite3 databases continue to work by default

## What’s new in v0.2.0

- **Code pattern extraction** from markdown code blocks (functions, types, module composition, API patterns)
- **Error → fix pair capture** with `fixed-by` graph edges
- **WIP detection** (`work-in-progress` category) and boosted recall
- **Project indexing**: chunk & embed files from configured paths (markdown headings + code declarations)

## Features

- **Multiple backends** — Choose between better-sqlite3 (default) or PluresDB
- **Vector similarity search** via cosine similarity on stored embeddings
- **Graph edges** linking related memories (e.g. error → fix)
- **Deduplication** — similar memories update instead of duplicating
- **Session-start injection** — proactively injects important memories before first turn (NEW in v0.5.0)
- **Auto-recall** — injects relevant memories before each agent turn
- **Auto-capture** — extracts and stores meaningful content after each turn
- **Profile building** — periodically distills memories into a user profile
- **Dual embeddings** — OpenAI primary with Ollama local fallback
- **Project context indexing** — index files/dirs into memory as `project-context`

## Install

### Default (better-sqlite3)

```bash
npm install @plures/superlocalmemory
```

`better-sqlite3` includes a native addon that must match your **current Node.js version**. If you change Node versions (e.g. via `nvm`, system upgrade, or OpenClaw upgrade), run:

```bash
npm rebuild better-sqlite3
```

This repo runs that rebuild automatically on install via `postinstall`.

### With PluresDB backend (optional)

To use PluresDB as the backend:

```bash
npm install @plures/superlocalmemory @plures/pluresdb
```

Then configure the plugin to use the PluresDB backend:

```json
{
  "plugins": {
    "entries": {
      "superlocalmemory": {
        "enabled": true,
        "config": {
          "backend": "pluresdb",
          "dbPath": "~/.openclaw/superlocalmemory.db",
          ...
        }
      }
    }
  }
}
```

### npm (library usage)

```bash
npm install @plures/superlocalmemory
```

### OpenClaw plugin

If you are developing locally from this repo:

```bash
cd ~/.openclaw/workspace/plugins/superlocalmemory
npm install
npm run build

openclaw plugins install -l ~/.openclaw/workspace/plugins/superlocalmemory
```

Or add the path to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/workspace/plugins/superlocalmemory"]
    },
    "slots": {
      "memory": "superlocalmemory"
    },
    "entries": {
      "superlocalmemory": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/superlocalmemory.db",
          "autoRecall": true,
          "autoCapture": true,
          "maxRecallResults": 5,
          "profileFrequency": 50,
          "dedupeThreshold": 0.95,
          "projectContextPaths": [],
          "projectIndexOnStart": true,
          "sessionStartRecall": {
            "enabled": true,
            "maxMemories": 20,
            "priorityCategories": ["decision", "preference", "explicit", "work-in-progress"],
            "recencyBias": 0.7
          }
        }
      }
    }
  }
}
```

### Session-Start Context Injection

The `sessionStartRecall` feature proactively injects important memories at the start of each agent session (before the first user message). This replaces the need for manual MEMORY.md reading rituals that burn tokens.

**Configuration:**

- **enabled** (`boolean`, default: `true`) — Enable/disable session-start injection
- **maxMemories** (`number`, default: `20`) — Maximum number of memories to inject at session start
- **priorityCategories** (`string[]`, default: `["decision", "preference", "explicit", "work-in-progress"]`) — Categories to prioritize for session-start injection
- **recencyBias** (`number`, default: `0.7`) — Weight for recent vs older memories (0-1, higher = more recent)

**How it works:**

1. When a new session starts (on the first turn), the plugin retrieves memories from the specified priority categories
2. Memories are selected using a weighted random sampling that favors recent memories based on the recencyBias parameter
3. The user profile (if available) is always included at session start
4. All selected memories are injected as `<session-context>` in the system prompt
5. This provides agents with critical context without requiring explicit file reads

**Example injected context:**

```xml
<user-profile>
User is a TypeScript developer working on a full-stack web application
</user-profile>

<session-context>
- [decision] Decided to use PostgreSQL for the project database
- [preference] User prefers TypeScript over JavaScript
- [work-in-progress] Working on implementing authentication feature
- [explicit] Always use async/await for asynchronous operations
...
</session-context>
```

## Library Usage

### MemoryDB

```ts
import { MemoryDB } from "@plures/superlocalmemory/db";

const db = new MemoryDB("./superlocalmemory.db", 1536);
```

### Embeddings (Dual: OpenAI primary + Ollama fallback)

```ts
import { DualEmbeddings } from "@plures/superlocalmemory/embeddings";

const embeddings = new DualEmbeddings({
  openaiKey: process.env.OPENAI_API_KEY,
  openaiModel: "text-embedding-3-small",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  dimension: 1536,
});

const vec = await embeddings.embed("hello world");
```

### Types

```ts
import type { MemoryEntry, MemorySearchResult } from "@plures/superlocalmemory/db";
import type { EmbeddingProvider } from "@plures/superlocalmemory/embeddings";
```

## Embeddings

**Primary:** OpenAI `text-embedding-3-small` (needs `OPENAI_API_KEY` or plugin config `openaiApiKey`)

**Fallback:** Ollama `nomic-embed-text` at `http://localhost:11434`

If OpenAI fails (no key, network error, rate limit), the embedder automatically falls back to Ollama.

For OpenClaw plugin usage, you can provide the OpenAI API key either:
- via environment: `OPENAI_API_KEY`
- or via plugin config: `openaiApiKey` (recommended when you can't easily set env vars)

## Configuration (plugin)

| Key | Default | Description |
|-----|---------|-------------|
| `backend` | `better-sqlite3` | Storage backend (`better-sqlite3` or `pluresdb`) |
| `dbPath` | `~/.openclaw/superlocalmemory.db` | SQLite database path |
| `embeddingProvider` | `openai` | Primary provider (`openai` or `ollama`) |
| `embeddingModel` | `text-embedding-3-small` | OpenAI embedding model |
| `openaiApiKey` | *(unset)* | Optional OpenAI API key (falls back to `OPENAI_API_KEY` if unset) |
| `embeddingDimension` | `1536` | Vector dimension |
| `ollamaModel` | `nomic-embed-text` | Ollama model |
| `ollamaEndpoint` | `http://localhost:11434` | Ollama endpoint |
| `autoRecall` | `true` | Auto-inject memories before turns |
| `autoCapture` | `true` | Auto-capture after turns |
| `maxRecallResults` | `5` | Max memories to recall |
| `profileFrequency` | `50` | Rebuild profile every N captures |
| `dedupeThreshold` | `0.95` | Cosine similarity dedupe threshold |
| `debug` | `false` | Debug logging |
| `projectContextPaths` | `[]` | Files/dirs to index into memory |
| `projectIndexOnStart` | `true` | Index project context paths when plugin starts |
| `projectIndexGlobs` | `[...]` | Glob patterns used for discovery (WIP; may evolve) |

## Usage (plugin)

### AI Tools

- `superlocalmemory_store` — store information
- `superlocalmemory_search` — search memories
- `superlocalmemory_forget` — delete memories
- `superlocalmemory_profile` — view user profile
- `superlocalmemory_index` — index a project directory into memory

### Auto-Recall / Auto-Capture

When enabled, the plugin automatically:

1. **Before each turn**: embeds the user’s message and injects top-K similar memories as context
2. **After each turn**: stores meaningful content (with dedupe) and additionally extracts:
   - code patterns
   - error → fix pairs
   - work-in-progress items

Trivial messages (greetings, heartbeats, very short text) are skipped.

## Architecture

Both backends use the same schema:

```
SQLite schema
├── memories
│   ├── id (TEXT, PK)
│   ├── content (TEXT)
│   ├── embedding (BLOB: Float64Array)
│   ├── created_at (INTEGER)
│   ├── source (TEXT)
│   ├── tags (TEXT: JSON array)
│   └── category (TEXT)
├── memory_edges
│   ├── id (TEXT, PK)
│   ├── from_id (TEXT -> memories.id)
│   ├── to_id (TEXT -> memories.id)
│   ├── relation (TEXT)
│   └── created_at (INTEGER)
└── profile
    ├── id (TEXT, PK: 'user_profile')
    ├── summary (TEXT)
    ├── facts (TEXT: JSON array)
    ├── updated_at (INTEGER)
    └── capture_count (INTEGER)
```

## Migration to PluresDB

### Why PluresDB?

PluresDB offers several advantages over better-sqlite3:

- **Native CRDT sync** — Built-in P2P synchronization without custom code
- **Enhanced vector search** — HNSW indexing for better performance
- **Graph relationships** — First-class support for connected data
- **Cross-platform** — Works on Deno, Node.js, and browsers
- **Future-proof** — Active development with modern architecture

### Migration Steps

1. **Install PluresDB**:
   ```bash
   npm install @plures/pluresdb
   ```

2. **Update your config** to use the PluresDB backend:
   ```json
   {
     "backend": "pluresdb",
     "dbPath": "~/.openclaw/superlocalmemory-pluresdb.db"
   }
   ```

3. **Restart OpenClaw** — Your existing data remains in the old database. Both backends can coexist.

4. **Migrate existing data** (optional but recommended):
   ```bash
   npm run migrate ~/.openclaw/superlocalmemory.db ~/.openclaw/superlocalmemory-pluresdb.db
   ```
   
   This will copy all memories and profile data to the new PluresDB database. Note: embeddings are not migrated - you'll need to re-index for vector search to work optimally.

### Rollback

To rollback to better-sqlite3:

1. Change config back to:
   ```json
   {
     "backend": "better-sqlite3",
     "dbPath": "~/.openclaw/superlocalmemory.db"
   }
   ```

2. Restart OpenClaw

Your better-sqlite3 database is never modified when using PluresDB, so rollback is instant and safe.

## Dependencies

- `better-sqlite3` — embedded SQLite (default backend)
- `@plures/pluresdb` — PluresDB backend (optional peer dependency)
- `openai` — OpenAI API client (for embeddings)
- `@sinclair/typebox` — JSON schema for tool parameters
