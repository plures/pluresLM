# Migration Guide: From Manual Files to SLM-Only Memory

> Historical migration experiment, not a native installer migration procedure.
> Do not delete source memories or imports based on this guide. See
> [current migration boundaries](OPERATIONS.md).

This guide helps you transition from manually maintaining memory files (`MEMORY.md` and `memory/*.md`) to using SLM (SuperLocalMemory) as your sole memory system.

## Problem

When using both manual files and SLM simultaneously:
- **Doubled token costs** — agents read files AND query SLM
- **Maintenance burden** — manually updating files is tedious
- **Sync issues** — manual files can become stale
- **Redundancy** — same information stored twice

## Solution

SLM can handle all memory functions:
- ✅ Auto-capture after each session
- ✅ Auto-recall before each session
- ✅ Semantic search and deduplication
- ✅ Profile building and consolidation
- ✅ Graph edges for related memories

## Migration Phases

### Phase 1: Current State (Both Systems)

You have:
- Manual `MEMORY.md` with critical facts
- Optional `memory/` directory with daily summaries
- SLM plugin enabled and capturing new memories

### Phase 2: Import Existing Content

Import your manual files into SLM:

```bash
# Import MEMORY.md as critical-priority memories
slm migrate-from-files --source MEMORY.md --priority critical

# Import daily files (optional)
slm migrate-from-files --source memory/ --category daily-summary
```

**Options:**
- `--dry-run` — Preview what would be imported
- `--priority <level>` — Set priority: `critical`, `high`, or `normal`
- `--category <name>` — Set category (default: `migrated-memory`)

### Phase 3: Verify Coverage

Ensure all content was captured:

```bash
slm verify-migration --source MEMORY.md --threshold 0.9
```

This checks that at least 90% of your content is findable via vector search.

**Expected output:**
```
✅ Verification complete!
  Total items: 42
  Found in DB: 40
  Missing: 2
  Coverage: 95.2%

✅ Migration verified! Coverage meets threshold.
```

If coverage is low, check:
1. Are embeddings working? (Run `slm dashboard` to check)
2. Are the missing items too similar to existing ones? (Check with `slm search "<missing item>"`)
3. Do you need to lower the threshold?

### Phase 4: Archive Manual Files

Once verified, archive (don't delete) your manual files:

```bash
# Create archive directory
mkdir -p .archive

# Move files to archive
mv MEMORY.md .archive/MEMORY.md.$(date +%Y%m%d)
mv memory/ .archive/memory-$(date +%Y%m%d)/

# Optional: Add to .gitignore
echo ".archive/" >> .gitignore
```

**Why archive instead of delete?**
- Safety net if you need to re-import
- Historical record of what was migrated
- Can always delete later once confident

### Phase 5: Update AGENTS.md

Update your `.github/agents/AGENTS.md` or equivalent to remove manual memory instructions:

**Before:**
```markdown
## Memory Management

Read MEMORY.md before starting each session.
Update MEMORY.md when you learn important facts.
Write daily summaries to memory/YYYY-MM-DD.md.
```

**After:**
```markdown
## Memory Management

Memory is handled by superlocalmemory. Do not maintain MEMORY.md or daily files manually.
The system automatically captures and recalls relevant information.

Use the `superlocalmemory_search` tool to query memory when needed.
```

## Supported File Formats

### MEMORY.md

Standard markdown with sections and bullet points:

```markdown
# User Preferences

- I prefer TypeScript over JavaScript
- I like dark mode themes
- My favorite editor is VS Code

# Project Context

Working on a memory migration tool for superlocalmemory.

## Technologies

Using Node.js and TypeScript for implementation.
SQLite for storage with vector embeddings.
```

**Parsing rules:**
- Headers (`#`, `##`, etc.) become section tags
- Bullet points (`-`, `*`, `+`) become individual memories
- Paragraphs (20+ chars) become individual memories
- Very short items (< 20 chars) are filtered out

### Daily Files

Files named with dates (e.g., `2024-01-15.md`):

```markdown
Today I worked on the migration tool implementation.

Made good progress on file parsing and CLI commands.

Need to add verification logic next.
```

**Parsing rules:**
- Filename date becomes a `date:YYYY-MM-DD` tag
- Paragraphs separated by blank lines become individual memories
- Each memory gets `category: daily-summary` and `priority: normal`

## Advanced Usage

### Custom Priority Levels

Override default priorities:

```bash
# Import MEMORY.md as high-priority instead of critical
slm migrate-from-files --source MEMORY.md --priority high

# Import daily files with normal priority (default)
slm migrate-from-files --source memory/ --priority normal
```

### Custom Categories

Organize imported memories by category:

```bash
# Import as "historical-context" category
slm migrate-from-files --source MEMORY.md --category historical-context

# Import as "session-notes" category
slm migrate-from-files --source memory/ --category session-notes
```

### Selective Import

Import only specific files or directories:

```bash
# Import just one daily file
slm migrate-from-files --source memory/2024-01-15.md

# Import a subset of files
slm migrate-from-files --source memory/2024-01/
```

## Troubleshooting

### Low Coverage After Verification

**Problem:** Verification shows < 90% coverage

**Solutions:**
1. Check if embeddings are working:
   ```bash
   slm dashboard
   ```
   Look for "Embedding health" section.

2. Search for missing items manually:
   ```bash
   slm search "your missing content"
   ```

3. Lower the threshold:
   ```bash
   slm verify-migration --source MEMORY.md --threshold 0.8
   ```

4. Re-run migration (deduplication prevents duplicates):
   ```bash
   slm migrate-from-files --source MEMORY.md
   ```

### Duplicate Memories

**Problem:** Same content imported multiple times

**Solution:** SLM automatically detects and merges duplicates (similarity > 95%). Check with:

```bash
slm dedup --dry-run
```

### Migration Taking Too Long

**Problem:** Large files taking a long time to import

**Solutions:**
1. Use `--dry-run` first to preview:
   ```bash
   slm migrate-from-files --source MEMORY.md --dry-run
   ```

2. Import in smaller batches:
   ```bash
   slm migrate-from-files --source memory/2024-01/
   slm migrate-from-files --source memory/2024-02/
   ```

3. Check embedding provider performance:
   ```bash
   slm dashboard
   ```
   If Ollama is slow, switch to OpenAI or vice versa.

## Best Practices

### Before Migration

1. ✅ Backup your files
2. ✅ Run `slm dashboard` to verify system health
3. ✅ Test with `--dry-run` first
4. ✅ Check a few memories with `slm search` to verify quality

### During Migration

1. ✅ Start with MEMORY.md (most important content)
2. ✅ Use `--dry-run` to preview
3. ✅ Import in small batches if you have many files
4. ✅ Monitor for errors in the output

### After Migration

1. ✅ Run verification with `slm verify-migration`
2. ✅ Test search with `slm search` for key topics
3. ✅ Archive (don't delete) original files
4. ✅ Update AGENTS.md to remove manual memory instructions
5. ✅ Monitor auto-capture for a few sessions to ensure it's working

## FAQ

### Q: Will migration create duplicate memories?

**A:** No. SLM automatically detects duplicates using semantic similarity. If content is >95% similar to existing memories, it will be merged instead of creating a duplicate.

### Q: Can I re-run migration if something goes wrong?

**A:** Yes. Due to deduplication, re-running migration is safe. It will only add new content that wasn't captured the first time.

### Q: What happens to my manual files after migration?

**A:** Nothing. Migration only reads files, it never modifies or deletes them. You should archive them manually once you've verified the migration.

### Q: How do I know if I should migrate?

**A:** Migrate if:
- You're maintaining both manual files AND using SLM
- You find manual file updates tedious
- You want lower token costs (no file reading)
- You want automatic memory management

Don't migrate if:
- You prefer manual control
- You don't trust automated systems yet
- You have very specific memory formats SLM can't parse

### Q: Can I still add memories manually after migration?

**A:** Yes! Use the `superlocalmemory_store` tool or `slm` CLI commands. SLM doesn't prevent manual memory management, it just automates it.

### Q: What if my MEMORY.md has a custom format?

**A:** The migration tool supports standard markdown. If you have a custom format, you may need to:
1. Convert to standard markdown first
2. Parse it yourself and use `superlocalmemory_store` programmatically
3. File an issue with your format so we can add support

## Getting Help

If you encounter issues:

1. Check the logs: Look for error messages in the migration output
2. Run diagnostics: `slm dashboard` shows system health
3. File an issue: Include migration output and file samples (without sensitive data)
4. Ask in discussions: Share your use case and get community help

## Next Steps

After successful migration:

1. **Monitor auto-capture**: Watch the first few sessions to ensure SLM captures what you need
2. **Adjust settings**: Tune `profileFrequency`, `dedupeThreshold`, etc. in config
3. **Explore features**: Try graph edges, project indexing, and other SLM features
4. **Share feedback**: Let us know how migration worked for you!
