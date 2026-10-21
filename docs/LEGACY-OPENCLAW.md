# Historical OpenClaw plugin documentation

> Historical reference only. These instructions describe retained plugin code,
> not the current PluresLM broker or product installer. Start with the
> [current product guide](../README.md) and [integration guide](INTEGRATIONS.md).
> Existing links in the retained text may refer to the former repository layout.

## Former product introduction

Local-first memory with a shared broker and optional harness integrations.
Product source and installer builds live in the private Praxis Platform
monorepo; this public repository distributes verified releases.

## Download PluresLM

[Download the latest stable installer](https://github.com/plures/pluresLM/releases/latest)
or browse [all releases](https://github.com/plures/pluresLM/releases).
Until the first `plureslm-vVERSION` installer release is published, older
source-only releases may appear there; a source archive is not an installer.

Windows x64 uses one PluresLM MSI, regardless of harness. Linux x64 DEB/RPM
are alternative formats of the same installation, not separate harness products.
Verify the matching `.sha256` before installing. The first installers are
unsigned; hashes are not code signatures. Automatic harness setup and migration
from legacy Scout installs are not yet implemented. Do not run competing
owners against the same memory store.

See [release setup and operation](INSTALLER-RELEASES.md).

## Historical OpenClaw plugin documentation

The sections below describe the historical plugin source retained in this
repository, not the canonical product installer or current broker setup.

Lightweight plugin that connects OpenClaw to the [pluresLM-mcp](https://github.com/plures/pluresLM-mcp) memory service.

## Architecture

```
OpenClaw ←→ Plugin (tools + hooks) ←→ pluresLM-mcp daemon (HTTP/MCP)
```

The plugin is a **thin adapter**. It registers tools and lifecycle hooks with OpenClaw, then delegates every memory operation to the pluresLM-mcp daemon via HTTP Streamable MCP transport.

**The plugin does NOT:**
- Open, manage, or own any database
- Generate or store embeddings
- Maintain profiles, sync state, or indexes
- Fork child processes for indexing

All of that lives in the pluresLM-mcp service.

**The plugin DOES:**
- Register 20+ tools with OpenClaw's plugin SDK
- Auto-recall: inject relevant memories before each agent turn
- Auto-capture: store important conversation content after each turn
- Compaction snapshots: preserve context during message compaction
- YAML pattern engine: in-process event→action dispatch (no DB)
- Lightweight text classification: category detection, tag extraction

## Setup

### 1. Run the pluresLM-mcp daemon

```bash
# Install and start
cd pluresLM-mcp && npm install && npm run build
systemctl --user start pluresLM-mcp
```

### 2. Configure environment

```bash
# In openclaw.json env.vars or systemd unit:
PLURESLM_MCP_URL=http://localhost:3100
MCP_API_KEY=<your-api-key>
```

### 3. Enable the plugin

Add to `openclaw.json`:

```json
{
  "plugins": {
    "plureslm": {
      "enabled": true,
      "source": "~/.openclaw/workspace/plugins/superlocalmemory"
    }
  }
}
```

## Configuration

All config is optional — defaults work out of the box:

```json
{
  "autoRecall": true,
  "autoCapture": true,
  "maxRecallResults": 5,
  "debug": false,
  "agentId": "",
  "agentName": "",
  "sessionStartRecall": {
    "enabled": true,
    "maxMemories": 15
  },
  "recallExcludeCategories": ["project-context"],
  "patternsDirs": [],
  "patternsWatch": true
}
```

## Source Files

```
src/
  index.ts                 # Plugin entry: tools, hooks, dispatch
  http-service-client.ts   # HTTP MCP transport client
  capture-quality.ts       # Auto-capture quality gates
  patterns.ts              # YAML pattern engine
  patterns/                # Built-in pattern definitions
  types.ts                 # Shared type definitions
```

5 source files. ~660 lines of plugin code. Everything else lives in the service.

## Tools

| Tool | Description |
|------|-------------|
| `pluresLM_store` | Store a memory |
| `pluresLM_search` | Semantic search |
| `pluresLM_query` | DSL queries (filter, sort, aggregate, graph) |
| `pluresLM_forget` | Delete by ID or search |
| `pluresLM_task_update` | Update task status/assignment |
| `pluresLM_profile` | View user profile |
| `pluresLM_index` | Index a project directory |
| `pluresLM_status` | Service diagnostics |
| `pluresLM_consolidate` | Merge duplicates, demote stale |
| `pluresLM_world_state` | High-priority memory summary |
| `pluresLM_find_stale` | Find unused memories |
| `pluresLM_generate_daily_summary` | Summarize a day's memories |
| `pluresLM_get_daily_summaries` | Multi-day summary retrieval |
| `pluresLM_graph_neighbors` | Graph traversal |
| `pluresLM_autolink` | Auto-discover relationships |
| `pluresLM_graph_insights` | Graph analytics |
| `pluresLM_sync_keygen` | Generate P2P sync key |
| `pluresLM_sync_status` | Sync status |
| `pluresLM_compatibility` | Check operating mode |
| `pluresLM_pattern_dispatch` | Fire pattern event |
| `pluresLM_pattern_list` | List loaded patterns |
