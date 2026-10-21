# Database Directory Override

> Historical source-package reference, not native installer configuration.
> Use [current operations](OPERATIONS.md) for `PLURESLM_DATA_HOME` and owner lifecycle.

PluresLM supports a `dbBaseDir` configuration option to override the default database location while maintaining process isolation.

## Default Behavior (No Override)

By default, PluresLM uses process-specific directories under `~/.pluresLM/`:

```
~/.pluresLM/
├── openclaw-gateway/db     # Gateway process
├── openclaw-cli/db         # CLI tools  
├── openclaw-dashboard/db   # Dashboard
└── pluresLM-dev/db        # Development
```

## Custom Base Directory

You can override the base directory while preserving process isolation:

```json
{
  "plugins": {
    "entries": {
      "pluresLM": {
        "enabled": true,
        "config": {
          "dbBaseDir": "/custom/path/to/memory"
        }
      }
    }
  }
}
```

Result:
```
/custom/path/to/memory/
├── openclaw-gateway/db
├── openclaw-cli/db
└── openclaw-dashboard/db
```

## Environment Variable Support

The base directory respects OpenClaw's `OPENCLAW_HOME` environment variable:

- If `OPENCLAW_HOME` is set: uses `$OPENCLAW_HOME/.pluresLM/`
- If `dbBaseDir` is set: uses the custom path
- Otherwise: uses `$HOME/.pluresLM/`

## Use Cases

**Shared NFS/Network Storage:**
```json
{
  "dbBaseDir": "/shared/nfs/openclaw-memory"
}
```

**Service User Isolation:**
```json  
{
  "dbBaseDir": "/opt/openclaw/memory"
}
```

**Development Testing:**
```json
{
  "dbBaseDir": "/tmp/openclaw-test-memory"
}
```

## Important Notes

1. **Process isolation is preserved** - each process still gets its own subdirectory
2. **Migration required** - existing databases won't auto-migrate to new locations
3. **Permissions** - ensure the OpenClaw process can read/write to the custom directory
4. **Backup considerations** - update backup scripts if using custom locations

## Migration Example

If changing from default to custom location:

```bash
# Stop OpenClaw first
openclaw gateway stop

# Move existing databases
mkdir -p /custom/path/to/memory
mv ~/.pluresLM/* /custom/path/to/memory/

# Update config with dbBaseDir
# Restart OpenClaw
openclaw gateway start
```

The system will automatically create process-specific subdirectories in the new location.