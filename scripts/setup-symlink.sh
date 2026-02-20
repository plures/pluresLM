#!/usr/bin/env bash
# pluresLM single-source-of-truth setup
#
# Eliminates the dual-clone deployment problem by symlinking the OpenClaw
# plugin directory to this git checkout, so there is only one location for
# both source code and the compiled dist/.
#
# Usage:
#   bash scripts/setup-symlink.sh [--plugins-dir <path>] [--no-hook] [--dry-run]
#
# Options:
#   --plugins-dir <path>   Directory where OpenClaw looks for plugins
#                          (default: ~/.openclaw/plugins)
#   --no-hook              Skip installing the post-merge git hook
#   --dry-run              Print what would happen without making changes
#   -h|--help              Show this help

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS_DIR="${HOME}/.openclaw/plugins"
INSTALL_HOOK=true
DRY_RUN=false

args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    --no-hook)   INSTALL_HOOK=false ;;
    --dry-run)   DRY_RUN=true ;;
    --plugins-dir)
      if [ $((i+1)) -lt ${#args[@]} ]; then
        PLUGINS_DIR="${args[$((i+1))]}"
        i=$((i+1))
      else
        echo "Error: --plugins-dir requires a path argument" >&2
        exit 1
      fi
      ;;
    -h|--help)
      sed -n '/^# /s/^# \?//p' "$0"
      exit 0
      ;;
  esac
done

PLUGIN_LINK="${PLUGINS_DIR}/pluresLM"

echo "╔═══════════════════════════════════════════════════╗"
echo "║   pluresLM: Single-Source-of-Truth Setup          ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "  Repo dir   : $REPO_DIR"
echo "  Plugins dir: $PLUGINS_DIR"
echo "  Plugin link: $PLUGIN_LINK"
echo ""

# ── Step 1: Build the plugin if dist/ is missing ──────────────────────
if [ ! -d "$REPO_DIR/dist" ]; then
  echo "▶ Step 1: Building TypeScript (dist/ not found)..."
  if [ "$DRY_RUN" = false ]; then
    cd "$REPO_DIR"
    npm install --no-audit --no-fund 2>&1 | tail -3
    npm run build 2>&1
    echo "  ✅ Build complete"
  else
    echo "  [dry-run] Would run: npm install && npm run build"
  fi
else
  echo "▶ Step 1: dist/ already exists — skipping build"
fi
echo ""

# ── Step 2: Create plugins directory if needed ────────────────────────
echo "▶ Step 2: Ensuring plugins directory exists..."
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$PLUGINS_DIR"
  echo "  ✅ $PLUGINS_DIR exists"
else
  echo "  [dry-run] Would run: mkdir -p $PLUGINS_DIR"
fi
echo ""

# ── Step 3: Handle existing plugins/pluresLM ─────────────────────────
echo "▶ Step 3: Checking for existing plugin installation..."
if [ -L "$PLUGIN_LINK" ]; then
  CURRENT_TARGET="$(readlink "$PLUGIN_LINK")"
  if [ "$CURRENT_TARGET" = "$REPO_DIR" ]; then
    echo "  ✅ Symlink already points to $REPO_DIR — nothing to do"
    SKIP_SYMLINK=true
  else
    echo "  ⚠ Symlink exists but points elsewhere: $CURRENT_TARGET"
    echo "  Removing old symlink..."
    if [ "$DRY_RUN" = false ]; then
      rm "$PLUGIN_LINK"
    else
      echo "  [dry-run] Would remove: $PLUGIN_LINK"
    fi
    SKIP_SYMLINK=false
  fi
elif [ -d "$PLUGIN_LINK" ]; then
  echo "  Found directory (old runtime clone): $PLUGIN_LINK"
  BACKUP="${PLUGIN_LINK}.bak.$(date +%Y%m%d-%H%M%S)"
  echo "  Renaming to backup: $BACKUP"
  if [ "$DRY_RUN" = false ]; then
    mv "$PLUGIN_LINK" "$BACKUP"
    echo "  ✅ Old clone backed up"
  else
    echo "  [dry-run] Would rename: $PLUGIN_LINK → $BACKUP"
  fi
  SKIP_SYMLINK=false
else
  echo "  No existing installation found"
  SKIP_SYMLINK=false
fi
echo ""

# ── Step 4: Create the symlink ────────────────────────────────────────
if [ "${SKIP_SYMLINK:-false}" = false ]; then
  echo "▶ Step 4: Creating symlink..."
  if [ "$DRY_RUN" = false ]; then
    ln -s "$REPO_DIR" "$PLUGIN_LINK"
    echo "  ✅ $PLUGIN_LINK → $REPO_DIR"
  else
    echo "  [dry-run] Would run: ln -s $REPO_DIR $PLUGIN_LINK"
  fi
else
  echo "▶ Step 4: Skipped (symlink already correct)"
fi
echo ""

# ── Step 5: Install post-merge git hook ───────────────────────────────
if [ "$INSTALL_HOOK" = true ]; then
  echo "▶ Step 5: Installing post-merge git hook..."
  HOOK_SRC="$REPO_DIR/scripts/hooks/post-merge"
  HOOK_DEST="$REPO_DIR/.git/hooks/post-merge"

  if [ -f "$HOOK_SRC" ]; then
    if [ "$DRY_RUN" = false ]; then
      if [ -f "$HOOK_DEST" ]; then
        BACKUP_PATH="${HOOK_DEST}.backup.$(date +%Y%m%d%H%M%S)"
        mv "$HOOK_DEST" "$BACKUP_PATH"
        echo "  ℹ Existing hook backed up to: $BACKUP_PATH"
      fi
      cp "$HOOK_SRC" "$HOOK_DEST"
      chmod +x "$HOOK_DEST"
      echo "  ✅ Installed: $HOOK_DEST"
    else
      if [ -f "$HOOK_DEST" ]; then
        BACKUP_PATH="${HOOK_DEST}.backup.$(date +%Y%m%d%H%M%S)"
        echo "  [dry-run] Would move existing hook: $HOOK_DEST → $BACKUP_PATH"
      fi
      echo "  [dry-run] Would copy: $HOOK_SRC → $HOOK_DEST"
      echo "  [dry-run] Would chmod +x: $HOOK_DEST"
    fi
  else
    echo "  ⚠ Hook source not found: $HOOK_SRC"
  fi
else
  echo "▶ Step 5: Skipped (--no-hook)"
fi
echo ""

echo "╔═══════════════════════════════════════════════════╗"
echo "║           Setup Complete ✅                        ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "What this means:"
echo "  • $PLUGIN_LINK"
echo "    points to → $REPO_DIR"
echo "  • There is now ONE directory for both source and dist"
echo "  • After 'git pull', the post-merge hook auto-rebuilds"
echo "  • Restarting OpenClaw will load the latest code"
echo ""
echo "To upgrade in future:"
echo "  git pull          # hook auto-runs: npm install && npm run build"
echo "  openclaw gateway restart"
