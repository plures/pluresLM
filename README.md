# Plures LM

Plures LM is a local-first long-term memory system with vector search, graph relationships, and P2P sync. Available as an OpenClaw plugin or standalone MCP service.

## Installation

```bash
# As OpenClaw plugin
npm install @plures/plureslm

# For MCP service mode (standalone)
git clone https://github.com/plures/pluresLM.git
cd pluresLM
npm install && npm run build
```

## Usage

### OpenClaw Plugin

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

### MCP Service (Standalone)

Run as an MCP server with stdio transport:

```bash
# Using default store path
node dist/plureslm-service.js

# Custom store location
PLURESLM_STORE_PATH=/path/to/your/store node dist/plureslm-service.js
```

Connect any MCP-compatible client (Claude Desktop, VS Code, custom tools) to access your memory.

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
| `plureslm_store` | Store a memory with category and tags |
| `plureslm_search_text` | Semantic search across all memories |
| `plureslm_list` | List memories by category/source/date |
| `plureslm_stats` | View memory statistics and health |
| `plureslm_query_dsl` | Advanced queries with filtering/sorting |
| `plureslm_world_state` | Get high-priority memory summary |
| `plureslm_export_pack` | Export memory collection as shareable pack |
| `plureslm_import_pack` | Import memory pack from file |
| `plureslm_list_packs` | List installed memory packs |
| `plureslm_uninstall_pack` | Remove memory pack |
| `plureslm_export_bundle` | Export full memory backup |
| `plureslm_restore_bundle` | Restore from backup bundle |
| `plureslm_export_training` | Generate training datasets |
| `plureslm_training_stats` | Training data statistics |
| `plureslm_health` | System health and diagnostics |

## Configuration

### Plugin Mode (`openclaw.json`)

```json
{
  "plureslm": {
    "dbPath": "~/.openclaw/pluresLM-store",
    "autoRecall": true,
    "autoCapture": true,
    "maxRecallResults": 5,
    "embeddingModel": "BAAI/bge-small-en-v1.5",
    "embeddingDimension": 384
  }
}
```

### Service Mode (Environment)

```bash
PLURESLM_STORE_PATH=/path/to/store     # Store location (default: .plureslm-store)
PLURESLM_EMBEDDING_MODEL=model-name    # Embedding model (default: BAAI/bge-small-en-v1.5)  
PLURESLM_DEBUG=1                       # Enable debug logging
PLURESLM_ALLOW_PLAIN_DB=1              # Allow non-embedding fallback
```

## Architecture

- **Storage**: PluresDB CRDT with Sled persistence
- **Search**: HNSW vector indices with native embeddings
- **Transport**: JSON-RPC 2.0 over stdio (MCP), or direct plugin API
- **Sync**: Hyperswarm P2P with encrypted replication
- **Embeddings**: FastEmbed Rust backend (ONNX)

## CLI Tools

```bash
# Health check
node dist/plureslm-service.js health

# Query memories
echo '{"query": "decisions about API design"}' | node dist/plureslm-service.js search

# Export training data
node dist/plureslm-service.js export-training --format=dpo > training.jsonl
```

## License

AGPL-3.0 — [github.com/plures/pluresLM](https://github.com/plures/pluresLM)