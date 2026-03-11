# Plures LM

**⚠️ NOTE: This repository contains the legacy TypeScript implementation. For production deployments, use [pluresLM-mcp](https://github.com/plures/pluresLM-mcp) which provides the v2.0 architecture with PluresDB and enterprise SSE/HTTP transport.**

Plures LM is a local-first long-term memory system with vector search, graph relationships, and P2P sync.

## Repository Status

- **`plures/pluresLM`** (This repo): Legacy TypeScript library - SQLite-based v1.x
- **`plures/pluresLM-mcp`** (Production): Modern service architecture - PluresDB v2.0

## Migration to v2.0

For new deployments, use **pluresLM-mcp v2.0**:

```bash
git clone https://github.com/plures/pluresLM-mcp.git
cd pluresLM-mcp
npm install
npm start  # → MCP service with PluresDB backend
```

### v2.0 Benefits
- ✅ **Zero SQLite dependencies** 
- ✅ **Built-in persistence** via PluresDB/Hypercore
- ✅ **Enterprise fleet deployment** with SSE/HTTP transport
- ✅ **P2P synchronization** across devices
- ✅ **Automatic conflict resolution** with CRDTs

## Legacy v1.x Documentation

<details>
<summary>Click to view v1.x setup (SQLite-based)</summary>

### Installation

```bash
# As OpenClaw plugin
npm install @plures/plureslm

# For MCP service mode (standalone)
git clone https://github.com/plures/pluresLM.git
cd pluresLM
npm install && npm run build
```

### Usage

#### OpenClaw Plugin

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "plureslm": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/pluresLM-store"
        }
      }
    }
  }
}
```

#### MCP Service (Standalone)

Run as an MCP server with stdio transport:

```bash
# Using default store path
node dist/plureslm-service.js

# Custom store location
PLURESLM_STORE_PATH=/path/to/your/store node dist/plureslm-service.js
```

</details>

## Features

### 🧠 **Smart Memory Capture**
Automatically extracts decisions, preferences, code patterns, and key insights from conversations.

### 🔍 **Vector Similarity Search**  
Find relevant memories using semantic search with 384-dimensional embeddings.

### 📊 **Graph Relationships**
Memories link together automatically via content similarity and temporal proximity.

### 🔄 **P2P Sync** 
Sync memories across devices using Hyperswarm (encrypted, decentralized).

### 📦 **Memory Packs**
Export/import curated memory collections for sharing knowledge sets.

### 🎯 **Training Data Export**
Generate fine-tuning datasets from memory patterns and outcomes.

## MCP Tools (15 Available)

| Tool | Description |
|------|-------------|
| `pluresLM_store` | Store a memory with category and tags |
| `pluresLM_search` | Semantic search across all memories |
| `pluresLM_query` | Advanced queries with filtering/sorting |
| `pluresLM_world_state` | Get high-priority memory summary |
| `pluresLM_export_pack` | Export memory collection as shareable pack |
| `pluresLM_import_pack` | Import memory pack from file |
| `pluresLM_list_packs` | List installed memory packs |
| `pluresLM_uninstall_pack` | Remove memory pack |
| `pluresLM_export_bundle` | Export full memory backup |
| `pluresLM_restore_bundle` | Restore from backup bundle |
| `pluresLM_export_training` | Generate training datasets |
| `pluresLM_training_stats` | Training data statistics |
| `pluresLM_status` | System health and diagnostics |
| `pluresLM_profile` | View user profile built from memories |
| `pluresLM_sync_status` | P2P synchronization status |

## Architecture (v2.0)

- **Storage**: PluresDB CRDT with Hypercore persistence
- **Search**: Native vector indices with FastEmbed
- **Transport**: SSE/HTTP for fleet deployments, stdio for local MCP
- **Sync**: Hyperswarm P2P with encrypted replication
- **Embeddings**: OpenAI text-embedding-3-small

See [Architecture Reference](https://github.com/plures/pluresLM-mcp/blob/main/docs/architecture.md) for complete v2.0 documentation.

## License

AGPL-3.0 — [github.com/plures/pluresLM](https://github.com/plures/pluresLM)