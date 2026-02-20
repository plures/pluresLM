# Migration Example: Complete Workflow

This example demonstrates the complete migration workflow from manual files to SLM-only memory.

## Initial Setup

You have existing memory files:

```
project/
├── MEMORY.md
└── memory/
    ├── 2024-01-15.md
    ├── 2024-01-16.md
    └── 2024-01-17.md
```

### MEMORY.md
```markdown
# User Preferences

- I prefer TypeScript over JavaScript for type safety
- My favorite IDE is VS Code with Vim keybindings
- I like using functional programming patterns when possible

# Current Projects

Working on implementing a migration tool for superlocalmemory that allows importing manual memory files.

# Technical Stack

- Node.js and TypeScript for backend
- SQLite for storage with better-sqlite3
- Vector embeddings with OpenAI and Ollama
```

### memory/2024-01-15.md
```markdown
Today I worked on the migration tool implementation.

Added file parsing utilities for MEMORY.md and daily files.

Implemented CLI commands with proper option handling.
```

## Step 1: Backup

```bash
# Create backup directory
mkdir -p .archive

# Backup files
cp MEMORY.md .archive/MEMORY.md.backup
cp -r memory/ .archive/memory-backup/
```

## Step 2: Preview Migration (Dry Run)

```bash
# Preview what would be imported from MEMORY.md
slm migrate-from-files --source MEMORY.md --dry-run
```

**Output:**
```
📥 Migrating from: /path/to/MEMORY.md
Priority: critical, Category: migrated-memory
Mode: DRY RUN (no changes will be made)

Detected MEMORY.md file
Found 7 memory items to import

[DRY RUN] Would import: I prefer TypeScript over JavaScript for type safety...
  Category: migrated-memory, Tags: section:user-preferences, source:memory.md, priority:critical
[DRY RUN] Would import: My favorite IDE is VS Code with Vim keybindings...
  Category: migrated-memory, Tags: section:user-preferences, source:memory.md, priority:critical
...

✅ Migration complete!
  Imported: 7
  Duplicates (merged): 0
  Skipped (errors): 0

Run without --dry-run to apply these imports.
```

## Step 3: Import MEMORY.md

```bash
# Import as critical-priority memories
slm migrate-from-files --source MEMORY.md --priority critical
```

**Output:**
```
📥 Migrating from: /path/to/MEMORY.md
Priority: critical, Category: migrated-memory

Detected MEMORY.md file
Found 7 memory items to import

✅ Migration complete!
  Imported: 7
  Duplicates (merged): 0
  Skipped (errors): 0
```

## Step 4: Import Daily Files (Optional)

```bash
# Import daily summaries
slm migrate-from-files --source memory/ --category daily-summary
```

**Output:**
```
📥 Migrating from: /path/to/memory/
Priority: critical, Category: daily-summary

Detected directory with daily memory files
Found 9 memory items to import

✅ Migration complete!
  Imported: 9
  Duplicates (merged): 0
  Skipped (errors): 0
```

## Step 5: Verify Migration

```bash
# Verify at least 90% coverage
slm verify-migration --source MEMORY.md --threshold 0.9
```

**Output:**
```
🔍 Verifying migration from: /path/to/MEMORY.md
Coverage threshold: 90%

Checking 7 memory items...

✅ Verification complete!
  Total items: 7
  Found in DB: 7
  Missing: 0
  Coverage: 100.0%

✅ Migration verified! Coverage meets threshold.
```

## Step 6: Check Memory Database

```bash
# View database stats
slm stats
```

**Output:**
```json
{
  "totalMemories": 16,
  "categories": {
    "migrated-memory": 7,
    "daily-summary": 9
  },
  "edgeCount": 0,
  "lastCaptureTime": "2024-02-17T02:45:00.000Z",
  "profileSummary": "Profile built from 16 memories..."
}
```

## Step 7: Test Search

```bash
# Search for TypeScript-related memories
slm search "TypeScript preferences" --limit 3
```

**Output:**
```json
[
  {
    "id": "abc123...",
    "content": "I prefer TypeScript over JavaScript for type safety",
    "category": "migrated-memory",
    "score": 0.92
  },
  {
    "id": "def456...",
    "content": "Node.js and TypeScript for backend",
    "category": "migrated-memory",
    "score": 0.85
  },
  {
    "id": "ghi789...",
    "content": "Working on implementing a migration tool for superlocalmemory",
    "category": "migrated-memory",
    "score": 0.78
  }
]
```

## Step 8: Archive Original Files

```bash
# Move to archive with timestamp
mv MEMORY.md .archive/MEMORY.md.$(date +%Y%m%d)
mv memory/ .archive/memory-$(date +%Y%m%d)/

# Update .gitignore
echo ".archive/" >> .gitignore
```

## Step 9: Update AGENTS.md

**Before:**
```markdown
# Memory Management

Before starting each session:
1. Read MEMORY.md for critical facts
2. Review recent memory/*.md files for context

During the session:
1. Update MEMORY.md when learning important facts
2. Keep track of key decisions

After the session:
1. Write a daily summary to memory/YYYY-MM-DD.md
2. Update MEMORY.md with critical discoveries
```

**After:**
```markdown
# Memory Management

Memory is handled by superlocalmemory. Do not maintain MEMORY.md or daily files manually.

The system automatically:
- Captures important information after each session
- Recalls relevant memories before each turn
- Deduplicates and consolidates memories
- Builds a user profile over time

Use `superlocalmemory_search` to query memory when needed.
```

## Step 10: Verify Auto-Capture

Start a new session and verify auto-capture is working:

```bash
# Check dashboard
slm dashboard
```

**Output:**
```
📊 Superlocalmemory Dashboard
═══════════════════════════════════════
Total memories:     17

  migrated-memory:   7 (41%)
  daily-summary:     9 (53%)
  conversation:      1 (6%)

Embedding health:
  Provider: OpenAI (text-embedding-3-small)
  Dimension: 1536

Capture rate (last 7 days):
  Mon: ████████ 7
  Tue: ████ 4
  Wed: ██ 2
  ...

Graph edges: 0
Profile: Built
Sync: disabled
DB size: 1.2 MB
```

## Result

✅ **Before Migration:**
- Manual file maintenance required
- Files read on every session (high token cost)
- Potential for stale information

✅ **After Migration:**
- Fully automated memory management
- No manual file updates needed
- Lower token costs (no file reading)
- Semantic search and deduplication
- Graph edges for related memories
- Auto-capture and auto-recall

## Rollback (if needed)

If you need to rollback:

```bash
# Restore from archive
cp .archive/MEMORY.md.20240217 MEMORY.md
cp -r .archive/memory-20240217/ memory/

# Optional: Clear migrated memories from database
# (Use with caution - this deletes data)
# You can query and delete specific categories if needed
```

## Next Steps

1. Monitor auto-capture for a few sessions
2. Adjust `profileFrequency` and `dedupeThreshold` in config if needed
3. Explore graph edges for linking related memories
4. Try project indexing for codebase context
5. Share feedback on the migration process

## Tips

- Keep backups for at least a few weeks
- Run verification periodically to ensure coverage
- Use `slm search` to test if memories are findable
- Adjust category and priority as needed
- Re-run migration if you add content to archived files (deduplication prevents duplicates)
