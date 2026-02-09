# Superlocalmemory — OpenClaw Plugin + Library

A local-first long-term memory system for OpenClaw using **SQLite (better-sqlite3)** for storage, **vector similarity search** (cosine similarity), and **graph edges** between memories.

This package can be used in two ways:

1. **As an OpenClaw plugin** (auto-recall, auto-capture, CLI commands)
2. **As a reusable library** (import `MemoryDB`, embeddings providers, and types)

> Note: A future release may swap the storage layer to PluresDB; today it is **better-sqlite3**.

## What’s new in v0.2.0

- **Code pattern extraction** from markdown code blocks (functions, types, module composition, API patterns)
- **Error → fix pair capture** with `fixed-by` graph edges
- **WIP detection** (`work-in-progress` category) and boosted recall
- **Project indexing**: chunk & embed files from configured paths (markdown headings + code declarations)

## Features

- **Vector similarity search** via cosine similarity on stored embeddings
- **Graph edges** linking related memories (e.g. error → fix)
- **Deduplication** — similar memories update instead of duplicating
- **Auto-recall** — injects relevant memories before each agent turn
- **Auto-capture** — extracts and stores meaningful content after each turn
- **Profile building** — periodically distills memories into a user profile
- **Dual embeddings** — OpenAI primary with Ollama local fallback
- **Project context indexing** — index files/dirs into memory as `project-context`

## Install

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

**Primary:** OpenAI `text-embedding-3-small` (needs `OPENAI_API_KEY`)

**Fallback:** Ollama `nomic-embed-text` at `http://localhost:11434`

If OpenAI fails (no key, network error, rate limit), the embedder automatically falls back to Ollama.

## Configuration (plugin)

| Key | Default | Description |
|-----|---------|-------------|
| `dbPath` | `~/.openclaw/superlocalmemory.db` | SQLite database path |
| `embeddingProvider` | `openai` | Primary provider (`openai` or `ollama`) |
| `embeddingModel` | `text-embedding-3-small` | OpenAI embedding model |
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

```
SQLite (better-sqlite3)
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

## Dependencies

- `better-sqlite3` — embedded SQLite
- `openai` — OpenAI API client (for embeddings)
- `@sinclair/typebox` — JSON schema for tool parameters
