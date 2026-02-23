# Plures LM — OpenClaw Plugin + Library

A local-first long-term memory system for OpenClaw with support for **SQLite (better-sqlite3)** and **PluresDB** backends, featuring **vector similarity search** (cosine similarity) and **graph edges** between memories.

This package can be used in two ways:

1. **As an OpenClaw plugin** (auto-recall, auto-capture, CLI commands)
2. **As a reusable library** (import `MemoryDB`, embeddings providers, and types)

> 🚀 **PluresDB Migration**: As of v0.4.0, PluresDB backend is available as an optional alternative to better-sqlite3, offering native CRDT sync and enhanced vector search capabilities.

## What's new in v0.9.0

- **Session-start context injection** — Proactively injects important memories at session start (before first user message)
- **Priority category filtering** — Configure which memory categories to surface at session start
- **Recency bias control** — Balance between recent and older memories with configurable weighting
- **Replaces manual MEMORY.md reading** — No more burning tokens on startup file reads
- **New configuration**: `sessionStartRecall` with enabled, maxMemories, priorityCategories, and recencyBias options

## What's new in v0.4.1

- **Priority-based memory scoring** — Memories assigned priority levels (critical, high, normal, low) based on category and tags
- **Staleness detection** — Automatically identify and demote memories not accessed in 30+ days
- **Memory consolidation** — Periodic task to merge duplicates, demote stale items, and promote reinforced facts
- **World state generation** — Generate summaries of high-priority memories to replace manual curation
- **New CLI commands**: `slm consolidate`, `slm world-state`, `slm find-stale`
- **New AI tools**: `pluresLM_consolidate`, `pluresLM_world_state`, `pluresLM_find_stale`

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
- **Priority-based scoring** — Critical, high, normal, and low priority levels for intelligent recall
- **Memory consolidation** — Automatic duplicate merging and staleness management
- **Graph edges** linking related memories (e.g. error → fix)
- **Deduplication** — similar memories update instead of duplicating
- **Session-start injection** — proactively injects important memories before first turn (NEW in v0.9.0)
- **Auto-recall** — injects relevant memories before each agent turn
- **Auto-capture** — extracts and stores meaningful content after each turn
- **Compaction snapshot** — captures critical context before conversation reset
- **Profile building** — periodically distills memories into a user profile
- **Daily summaries** — automatically generate structured summaries of captured memories by date
- **Dual embeddings** — OpenAI primary with Ollama local fallback
- **Project context indexing** — index files/dirs into memory as `project-context`

## Install

### Default (better-sqlite3)

```bash
npm install @plures/pluresLM
```

`better-sqlite3` includes a native addon that must match your **current Node.js version**. If you change Node versions (e.g. via `nvm`, system upgrade, or OpenClaw upgrade), run:

```bash
npm rebuild better-sqlite3
```

This repo runs that rebuild automatically on install via `postinstall`.

### With PluresDB backend (optional)

To use PluresDB as the backend:

```bash
npm install @plures/pluresLM @plures/pluresdb
```

Then configure the plugin to use the PluresDB backend:

```json
{
  "plugins": {
    "entries": {
      "pluresLM": {
        "enabled": true,
        "config": {
          "backend": "pluresdb",
          "dbPath": "~/.openclaw/pluresLM.db",
          ...
        }
      }
    }
  }
}
```

### npm (library usage)

```bash
npm install @plures/pluresLM
```

### OpenClaw plugin

If you are developing locally from this repo:

```bash
cd ~/.openclaw/workspace/plugins/pluresLM
npm install
npm run build

openclaw plugins install -l ~/.openclaw/workspace/plugins/pluresLM
```

#### Single-source-of-truth deployment (recommended)

If you run OpenClaw on the same machine where you develop the plugin, avoid
keeping a separate runtime clone.  A stale `dist/` in the runtime clone will
silently serve old code while your dev clone has the correct version.

Run the one-time setup script from inside this git checkout:

```bash
bash scripts/setup-symlink.sh
```

This script:
1. Builds the plugin (`npm install && npm run build`) unconditionally
2. Backs up any existing `~/.openclaw/plugins/pluresLM` directory
3. Creates a symlink `~/.openclaw/plugins/pluresLM` → this repo directory
4. Installs `post-merge` and `post-rewrite` git hooks that auto-rebuild after every `git pull` (including `git pull --rebase`)

After setup, the full upgrade cycle is simply:

```bash
git pull                     # hooks auto-run: npm install && npm run build
openclaw gateway restart     # loads the freshly built dist/
```

To use a non-default plugins directory:

```bash
bash scripts/setup-symlink.sh --plugins-dir /path/to/openclaw/plugins
```

Or add the path to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/plugins/pluresLM"]
    },
    "slots": {
      "memory": "pluresLM"
    },
    "entries": {
      "pluresLM": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/pluresLM.db",
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
import { MemoryDB } from "@plures/pluresLM/db";

const db = new MemoryDB("./pluresLM.db", 1536);
```

### Embeddings (Dual: OpenAI primary + Ollama fallback)

```ts
import { DualEmbeddings } from "@plures/pluresLM/embeddings";

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
import type { MemoryEntry, MemorySearchResult } from "@plures/pluresLM/db";
import type { EmbeddingProvider } from "@plures/pluresLM/embeddings";
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
| `dbPath` | `~/.openclaw/pluresLM.db` | SQLite database path |
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

## Migration from Manual Memory Files

If you've been maintaining memory manually via `MEMORY.md` or daily `memory/*.md` files, SLM provides migration tools to import that content into the database.

### Migration Commands

#### Import MEMORY.md

Import critical memories from a MEMORY.md file:

```bash
slm migrate-from-files --source MEMORY.md --priority critical
```

#### Import Daily Files

Import daily summary files from a directory:

```bash
slm migrate-from-files --source memory/ --category daily-summary
```

#### Dry Run

Preview what would be imported without making changes:

```bash
slm migrate-from-files --source MEMORY.md --dry-run
```

#### Verify Migration

Verify that all content from your original files is present in the database:

```bash
slm verify-migration --source MEMORY.md --threshold 0.9
```

This checks that at least 90% of your original content is findable via vector search.

### Migration Options

| Option | Description | Default |
|--------|-------------|---------|
| `--source <path>` | Path to MEMORY.md file or memory directory | (required) |
| `--priority <level>` | Memory priority: `critical`, `high`, or `normal` | `critical` |
| `--category <name>` | Memory category | `migrated-memory` |
| `--dry-run` | Preview imports without storing | `false` |
| `--threshold <n>` | Minimum coverage for verification (0.0-1.0) | `0.9` |

### Migration Workflow

1. **Phase 1: Backup**
   ```bash
   # Backup your existing files
   cp -r memory/ memory-backup/
   cp MEMORY.md MEMORY.md.backup
   ```

2. **Phase 2: Import**
   ```bash
   # Import MEMORY.md as critical-priority memories
   slm migrate-from-files --source MEMORY.md --priority critical
   
   # Import daily files (optional)
   slm migrate-from-files --source memory/ --category daily-summary
   ```

3. **Phase 3: Verify**
   ```bash
   # Verify all content was captured
   slm verify-migration --source MEMORY.md --threshold 0.9
   ```

4. **Phase 4: Archive**
   ```bash
   # Once verified, archive the old files (don't delete - keep as backup)
   mkdir -p .archive
   mv MEMORY.md .archive/
   mv memory/ .archive/
   ```

5. **Phase 5: Update AGENTS.md**
   
   Update your AGENTS.md file to remove manual memory maintenance instructions:
   
   ```markdown
   # Memory
   
   Memory is handled by superlocalmemory. Do not maintain MEMORY.md or daily files manually.
   The system automatically captures and recalls relevant information.
   ```

### File Format Support

#### MEMORY.md Format

The migration tool supports standard markdown:

```markdown
# Section Name

- Bullet point memories
- Each bullet becomes a separate memory

Regular paragraphs are also captured as memories.

## Subsection

More content here.
```

#### Daily File Format

Daily files should be named with dates (e.g., `2024-01-15.md`):

```markdown
Today I worked on feature X.

Made progress on implementation.

Need to follow up on Y tomorrow.
```

Each paragraph becomes a separate memory tagged with the date.

## Usage (plugin)

### AI Tools

- `superlocalmemory_store` — store information
- `superlocalmemory_search` — search memories
- `superlocalmemory_forget` — delete memories
- `superlocalmemory_profile` — view user profile
- `superlocalmemory_index` — index a project directory into memory
- `superlocalmemory_generate_daily_summary` — generate a structured daily summary from memories
- `superlocalmemory_get_daily_summaries` — retrieve recent daily summaries
- `superlocalmemory_consolidate` — merge duplicates, demote stale memories, promote reinforced facts
- `superlocalmemory_world_state` — generate a summary of high-priority memories
- `superlocalmemory_find_stale` — find memories not accessed in N+ days

### CLI Commands

- `slm stats` — show memory statistics
- `slm search <query>` — search memories by semantic similarity
- `slm profile` — show user profile
- `slm dashboard` — show system health dashboard
- `slm consolidate` — run memory consolidation (use `--apply` to execute, defaults to dry run)
- `slm world-state` — generate and display memory state summary
- `slm find-stale` — find and list stale memories (not accessed in 30+ days by default)
- `pluresLM_store` — store information
- `pluresLM_search` — search memories
- `pluresLM_forget` — delete memories
- `pluresLM_profile` — view user profile
- `pluresLM_index` — index a project directory into memory

### Auto-Recall / Auto-Capture

When enabled, the plugin automatically:

1. **Before each turn**: embeds the user’s message and injects top-K similar memories as context
2. **After each turn**: stores meaningful content (with dedupe) and additionally extracts:
   - code patterns
   - error → fix pairs
   - work-in-progress items
3. **Before compaction** (OpenClaw conversation reset): captures critical context from the compaction summary:
   - full compaction summary with session metadata
   - extracted code patterns from the summary
   - key decisions and important context
   - work-in-progress items
   - All tagged with `category: 'compaction-snapshot'` for easy retrieval

Trivial messages (greetings, heartbeats, very short text) are skipped.

### Daily Summaries

The daily summary feature automatically generates structured summaries from captured memories:

- **Generate summaries** for any date with `superlocalmemory_generate_daily_summary`
- **Retrieve summaries** for the last N days with `superlocalmemory_get_daily_summaries`
- **Automatic categorization** — memories grouped by category (decision, project, WIP, error-fix, etc.)
- **Time-ordered entries** — each memory includes its capture time
- **Searchable** — summaries stored as memories with category `daily-summary` and tag `daily-summary:YYYY-MM-DD`

Example summary structure:

```markdown
# Daily Summary - 2024-01-15

**Total Memories**: 12

## Decision (2)
- **09:00**: Decided to use TypeScript for the new project
- **14:30**: Chose PluresDB as the backend for better sync

## Project (5)
- **10:00**: Working on superlocalmemory daily summary feature
- **11:30**: Implemented generateDailySummary() method
...
```

This replaces the need for agents to manually write `memory/YYYY-MM-DD.md` files, reducing token costs significantly.
### Priority-Based Memory Scoring

Memories are automatically assigned priority levels that affect recall scoring:

- **Critical** — Always prioritized (tagged with `critical` or `permanent`)
- **High** — Important information (`explicit`, `decision`, `preference`, `entity`, `architecture-decision`)
- **Normal** — Standard memories (default for most categories)
- **Low** — Background info (`conversation`)

Priority affects vector search scoring with boost multipliers:
- Critical: 1.5x boost
- High: 1.2x boost
- Normal: 1.0x (no change)
- Low: 0.8x reduction

### Memory Consolidation

The consolidation system helps manage memory growth:

1. **Duplicate merging** — Finds and merges semantically similar memories (>0.85 similarity)
2. **Staleness detection** — Demotes memories not accessed in 30+ days (configurable)
3. **Reinforcement promotion** — Promotes memories with high merge counts (3+) to higher priority
4. **World state generation** — Creates summaries of high-priority memories for overview

Run consolidation via:
- CLI: `slm consolidate --apply` (defaults to dry run preview)
- Tool: `superlocalmemory_consolidate` with `dryRun: false`

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
│   ├── category (TEXT)
│   ├── priority (TEXT: critical, high, normal, low)
│   ├── last_accessed_at (INTEGER)
│   └── merge_count (INTEGER)
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
     "dbPath": "~/.openclaw/pluresLM-pluresdb.db"
   }
   ```

3. **Restart OpenClaw** — Your existing data remains in the old database. Both backends can coexist.

4. **Migrate existing data** (optional but recommended):
   ```bash
   npm run migrate ~/.openclaw/pluresLM.db ~/.openclaw/pluresLM-pluresdb.db
   ```
   
   This will copy all memories and profile data to the new PluresDB database. Note: embeddings are not migrated - you'll need to re-index for vector search to work optimally.

### Rollback

To rollback to better-sqlite3:

1. Change config back to:
   ```json
   {
     "backend": "better-sqlite3",
     "dbPath": "~/.openclaw/pluresLM.db"
   }
   ```

2. Restart OpenClaw

Your better-sqlite3 database is never modified when using PluresDB, so rollback is instant and safe.

## Dependencies

- `better-sqlite3` — embedded SQLite (default backend)
- `@plures/pluresdb` — PluresDB backend (optional peer dependency)
- `openai` — OpenAI API client (for embeddings)
- `@sinclair/typebox` — JSON schema for tool parameters
