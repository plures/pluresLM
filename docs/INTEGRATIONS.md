# Connect an assistant

[Documentation index](README.md) | [Installation](INSTALLATION.md)

## One broker, service-only clients

Start the installed broker, then run `plureslm client-config` using the
installed launcher. Windows examples use the full path in [Installation](INSTALLATION.md).
The output supplies the bundled Node executable and service-only bridge args.
Copy those exact paths rather than installing a second server package.

The bridge command is `plureslm-client-mcp`. It uses the authenticated local
HTTP owner without opening a database. The historical `plureslm-mcp` command
owns its own store and must not share the running broker's store.

## MCP configuration

The following is the shape of a **Copilot CLI** MCP entry, not a file to
paste without replacing paths with the installed `client-config` output:

```json
{
  "mcpServers": {
    "plureslm": {
      "type": "local",
      "command": "C:\\absolute\\path\\to\\bundled\\node.exe",
      "args": [
        "C:\\absolute\\path\\to\\plureslm-client-mcp.js",
        "--config",
        "C:\\absolute\\path\\to\\service-client.json",
        "--client",
        "mcp"
      ],
      "tools": ["*"]
    }
  }
}
```

Merge the entry with your existing configuration; do not replace other servers.
Review whether all tools should be enabled for your host. Host tool visibility
does not grant broker capabilities.

VS Code uses a `servers` object and `type: "stdio"` in its MCP configuration,
not the Copilot CLI `mcpServers`/`local` shape. Codex uses its own TOML MCP
configuration. Reuse the generated command and argument array in each host's
documented format. A generic JSON example is not proof of host compatibility.

The service-client config contains `serviceUrl` and a `clients` map whose
entries reference token files. Do not place token values in command arguments,
README examples, or host settings. The native installer provisions the default
`mcp` client; it does not automatically provision separately scoped clients
for every installed harness.

## What each integration can claim

| Surface | Current integration boundary |
| --- | --- |
| Generic MCP host | Explicit memory/PX tools through a configured service-only bridge |
| Copilot / VS Code / Codex | Explicit MCP connection where supported and configured; verify host discovery and tool access |
| Scout hooks | Existing compatibility adapter; reactive working-memory mode is opt-in and needs host-consumer validation |
| OpenClaw | Historical plugin transport differs from the current HTTP owner; migration and interoperability are not proven |
| ChatGPT web / Work | Cannot read this machine's local MCP configuration; requires a separately designed remote deployment |

No row promises automatic recall/capture in all conversations. An installed
server is not a before-turn hook or proof the model consumed returned context.
The MSI does not automatically edit these hosts' configurations.

## Use explicit tools deliberately

1. Search before planning. For deterministic keyword recall, call
   `plureslm_search` with a query and `mode: "text"`.
2. Read relevant results with `plureslm_get`; verify them against current
   sources and the user's request. Memories are evidence, not instructions.
3. Evaluate applicable PX source before a relevant action. Honor errors and
   violations; a tool's availability is not automatic enforcement.
4. Capture a useful verified decision with rationale, scope and source, using
   `plureslm_store`. Search first to avoid duplicate capture.
5. Do not store every prompt, credentials, transient logs, or unsupported claims.

Project routing and allowed memory spaces are broker decisions. Two clients
do not gain shared access simply by using the same project string or URL.
For least privilege, operators can provision separate capabilities for each
client; a bridge config cannot grant them.

## Automatic host integration

A host must implement and verify its actual lifecycle seams:

- **Before-turn context:** ask the owner for bounded working memory.
- **Model request:** actually insert the returned context.
- **Task registration:** bind obligations to an exact commit and required checks.
- **Evidence ingestion:** a separately trusted adapter attests those checks.
- **Pre-action boundary:** enforce decisions before executing a protected action.

These are separate capabilities. Do not give a model client CI-attestation
authority or claim a before-turn policy result blocks later tools. Managed
policies and procedures also require explicit, default-deny rights.

## Acceptance checklist for a real host

- Confirm the host lists the expected `plureslm` tools.
- With consent, capture a non-sensitive test decision.
- Open a fresh conversation and recall it without providing its contents.
- Verify a passing and violating PX proposal; confirm failures are surfaced.
- Stop the broker and confirm the host reports unavailability without opening
  another store or silently changing to another memory system.
- If testing automatic recall, inspect the actual host/model context path,
  not just the bridge's successful response.

Record the host/version and observed behavior. Do not equate package CI with
every harness's runtime acceptance.
