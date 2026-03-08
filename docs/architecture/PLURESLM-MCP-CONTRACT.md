# PluresLM MCP Tool Contract

> Stable interface contract for the `plureslm-mcp` Model Context Protocol server.
> Clients **MUST** rely only on behaviour documented here; everything else is internal.

## 1. Transport & Protocol

| Property | Value |
|----------|-------|
| Transport | **stdio** (JSON-RPC 2.0 over stdin/stdout) |
| MCP SDK | `@modelcontextprotocol/sdk >=1.17` |
| Server name | `plureslm-mcp` |
| Server version | `0.1.0` (follows semver; breaking tool changes bump major) |
| Capabilities | `{ tools: {} }` |

## 2. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLURESLM_DB_PATH` | `.plureslm` | Path to the PluresDB data directory. Relative paths resolve from `cwd`. |
| `PLURESLM_VECTOR_DIM` | `384` | Embedding vector dimension used by the HNSW index. |

No other env vars are required. The server creates the database directory on first write if it does not exist.

## 3. Tools

### 3.1 `plureslm_store`

Store a memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | **yes** | The text to store. |
| `category` | string | no | Category label (default: `"conversation"`). |
| `tags` | string[] | no | Freeform tag list. |
| `source` | string | no | Origin identifier (default: `"mcp"`). |

**Returns** `{ ok: true, id: string, duplicate: boolean }`

### 3.2 `plureslm_list`

List recent memories, newest first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | no | Max items (default 10, clamped 1-100). |
| `category` | string | no | Filter by category. |

**Returns** array of `{ id, category, created_at, content }`.

### 3.3 `plureslm_search_text`

Substring search over memory content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | **yes** | Case-insensitive substring to match. |
| `limit` | number | no | Max results (default 5, clamped 1-100). |

**Returns** array of `{ id, category, created_at, content }`.

### 3.4 `plureslm_query_dsl`

Execute a PluresDB DSL query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | **yes** | DSL expression (see `docs/PROCEDURES.md`). |

**Returns** DSL result object (shape varies by query).

### 3.5 `plureslm_world_state`

Generate a high-priority world state summary. Takes no parameters.

**Returns** plain-text summary string.

## 4. Cross-Platform Path Rules

### 4.1 Supported Now

| Platform | `PLURESLM_DB_PATH` notes |
|----------|--------------------------|
| **Linux** | Any POSIX path. `~` is **not** expanded; use absolute paths or rely on cwd-relative default. |
| **Windows** | Forward slashes (`C:/Users/…`) and backslashes both work. UNC paths (`\\server\share`) are untested. |

### 4.2 Future Targets

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | Planned | Expected to work identically to Linux; no code changes anticipated. |
| **Android (Termux)** | Target | `PLURESLM_DB_PATH` should point to app-writable storage (e.g. `$HOME/.plureslm`). Native NAPI addons require Termux NDK build. |
| **iOS** | Target | Likely embedded as a library rather than standalone stdio server. Contract applies if stdio transport is available. |

### 4.3 Path Normalisation

The server resolves `PLURESLM_DB_PATH` relative to `process.cwd()`. Clients should pass absolute paths when the working directory is ambiguous (e.g. IDE integrations, system services).

## 5. Stability Guarantees

- **Tool names, required parameters, and return-shape top-level keys** are stable within a major version.
- Optional parameters may be added without a version bump.
- New tools may be added without a version bump.
- Removing or renaming a tool, or changing a required parameter, requires a major version bump.
