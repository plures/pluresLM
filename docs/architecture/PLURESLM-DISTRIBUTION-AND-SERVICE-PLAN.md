# PLURESLM Distribution and Service Plan

## 1) Scope and goals

This document defines an implementation-ready distribution architecture for pluresLM as a **policy-controlled shared service** usable by multiple MCP clients (OpenClaw, Codex, Claude Code) while retaining local-first deployment.

Primary goals:
- One operator-managed service can safely serve many clients.
- Keep setup lightweight on desktop/server platforms.
- Preserve existing plugin behavior while adding service policy controls.
- Allow default shared DB with optional per-client DB isolation.

Non-goals:
- Runtime implementation in this phase.
- Cloud multi-region control plane.

---

## 2) Target architecture

### 2.1 Components
- **pluresLM Service (daemon)**
  - Hosts MCP server endpoint(s): stdio process mode and/or TCP/HTTP bridge mode.
  - Loads operator policy and validates each client request.
  - Resolves effective config from: server defaults + profile + client request (bounded).
- **Policy Engine**
  - Field-level allow/deny/range checks.
  - Startup scan guardrails (path allowlist/denylist, glob limits, depth/size caps).
- **Storage Router**
  - Shared tenant (default).
  - Optional per-client DB tenancy.
- **Client Profiles**
  - Named presets for OpenClaw/Codex/Claude Code.
- **Desktop Control UX (optional)**
  - System tray app for service status, logs, policy mode, and start/stop.

### 2.2 Boundary and trust model
- Operator controls server config + policy (trusted).
- Clients are semi-trusted and may request overrides only where permitted.
- Secrets originate from environment variables or secret store; clients do not set server secrets.

---

## 3) Distribution strategy by platform

## 3.1 Windows
- Package `plureslm-service.exe` plus config template + optional tray app.
- Preferred installer: MSI via Tauri/Wix or NSIS (silent install supported).
- Run as user-level background service (or Scheduled Task) by default.
- Data default: `%LOCALAPPDATA%\plureslm\data`.

## 3.2 Linux
- Deliverables:
  - tarball + install script,
  - optional `.deb` and `.rpm` packages,
  - optional Docker image.
- Service mode: `systemd --user` unit by default; system unit optional.
- Data default: `${XDG_DATA_HOME:-~/.local/share}/plureslm`.

## 3.3 macOS
- Signed/notarized `.dmg` with app bundle containing service binary.
- LaunchAgent plist for per-user auto-start.
- Data default: `~/Library/Application Support/plureslm`.

## 3.4 Android
- Practical path: Termux package/script + optional lightweight UI wrapper.
- Service runs in app/user space (no always-on guarantee under battery policies).
- Data default: app-writable private storage.
- Recommend: “on-demand service start” rather than strict daemon expectations.

## 3.5 iOS
- No practical always-on MCP daemon model under iOS background constraints.
- Practical path:
  - companion app acting as **local DB client**,
  - sync/bridge to desktop/home-node pluresLM service when reachable.
- iOS as primary MCP host is deferred; iOS as client/sync peer is supported path.

---

## 4) Desktop installer + tray UX decision (svelte-tauri-template)

## Decision
Use `svelte-tauri-template` for desktop management UX and installer packaging (Windows/macOS/Linux), while keeping service runtime as separate binary/process.

## Why
- Cross-platform installer + signed desktop app path already solved by Tauri ecosystem.
- Native tray support for status/control.
- Small footprint relative to Electron.

## Integration pattern
- Tauri app responsibilities:
  - start/stop/restart service,
  - display health/status,
  - edit policy/config safely,
  - show client registrations and active profile assignments.
- Service responsibilities:
  - all MCP and policy enforcement logic.

This separation avoids coupling policy engine correctness to UI release cadence.

---

## 5) Docker MCP registration/discovery options

## Option A (recommended baseline): Static client registration snippets
- Publish canonical MCP config snippets for each client.
- Clients point to:
  - local binary (`command` mode), or
  - Docker wrapper command (`docker run ... plureslm-service`).

Pros: deterministic, low complexity.
Cons: manual update if endpoint changes.

## Option B: Local discovery file
- Service writes JSON descriptor under standard location:
  - `~/.config/plureslm/discovery.json` (or platform equivalent).
- Clients/tools may read descriptor to auto-register MCP endpoint.

Pros: enables future auto-registration tooling.
Cons: requires each client to support/consume discovery.

## Option C: Docker label discovery (advanced)
- Use Docker labels (e.g., `com.plureslm.mcp=true`) and fixed published metadata path.
- A small helper CLI can enumerate running containers and emit client config.

Pros: good for homelab/team setups.
Cons: extra moving parts.

## Recommendation
Phase 1 = Option A, Phase 2 = Option B, Phase 3 = Option C helper.

---

## 6) Multi-tenant database model

## Modes
1. **shared** (default): all clients use one DB.
2. **perClient**: each client ID mapped to isolated DB path/namespace.
3. **hybrid**: shared default + selected clients isolated.

## Required identifiers
- `clientId` (stable machine/client key)
- `profile` (openclaw/codex/claude-code/custom)

## Routing behavior
- Request enters with `clientId`.
- Policy resolves tenancy mode.
- Storage router maps to DB target:
  - shared DB path, or
  - per-client DB path template (`data/tenants/{clientId}`).

## Migration and fallback
- Start in shared mode.
- Enable isolation for targeted clients without global migration.
- Optional export/import tooling for moving one client’s data to isolated DB.

---

## 7) Policy matrix: server-enforced vs client-overridable

| Config area | Example fields | Policy class | Enforcement |
|---|---|---|---|
| Secrets | `openaiApiKey`, `syncKey`, provider creds | server-only | Ignore client-supplied values; load from env/secret source |
| Storage topology | `dbPath`, tenancy mode | server-only | Hard-set by service policy |
| Embedding provider family | `embeddingProvider` | server-only or bounded allowlist | Reject if outside allowlist |
| Embedding model name | `embeddingModel`, `ollamaModel` | client-requested (bounded) | Allow only approved model regex/list |
| Recall/capture toggles | `autoRecall`, `autoCapture` | client-requested (bounded) | Allow enable/disable per profile policy |
| Recall limits | `maxRecallResults`, `sessionStartRecall.maxMemories` | client-requested (bounded) | Clamp min/max |
| Dedupe/scoring thresholds | `dedupeThreshold`, `captureQuality.*`, `autoLinkThresholds.*` | client-requested (bounded) | Clamp and round to safe ranges |
| Pattern loading | `patternsDirs`, `patternsWatch` | bounded or server-only | Restrict to allowlisted roots |
| Startup indexing | `projectContextPaths`, `projectIndexOnStart`, `projectIndexGlobs` | client-requested (bounded) | Path policy + glob/size/depth caps |
| Debug/logging | `debug` | server-only | Force off in prod profile |

---

## 8) Startup project scanning policy

## Operator defaults (enforced)
- `projectIndexOnStartDefault`: false.
- `maxPathsPerClient`: e.g., 8.
- `maxFilesPerScan`: e.g., 10k.
- `maxTotalBytesPerScan`: e.g., 512MB.
- `allowedRoots`: explicit roots (workspace/home projects).
- `blockedGlobs`: secrets and heavy dirs (`**/.git/**`, `**/node_modules/**`, `**/.env*`, `**/dist/**`).

## Client overrides (bounded)
- Client may request `projectIndexOnStart=true` only if profile permits.
- Paths outside allowlisted roots are denied.
- Globs are intersected with operator allowlist and blocked-glob list.

## Runtime outcomes
- Denied requests return policy reason + normalized effective config.
- Service logs policy decisions with redacted paths where needed.

---

## 9) Environment variable and .env enforcement model

## Precedence (highest to lowest)
1. Server process environment (trusted host/systemd/launchd/service manager).
2. Server-managed `.env` file in protected config dir (optional).
3. Client-requested runtime config (bounded fields only).
4. Built-in defaults.

## Rules
- Secrets only from (1) or (2).
- Client-provided secrets are ignored + audit-logged as denied input.
- `.env` loading can be disabled in hardened mode.
- Expose an `effectiveConfig` endpoint/view that redacts secret values.

---

## 10) Windows tray and Linux desktop UX options

## Windows
- Tauri tray app with:
  - status (running/degraded/stopped),
  - start/stop/restart,
  - open logs,
  - quick policy mode switch (strict/balanced/dev).
- Optional “run at login” toggle writing scheduled-task/registry entry.

## Linux
- Tauri tray where supported (AppIndicator/SNI).
- If tray unavailable (minimal WM/headless), fallback to:
  - CLI status command,
  - web status page on localhost,
  - notifications via desktop portal when available.

---

## 11) Mobile constraints and practical path

## Android constraints
- Doze/app standby may suspend long-lived background services.
- File-system permissions vary by Android version/vendor.

## Android path
- Treat mobile as burst client: start service on user action, sync quickly, stop when idle.
- Use a desktop/home-node pluresLM service as durable always-on host.

## iOS constraints
- No unrestricted background daemon or stdio MCP host semantics.

## iOS path
- Companion app for capture/query + sync relay to trusted host service.
- Policy and heavy indexing remain on desktop/server host.

---

## 12) Phased execution sequence

## Phase 0: Contract + policy spec
- Freeze service config schema and policy matrix.
- Define effective-config resolution algorithm.

Acceptance criteria:
- Schema reviewed and versioned.
- Example profiles validated against schema.

## Phase 1: Single-host service packaging
- Build service binary/package for Win/Linux/macOS.
- Static MCP registration docs for OpenClaw/Codex/Claude Code.

Acceptance criteria:
- Fresh install on each desktop OS in <10 minutes.
- Clients can connect and execute baseline tools.

## Phase 2: Policy enforcement + tenancy routing
- Implement server-only vs bounded overrides.
- Add shared/per-client/hybrid DB routing.

Acceptance criteria:
- Policy deny/allow behavior covered by integration tests.
- Per-client isolation verified by cross-client data non-visibility tests.

## Phase 3: Desktop tray management UX
- Tauri tray control surface for status + policy + logs.

Acceptance criteria:
- Start/stop/restart and effective-config display work on Win/macOS/Linux.
- Health/status parity with CLI.

## Phase 4: Docker discovery helpers + mobile bridge docs
- Discovery file + helper CLI for Docker MCP registration.
- Android/iOS deployment playbooks.

Acceptance criteria:
- Docker helper produces valid client config snippets.
- Mobile documentation validated on one Android + one iOS test path.

---

## 13) Operational acceptance checklist

- [ ] Operator can enforce strict mode where client overrides are mostly denied.
- [ ] Operator can run balanced mode with bounded client flexibility.
- [ ] Service emits audit logs for denied overrides and policy clamps.
- [ ] Sensitive fields never exposed in logs or effective-config output.
- [ ] Startup indexing cannot escape allowed roots.
- [ ] Shared and isolated tenant modes are switchable per client profile.
