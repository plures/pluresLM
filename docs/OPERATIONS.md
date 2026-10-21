# Operations, troubleshooting, and migration

[Documentation index](README.md) | [Installation](INSTALLATION.md)

## Day-to-day lifecycle

Use the installed launcher, not a source checkout:

```powershell
& "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" status
& "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" start
& "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" client-config
& "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" stop
```

On Linux, use `plureslm status|start|client-config|stop` as the intended
ordinary user. Start is explicit; the native installer does not install a
scheduled task, login item, systemd service, or tray.

The service must finish native initialization/index startup before it is ready.
Read actual errors rather than treating a slow first start as a reason to
launch another owner. The stop command authenticates and waits for owner exit.

## Troubleshooting

| Symptom | Check | Do not do |
| --- | --- | --- |
| Release page has no MSI | Actual release assets and version notes | Treat source ZIPs or expiring CI artifacts as supported installers |
| Host lists no tools | Its configuration schema, generated absolute paths, host restart and discovery | Assume Copilot CLI JSON works unchanged in VS Code/Codex |
| Connection refused | Installed `status`, selected data root, actual loopback listener | Start a standalone MCP owner against the same store |
| Unauthorized / forbidden | Owner-issued token, client ID, scope and explicit capability | Paste tokens into a support ticket or grant all rights blindly |
| Database lock / competing owner | Previous process fully stopped; old Scout/legacy service layout | Delete live database files or kill processes by name |
| Missing automatic recall | Actual before-turn adapter and model-context insertion | Equate MCP registration with lifecycle integration |
| Missing policy/procedure rights | Deliberate owner provisioning and permitted scope | Edit the bridge config as if it grants rights |
| Semantic recall initialization fails | Runtime/model cache availability and explicit diagnostics | Report semantic success when only text search was checked |
| PX error or violation | Actual source, bounded context, service availability | Treat an error as a passing policy decision |

After an owner crash on Unix, a stale socket can produce an explicit error.
Verify the previous owner exited before considering targeted socket cleanup.
Do not remove unrelated sockets or modify the live database to resolve it.

## Data, ports and backup

Windows native data defaults to `%LOCALAPPDATA%\PluresLM\data`; Linux uses
`${XDG_DATA_HOME:-$HOME/.local/share}/plureslm`. `PLURESLM_DATA_HOME` selects a
different root deliberately. Use the same selection for start/status/stop.

`owner.json` holds owner settings; `service-client.json` points clients to
the service and token files. `PLURESLM_SERVICE_PORT` applies on initial
provisioning; edit the private owner settings while stopped for later changes.
Do not put data inside `%LOCALAPPDATA%\PluresLM\app` or `/opt/plureslm`.

For a filesystem backup, stop the owner first, protect credentials and copy
the intended data directory with an appropriate backup tool. This is not a
claim of a built-in snapshot/export command or a tested restore for every
older database format. Keep a recoverable copy before attempting migration.
Do not publish a data-directory archive in a support issue.

## Upgrade and uninstall

1. Read the target release's compatibility and migration notes.
2. Stop the existing owner with its original launcher and data root.
3. Preserve a protected backup; verify the new package checksum.
4. Upgrade the payload with the appropriate package manager.
5. Start once and inspect status. Recheck `client-config` and affected host paths.
6. Verify a known non-sensitive memory can be recalled after restart.

The native lifecycle tests exercise install/start/memory/PX/restart/stop/remove
and retained data. They do not prove arbitrary cross-version downgrade or every
legacy-store upgrade. Do not claim full migration acceptance from those tests.

Stop first, then remove the MSI through Windows Installed Apps, or use
`sudo apt remove plureslm` / `sudo dnf remove plureslm`.
Native uninstall removes payload but preserves user data and credentials.
Removing retained data is a separate explicit operator decision.

## Existing Scout, OpenClaw or legacy installations

The historical Scout installation uses its own paths/service task and can use
port 38948; the new native broker defaults to 38947. Different ports do not
make it safe for two owners to open the same store.

There is no automatic MSI migration that stops the old owner, imports all
older formats, rotates capabilities, or updates every host configuration.
Do not install the MSI and silently point it at an old store.

Inventory the existing owner, store, host config and token paths without
revealing them publicly. Stop the correct old service, preserve its data and
settings, then follow an explicitly validated version-specific migration path.
The Scout compatibility installer has an opt-in legacy import path for
certain older `mem:` records; it is not a general native-MSI migration feature.

The retained OpenClaw plugin uses a different historical transport contract.
An old plugin's successful startup is not proof of interoperability with the
current authenticated broker.

For unsupported migrations, report the source/target versions and non-sensitive
error summary in [Issues](https://github.com/plures/pluresLM/issues).
Keep the old installation recoverable until the new host/session acceptance
checks pass.
