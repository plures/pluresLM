# Architecture and trust boundaries

[Documentation index](README.md) | [Capabilities](CAPABILITIES.md)

## One owner per store

```text
MCP-capable hosts                 Host lifecycle / trusted evidence adapters
        |                                      |
plureslm-client-mcp                       authenticated HTTP
        |                                      |
        +------------ PluresLM broker ----------+
                           |
                  service-owned PluresDB
                           |
                 memory / policy / PX
```

The broker owns storage, indexing, capability interpretation, routing and
lifecycle. A service-only MCP bridge does not open a database and must not
fall back to an independent store when the owner fails.

`plureslm-service` is the HTTP owner. The legacy `plureslm-mcp` process is
another owner mode, not the HTTP broker's MCP transport. Choose exactly one
owner for a given store path. The native installer wraps the HTTP owner with
explicit `start`, `status`, `client-config` and `stop` commands and an
authenticated local control socket/pipe.

## Data and capability boundaries

- Memory and vector indexing use PluresDB, not a per-harness database.
- Transient PX evaluation does not add submitted rules to durable memory.
- Managed-policy revisions, activation and receipts have a separate namespace
  and scoped capabilities within the owner.
- Ordinary memory clients do not acquire policy management or trusted CI rights.
- Procedures invoke only trusted host bindings with independent authorization.
- Host/model context insertion is not the same boundary as action enforcement.

Retrieved memories and source references remain untrusted evidence. Do not
follow instructions embedded in recall simply because the store returned them.
Source IDs, caller verification claims and model-generated receipts do not
replace authenticated observations.

## Local-first is a deployment choice, not a blanket guarantee

The native broker binds to loopback by default and authenticates clients using
local capability tokens. Keep token files private and data outside application
payloads. Never expose the loopback service through a public tunnel as an
undocumented substitute for HTTPS/OAuth and a remote threat model.

Local storage alone is not an encryption-at-rest guarantee. Backups, filesystem
permissions, other software running as your user, imported data, model downloads
and host-specific capture settings all need explicit operator consideration.
First embedding initialization may fetch/cache assets; offline installation
does not mean every first-run operation is network-free.

## Public distribution boundary

Current runtime source/builds belong to private `praxis-platform`.
Public `pluresLM` owns documentation, support, release approval and downloads.
Retained historical code in this public repository is not synchronized back
into the canonical runtime.

Private CI validates exact-source Windows/Linux candidates and notifies the
public publisher. Public trusted-main code independently checks run/source,
tag/main ancestry, manifests, artifact digests, file allowlists and installed
evidence. It never executes private downloaded code in the privileged publisher.
Only approved payloads, metadata and selected release notes become public.
The public tag labels distribution; it is not the private source commit.

The publisher's closed boolean PX contract is distinct from the runtime
service's native PX evaluator. Do not infer live shared-policy registration
or a full PX interpreter from the publisher adapter.

See [release operations](INSTALLER-RELEASES.md) for credentials, approval,
immutable tags, stable-version ordering and partial-publication recovery.
