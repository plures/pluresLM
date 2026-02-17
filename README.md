# Superlocalmemory — OpenClaw Plugin + Library

A local-first long-term memory system for OpenClaw with support for **SQLite (better-sqlite3)** and **PluresDB** backends, featuring **vector similarity search** (cosine similarity) and **graph edges** between memories.

This package can be used in two ways:

1. **As an OpenClaw plugin** (auto-recall, auto-capture, CLI commands)
2. **As a reusable library** (import `MemoryDB`, embeddings providers, and types)

> 🚀 **PluresDB Migration**: As of v0.4.0, PluresDB backend is available as an optional alternative to better-sqlite3, offering native CRDT sync and enhanced vector search capabilities.

## What's new in v0.5.0

- **Transformers.js as default embedding provider** — Zero-config setup with in-process embeddings (no external dependencies)
- **`Xenova/bge-small-en-v1.5` model** — 384 dimensions, ~33MB auto-download on first use
- **OpenAI and Ollama remain available** — Configure via `embeddingProvider` setting
- **Breaking change:** Default dimension changed from 1536 to 384 (new installs only)

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
- **Zero-config embeddings** — Transformers.js runs in-process (no API keys or external servers)
- **Vector similarity search** — Cosine similarity on stored embeddings
- **Graph edges** linking related memories (e.g. error → fix)
- **Deduplication** — similar memories update instead of duplicating
- **Auto-recall** — injects relevant memories before each agent turn
- **Auto-capture** — extracts and stores meaningful content after each turn
- **Profile building** — periodically distills memories into a user profile
- **Multiple embedding providers** — Transformers.js (default), OpenAI, or Ollama
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
          "projectIndexOnStart": true
        }
      }
    }
  }
}
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

// Default: Transformers.js (zero-config, runs in-process)
const embeddings = new DualEmbeddings({
  provider: "transformers",
  transformersModel: "Xenova/bge-small-en-v1.5",
  dimension: 384,
});

// Optional: OpenAI
const embeddings = new DualEmbeddings({
  provider: "openai",
  openaiKey: process.env.OPENAI_API_KEY,
  openaiModel: "text-embedding-3-small",
  dimension: 1536,
});

// Optional: Ollama
const embeddings = new DualEmbeddings({
  provider: "ollama",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  dimension: 768,
});

const vec = await embeddings.embed("hello world");
```

### Types

```ts
import type { MemoryEntry, MemorySearchResult } from "@plures/superlocalmemory/db";
import type { EmbeddingProvider } from "@plures/superlocalmemory/embeddings";
```

## Embeddings

### Default: Transformers.js (Zero-Config)

**Model:** `Xenova/bge-small-en-v1.5` (384 dimensions, ~33MB)

Runs embeddings directly in the Node.js process using `@huggingface/transformers`. No API keys, no external servers, no configuration required.

The model is automatically downloaded to your local cache on first use (one-time ~33MB download).

### Optional: OpenAI

**Model:** `text-embedding-3-small` (1536 dimensions)

Requires `OPENAI_API_KEY` environment variable or plugin config `openaiApiKey`.

Configure via:
```json
{
  "embeddingProvider": "openai",
  "embeddingDimension": 1536
}
```

### Optional: Ollama

**Model:** `nomic-embed-text` (768 dimensions)

Requires Ollama server running at `http://localhost:11434` (or custom endpoint).

Configure via:
```json
{
  "embeddingProvider": "ollama",
  "ollamaEndpoint": "http://localhost:11434",
  "ollamaModel": "nomic-embed-text",
  "embeddingDimension": 768
}
```

## Migration from v0.4.x (Ollama/OpenAI to Transformers.js)

If you're upgrading from a previous version and have an existing database:

### Option 1: Keep Your Current Setup (Recommended)

Your existing configuration will continue to work. Simply add `embeddingProvider` to your config:

```json
{
  "embeddingProvider": "openai",
  "embeddingDimension": 1536
}
```

or for Ollama:

```json
{
  "embeddingProvider": "ollama",
  "embeddingDimension": 1024
}
```

### Option 2: Migrate to Transformers.js

To switch to the new default Transformers.js provider with 384 dimensions:

1. **Backup your database** (important!)
2. Delete your existing database file to start fresh
3. Update your config to use the new defaults (or remove embedding config entirely)
4. The plugin will create a new 384-dimension database on startup

**Note:** You cannot mix embedding dimensions in a single database. If you switch providers with different dimensions, you must create a new database.

## Configuration (plugin)

| Key | Default | Description |
|-----|---------|-------------|
| `backend` | `better-sqlite3` | Storage backend (`better-sqlite3` or `pluresdb`) |
| `dbPath` | `~/.openclaw/superlocalmemory.db` | SQLite database path |
| `embeddingProvider` | `transformers` | Embedding provider (`transformers`, `openai`, or `ollama`) |
| `transformersModel` | `Xenova/bge-small-en-v1.5` | Transformers.js model |
| `embeddingModel` | `text-embedding-3-small` | OpenAI embedding model |
| `openaiApiKey` | *(unset)* | Optional OpenAI API key (falls back to `OPENAI_API_KEY` if unset) |
| `embeddingDimension` | `384` | Vector dimension (384 for Transformers.js, 1536 for OpenAI, 768 for Ollama) |
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
