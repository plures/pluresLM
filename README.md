# PluresLM

**Local-first memory and declarative policy for AI assistants.**

PluresLM helps assistants carry useful knowledge between sessions: project
decisions, verified lessons, supporting evidence, and unresolved obligations.
One local broker owns the memory store; supported clients connect through
authenticated interfaces rather than maintaining competing databases.

PluresDB provides storage and vector search. Praxis/PX provides declarative
constraint evaluation. PluresLM connects those capabilities to agent workflows
while keeping memory, authority, and policy enforcement distinct.

## Start here

- [Installation and Windows quick start](docs/INSTALLATION.md)
- [Connect an assistant or MCP host](docs/INTEGRATIONS.md)
- [Memory, policy, and procedure capabilities](docs/CAPABILITIES.md)
- [Architecture, privacy, and trust boundaries](docs/ARCHITECTURE.md)
- [Troubleshooting, upgrades, and migration](docs/OPERATIONS.md)
- [All documentation](docs/README.md)

## Download and release status

[Latest stable release](https://github.com/plures/pluresLM/releases/latest)
&middot; [All releases](https://github.com/plures/pluresLM/releases)

**Installer publication is being introduced.** At the October 21, 2026
documentation baseline, the public releases contain historical source-only
versions, not downloadable product installers. Build validation is not a
published release. Look for a `plureslm-vVERSION` release with actual `.msi`,
`.deb`, or `.rpm` assets; GitHub's automatic source ZIP is not an installer.

| Target | Intended download | Current boundary |
| --- | --- | --- |
| Windows x64 | One per-user MSI with bundled Node/runtime | Native build and lifecycle CI verified; public publication pending |
| Linux x64 | DEB or RPM, choose one | CI verified; glibc >= 2.39; public publication pending |
| macOS / ARM64 / Alpine-musl | None yet | Not supported by the current installer matrix |
| Mobile / browser | No product installer promised | Separate client work, not a local daemon deployment |

**One PluresLM installation per OS/architecture, not one per harness.**
Scout, Copilot, Codex, VS Code, and OpenClaw are integration targets of the
same broker. Automatic adapter setup and migration from older Scout installs
are not yet part of the MSI. Existing Scout ZIPs are compatibility packages.

Initial native installers are unsigned. Verify the supplied SHA-256, understand
your organization's software policy, and read the version-specific release
notes. A checksum is not a code signature. Installation bundles dependencies;
first embedding initialization may still download/cache model assets.

## What PluresLM provides

| Capability | What it does | Important limit |
| --- | --- | --- |
| Durable recall and capture | Search/read/store scoped memory across sessions | Clients must be authorized for the same scope |
| Provenance and lineage | Record source references, record types, supersession, expiry and history | A caller's verification timestamp is not trusted attestation |
| PX evaluation | Evaluate supplied constraints against a proposed action's context | Does not execute or automatically block that action |
| Managed policies | Immutable revisions, explicit activation, pinned bundles and optional receipts | Default-deny management capabilities; not mixed into conversational memory |
| Working memory | Host-prepared bounded recall/context and exact-commit verification obligations | Requires real host lifecycle/context-insertion and trusted evidence seams |
| Host-bound procedures | Register, test, promote and invoke bounded typed procedures | Explicit rights and trusted host bindings; not arbitrary code execution |

See [capabilities and examples](docs/CAPABILITIES.md) for the differences between
implemented service features, default installer permissions, and host adoption.

## How it fits together

```text
Assistant / MCP host / optional lifecycle adapter
                   |
       service-only MCP or host HTTP API
                   |
       authenticated local PluresLM broker
                   |
             PluresDB + PX
```

Use the service-only `plureslm-client-mcp` bridge for shared memory.
The legacy standalone `plureslm-mcp` command is a separate store owner,
not a proxy. Never point two owner processes at the same store.

MCP registration provides explicit tools. It does **not** by itself enable
automatic recall, capture, context injection, policy enforcement, or trusted
CI attestation in every host. [Integration boundaries](docs/INTEGRATIONS.md)
are part of the product contract, not optional disclaimers.

## Source, publishing, and contributions

This public repository owns product documentation, downloads, support, and
the release publisher. Historical source remains here for provenance; current
runtime development lives in `packages/plureslm` in the private
[Praxis Platform monorepo](https://github.com/plures/praxis-platform).
An inaccessible private link does not prevent using these public guides.

Private CI validates both installer targets and sends only a candidate
tag/source/run identity to the public publisher. After release approval, the
publisher verifies the build and uploads exact assets to this repository's
Releases. It does not execute downloaded candidate code or rebuild it.
See [release setup and operation](docs/INSTALLER-RELEASES.md).

Report reproducible installation, compatibility, or documentation problems in
[Issues](https://github.com/plures/pluresLM/issues).
Read [contribution and support guidance](CONTRIBUTING.md) before sharing logs.

## License

Public source visibility does not mean unrestricted use. This repository's
[LICENSE](LICENSE) is Business Source License 1.1 with an Additional Use Grant;
review its exact terms and contact `licensing@plures.io` about other licensing.
Downloaded distributions also include component-specific licenses/notices.
This documentation does not replace those terms or imply that every bundled
dependency uses the same license.
