# Plures LM

Plures LM is a local-first long-term memory plugin for [OpenClaw](https://openclaw.dev). It automatically captures and recalls relevant information across conversations using vector similarity search, giving your AI assistant persistent, contextual memory without manual note-taking.

## Install

```bash
npm install @plures/plures-lm
```

## Configure

Add the plugin to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "pluresLM": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/pluresLM.db",
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

## Key Features

### 1. Auto-Recall & Auto-Capture

Before every turn, Plures LM embeds the user's message and injects the most relevant memories as context. After every turn, it automatically extracts and stores meaningful information — decisions, preferences, code patterns, error fixes, and work-in-progress items — with deduplication so the same fact is never stored twice.

```json
{
  "autoRecall": true,
  "autoCapture": true,
  "maxRecallResults": 5,
  "dedupeThreshold": 0.85
}
```

### 2. Session-Start Context Injection

At the beginning of each session (before the first user message), Plures LM proactively injects your most important memories so the assistant has full context without any explicit prompting.

```json
{
  "sessionStartRecall": {
    "enabled": true,
    "maxMemories": 15,
    "priorityCategories": ["decision", "preference", "explicit", "work-in-progress"],
    "recencyBias": 0.7
  }
}
```

### 3. Project Context Indexing

Index your project files into memory so the assistant always knows your architecture, key types, and documentation — without reading files on every turn.

```json
{
  "projectContextPaths": ["~/projects/my-app"],
  "projectIndexOnStart": false,
  "projectIndexGlobs": ["**/README.md", "**/src/types/**/*.ts", "**/docs/architecture.md"]
}
```

Set `projectIndexOnStart: true` to index automatically on startup, or trigger it manually with the `pluresLM_index` tool.

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `dbPath` | `~/.openclaw/pluresLM.db` | Database file path |
| `autoRecall` | `true` | Inject relevant memories before each turn |
| `autoCapture` | `true` | Capture memories after each turn |
| `maxRecallResults` | `5` | Max memories to inject per turn |
| `dedupeThreshold` | `0.85` | Cosine similarity threshold for deduplication |
| `projectIndexOnStart` | `false` | Auto-index project paths on plugin start |
| `projectContextPaths` | `[]` | Files/directories to index as project context |
| `sessionStartRecall.enabled` | `true` | Inject important memories at session start |
| `sessionStartRecall.maxMemories` | `15` | Max memories to inject at session start |
| `debug` | `false` | Enable debug logging |

## AI Tools

Once installed, the following tools are available to the AI assistant:

- `pluresLM_store` — store a memory explicitly
- `pluresLM_search` — search memories by semantic similarity
- `pluresLM_forget` — delete a memory
- `pluresLM_profile` — view the current user profile
- `pluresLM_index` — index a project directory into memory

## Docs

Full documentation: [github.com/plures/pluresLM](https://github.com/plures/pluresLM)

