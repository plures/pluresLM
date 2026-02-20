#!/usr/bin/env bash
# pluresLM upgrade script
# Handles: git pull, dependency install, build, DB migration, config update, restart
#
# Usage: bash scripts/upgrade.sh [--no-restart] [--keep-old-db]

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_DIR="${HOME}/.openclaw"
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"
OLD_DB_PATH="${OPENCLAW_DIR}/superlocalmemory.db"
NEW_DB_NAME="superlocalmemory.db"  # keep same name for compat
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

NO_RESTART=false
KEEP_OLD_DB=false

for arg in "$@"; do
  case "$arg" in
    --no-restart) NO_RESTART=true ;;
    --keep-old-db) KEEP_OLD_DB=true ;;
    -h|--help)
      echo "Usage: bash scripts/upgrade.sh [--no-restart] [--keep-old-db]"
      echo ""
      echo "Upgrades pluresLM plugin: pulls latest, installs deps, builds,"
      echo "backs up old DB, updates config, and restarts OpenClaw."
      echo ""
      echo "Options:"
      echo "  --no-restart   Skip gateway restart (manual restart needed)"
      echo "  --keep-old-db  Don't delete old DB (will cause dimension mismatch)"
      exit 0
      ;;
  esac
done

echo "╔═══════════════════════════════════════╗"
echo "║       pluresLM Upgrade Script         ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# ── Symlink check: warn if this is a stale secondary clone ───────────
OPENCLAW_PLUGINS="${HOME}/.openclaw/plugins"
PLUGIN_LINK="${OPENCLAW_PLUGINS}/pluresLM"
RESOLVED_PLUGIN_LINK=""
if [ -L "$PLUGIN_LINK" ]; then
  RESOLVED_PLUGIN_LINK="$(cd -P "$PLUGIN_LINK" 2>/dev/null && pwd || echo "")"
fi
if [ -n "$RESOLVED_PLUGIN_LINK" ] && [ "$RESOLVED_PLUGIN_LINK" = "$PLUGIN_DIR" ]; then
  echo "  ✅ Running from symlinked single-source directory"
elif [ -d "$PLUGIN_LINK" ] && [ "$PLUGIN_LINK" != "$PLUGIN_DIR" ]; then
  echo "  ⚠ WARNING: $PLUGIN_LINK is a separate clone from $PLUGIN_DIR"
  echo "    Run: bash $PLUGIN_DIR/scripts/setup-symlink.sh"
  echo "    to eliminate the dual-clone and use a single source of truth."
  echo ""
fi

# ── Step 1: Pull latest ──────────────────────────────────────────────
echo "▶ Step 1: Pulling latest changes..."
cd "$PLUGIN_DIR"
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
git pull --ff-only 2>/dev/null || git pull --rebase 2>/dev/null || {
  echo "  ⚠ Git pull failed — continuing with local code"
}
AFTER=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  Already up to date ($BEFORE)"
else
  COMMITS=$(git log --oneline "$BEFORE".."$AFTER" 2>/dev/null | wc -l)
  echo "  Updated: $COMMITS new commits ($BEFORE → $AFTER)"
fi
echo ""

# ── Step 2: Install dependencies ─────────────────────────────────────
echo "▶ Step 2: Installing dependencies..."
npm install --no-audit --no-fund 2>&1 | tail -3
echo ""

# ── Step 3: Build TypeScript ─────────────────────────────────────────
echo "▶ Step 3: Building TypeScript..."
npx tsc 2>&1 || {
  echo "  ⚠ TypeScript build failed"
  exit 1
}

# Verify dist has Transformers.js code
if grep -q "Transformers.js" dist/embeddings.js 2>/dev/null; then
  echo "  ✅ dist/embeddings.js has Transformers.js provider"
else
  echo "  ⚠ dist/embeddings.js missing Transformers.js — build may have failed"
fi
echo ""

# ── Step 4: Detect and handle DB dimension mismatch ──────────────────
echo "▶ Step 4: Database migration..."
DB_PATH="${OPENCLAW_DIR}/${NEW_DB_NAME}"

if [ -f "$DB_PATH" ]; then
  # Check current embedding dimension
  EMBED_BYTES=$(sqlite3 "$DB_PATH" "SELECT LENGTH(embedding) FROM memories LIMIT 1;" 2>/dev/null || echo "0")
  MEMORY_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "0")

  if [ "$EMBED_BYTES" = "0" ] || [ "$MEMORY_COUNT" = "0" ]; then
    echo "  DB exists but is empty — will be populated on startup"
  elif [ "$EMBED_BYTES" = "3072" ]; then
    echo "  ✅ DB already has 384-dim embeddings ($MEMORY_COUNT memories) — no migration needed"
  else
    # Dimension mismatch (likely 8192 = 1024-dim or 12288 = 1536-dim)
    CURRENT_DIM=$((EMBED_BYTES / 8))
    echo "  ⚠ DB has ${CURRENT_DIM}-dim embeddings ($MEMORY_COUNT memories)"
    echo "    Transformers.js uses 384-dim — re-indexing required"

    BACKUP_PATH="${DB_PATH}.bak.${CURRENT_DIM}dim.${TIMESTAMP}"
    echo "  Backing up → ${BACKUP_PATH}"
    cp "$DB_PATH" "$BACKUP_PATH"

    if [ "$KEEP_OLD_DB" = false ]; then
      rm -f "$DB_PATH" "${DB_PATH}-shm" "${DB_PATH}-wal"
      echo "  Deleted old DB — fresh 384-dim DB will be created on startup"
    else
      echo "  --keep-old-db: old DB preserved (⚠ dimension mismatch!)"
    fi
  fi
else
  echo "  No existing DB — fresh install, will be created on startup"
fi
echo ""

# ── Step 5: Update OpenClaw config ───────────────────────────────────
echo "▶ Step 5: Checking OpenClaw config..."
if [ -f "$CONFIG_FILE" ]; then
  # Check if plugin is registered under old name
  if grep -q '"superlocalmemory"' "$CONFIG_FILE" && ! grep -q '"pluresLM"' "$CONFIG_FILE"; then
    echo "  Migrating config: superlocalmemory → pluresLM"
    sed -i 's/"superlocalmemory"/"pluresLM"/g' "$CONFIG_FILE"
    echo "  ✅ Plugin entry renamed"
  elif grep -q '"pluresLM"' "$CONFIG_FILE"; then
    echo "  ✅ Config already uses pluresLM"
  else
    echo "  ⚠ Plugin not found in config — add manually"
  fi

  # Ensure embedding provider is set to transformers
  if grep -q '"embeddingProvider"' "$CONFIG_FILE"; then
    if grep -q '"embeddingProvider": "ollama"' "$CONFIG_FILE" || grep -q '"embeddingProvider": "openai"' "$CONFIG_FILE"; then
      echo "  Updating embeddingProvider → transformers"
      sed -i 's/"embeddingProvider": "[^"]*"/"embeddingProvider": "transformers"/g' "$CONFIG_FILE"
    else
      echo "  ✅ embeddingProvider already set to transformers"
    fi
  fi

  # Ensure dimension is 384
  if grep -q '"embeddingDimension": 1024' "$CONFIG_FILE" || grep -q '"embeddingDimension": 1536' "$CONFIG_FILE"; then
    echo "  Updating embeddingDimension → 384"
    sed -i 's/"embeddingDimension": [0-9]*/"embeddingDimension": 384/g' "$CONFIG_FILE"
  fi
else
  echo "  ⚠ Config file not found at $CONFIG_FILE"
fi
echo ""

# ── Step 6: Restart gateway ──────────────────────────────────────────
if [ "$NO_RESTART" = false ]; then
  echo "▶ Step 6: Restarting OpenClaw gateway..."
  if command -v openclaw &>/dev/null; then
    openclaw gateway restart 2>/dev/null && echo "  ✅ Gateway restarting" || echo "  ⚠ Restart failed — try manually: openclaw gateway restart"
  else
    echo "  ⚠ openclaw CLI not found — restart manually"
  fi
else
  echo "▶ Step 6: Skipped (--no-restart)"
  echo "  Run: openclaw gateway restart"
fi

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║         Upgrade Complete ✅            ║"
echo "╚═══════════════════════════════════════╝"
echo ""
echo "What happens next:"
echo "  1. Gateway restarts and loads pluresLM plugin"
echo "  2. Transformers.js downloads bge-small model (~33MB, first time only)"
echo "  3. Project directories re-index with 384-dim embeddings"
echo "  4. Auto-capture starts building memory from conversations"
echo ""
echo "Monitor: tail -f ~/.openclaw/slm-debug.log"
