# Install PluresLM

[Documentation index](README.md) | [Connect a host](INTEGRATIONS.md)

## Availability and prerequisites

Use [public Releases](https://github.com/plures/pluresLM/releases).
The first product installer release is pending at this documentation baseline.
Do not install historical source ZIPs as if they were the current broker.
Use the steps below only when a `plureslm-vVERSION` release actually contains
the named installer, checksum, and source/build metadata.

Windows x64 is the first product target. The MSI bundles Node and production
dependencies: you do not need a separate Node/npm installation for that path.
An optional developer `.tgz` requires Node.js 24+ and npm and is not the
recommended end-user installation. macOS, ARM64 and Alpine/musl are unsupported.

Initial packages are unsigned. Follow your organization's approval requirements;
do not disable security tools to bypass a warning. Offline package installation
does not guarantee offline first-use embeddings: model initialization may
fetch/cache model assets.

## Windows x64

1. Download these three assets from the same release:
   - `plureslm-VERSION-win32-x64-msvc.msi`
   - its `.sha256` file
   - its `.provenance.json` file
2. Check the MSI hash against the checksum. In PowerShell, substituting the
   actual release filename:

   ```powershell
   $installer = ".\plureslm-VERSION-win32-x64-msvc.msi"
   $expected = ((Get-Content -LiteralPath "$installer.sha256" -Raw).Trim() -split '\s+')[0]
   $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
   if ($actual -ine $expected) { throw "Checksum mismatch; do not install." }
   ```

   Metadata identifies the exact source/build. SHA-256 detects mismatches;
   it is not a signature or independent proof of publisher identity.
3. Stop an existing owner before upgrading. For a first installation, open
   the MSI with Windows Installer. It installs per-user under
   `%LOCALAPPDATA%\PluresLM\app`.
4. Start the broker explicitly using the Start menu's **Start PluresLM**
   shortcut or PowerShell:

   ```powershell
   & "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" start
   & "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" status
   & "$env:LOCALAPPDATA\PluresLM\app\plureslm.cmd" client-config
   ```

5. Use the printed command/arguments to configure an MCP host as described
   in [Integrations](INTEGRATIONS.md). Restart that host and verify a fresh
   conversation can use the tools. Installer success alone is not host adoption.

`client-config` prints paths to credentials, not the credential values. Do not
post that output publicly without reviewing it for local path information.

## Files, startup, and permissions

| Concern | Native Windows installation |
| --- | --- |
| Application payload | `%LOCALAPPDATA%\PluresLM\app` |
| Default user data | `%LOCALAPPDATA%\PluresLM\data` |
| Owner settings | `owner.json` in the data directory |
| Service-only client config | `service-client.json` in the data directory |
| Default HTTP listener | Loopback port 38947 |
| Startup | Explicit `start`; no automatic login task, system service or tray |
| Default client | `mcp`, `personal` memory scope and `context.prepare` working-memory right |

The default client does not receive managed-policy management or trusted
attestation rights. Do not widen permissions merely to remove an access error.
Protect the data directory and token files using the operating system's account
permissions. Local-first does not imply encryption at rest or protection from
all software running as your user.

## Linux x64

Use Ubuntu 24.04+ for the DEB, or a compatible glibc >= 2.39 distribution
for the RPM. Choose one package format, not both. Verify its SHA-256 before:

```sh
sudo apt install ./plureslm-VERSION-linux-x64-gnu.deb
# Or, on an appropriate RPM distribution:
sudo dnf install ./plureslm-VERSION-linux-x64-gnu.rpm
```

The payload is `/opt/plureslm`. As the intended ordinary user, not root:

```sh
plureslm start
plureslm status
plureslm client-config
```

Data defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/plureslm`.
These examples describe the installer contract, not a claim that packages have
already been published or that every glibc-compatible distribution is tested.

## Next steps

- [Configure the shared broker in your host](INTEGRATIONS.md).
- [Understand recall, capture and policy boundaries](CAPABILITIES.md).
- [Upgrade, stop, uninstall or recover safely](OPERATIONS.md).
- Older Scout installation? Read the migration section before starting another owner.
