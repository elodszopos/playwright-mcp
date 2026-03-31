# Quick Start: Organized Snapshot Caching

## 5-Minute Setup

### 1. Configure MCP Server

Edit `~/.claude/config/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "playwright-multi-tab": {
      "command": "node",
      "args": [
        "/Users/elod.szopos/Projects/playwright-mcp/custom-cli.js",
        "--search-context",
        "my-research-2025"
      ]
    }
  }
}
```

**Change `my-research-2025` to your search name.**

### 2. Restart Claude Desktop

The MCP server will now save all snapshots to:
```
~/Downloads/rejust-searches/my-research-2025/
```

### 3. Done!

Snapshots are automatically:
- ✅ Cached in memory for fast agent access
- ✅ Saved to disk in organized folders
- ✅ Split into manageable parts
- ✅ Preserved across sessions

## Example: Analyze 200 Legal Cases

### Task
Process 200 rejust.ro cases, extract court names and decisions.

### Setup
```json
{
  "mcpServers": {
    "playwright-multi-tab": {
      "command": "node",
      "args": [
        "/Users/elod.szopos/Projects/playwright-mcp/custom-cli.js",
        "--search-context",
        "protection-orders-cluj-dec2025"
      ]
    }
  }
}
```

### Tell Claude

```
I have 200 rejust.ro case URLs. Process them using agents:
- Spawn 10 agents, 20 cases each
- Extract: court name, date, charges, decision
- Output: JSON with all cases
```

### What Happens

1. **10 agents spawn** - Each gets 20 URLs
2. **Each agent**:
   - Navigates to case URL
   - Snapshots page → **Auto-cached to disk**
   - Searches cache for court, decision, etc.
   - Builds case record
3. **All snapshots saved** to:
   ```
   ~/Downloads/rejust-searches/protection-orders-cluj-dec2025/
   ├── 3g4974ed7-meta.json
   ├── 3g4974ed7-part-1.json
   ├── gg9d836ee-meta.json
   ├── gg9d836ee-part-1.json
   └── ... (200 cases total)
   ```
4. **Main session** aggregates all results → JSON output

### After Processing

**Re-analyze later** (without re-scraping):

```javascript
const cases = snapshotCache.listCasesInSearch('protection-orders-cluj-dec2025');
// Load and analyze from disk cache
```

## File Organization

```
~/Downloads/rejust-searches/
├── protection-orders-cluj-dec2025/  ← Your search folder
│   ├── 3g4974ed7-meta.json          ← Case metadata
│   ├── 3g4974ed7-part-1.json        ← Case content (1000 lines)
│   ├── 3g4974ed7-part-2.json        ← Continuation (if >1000 lines)
│   ├── gg9d836ee-meta.json
│   ├── gg9d836ee-part-1.json
│   └── ...
│
└── another-search/                  ← Different search
    └── ...
```

## Common Commands

### Change Search Context

**Edit config**, restart Claude Desktop:
```json
"--search-context", "new-search-name"
```

### List All Searches

In Node.js:
```javascript
const snapshotCache = require('./src/snapshot-cache-enhanced');
const searches = snapshotCache.listSearches();
console.log(searches);
```

### Load Cached Case

```javascript
const caseData = snapshotCache.loadCacheFromDisk(
  '3g4974ed7',
  'protection-orders-cluj-dec2025'
);
```

## Tips

### Good Search Names

✅ Use:
- `protection-orders-cluj-2025`
- `theft-cases-bucharest-q4`
- `contract-disputes-commercial`

❌ Avoid:
- `search1` (not descriptive)
- `temp` (gets lost)
- `cases` (too generic)

### Processing Large Datasets

**Batch in groups of 50:**
```
Process cases 1-50   → protectionorders-batch1
Process cases 51-100 → protectionorders-batch2
...
```

Or use one folder and let it accumulate.

### Clean Up Old Searches

```bash
# Remove entire search
rm -rf ~/Downloads/rejust-searches/old-search-2024/

# Remove searches older than 90 days
find ~/Downloads/rejust-searches/ -type d -mtime +90 -exec rm -rf {} \;
```

## Troubleshooting

### Snapshots Not Saving

**Check**:
1. Search context set in config? ✓
2. Restarted Claude Desktop? ✓
3. Check `~/Downloads/rejust-searches/` exists? ✓

### Can't Find Cached Cases

**List what's available**:
```javascript
const searches = snapshotCache.listSearches();
console.log('Available searches:', searches);

searches.forEach(s => {
  const cases = snapshotCache.listCasesInSearch(s.searchContext);
  console.log(`${s.searchContext}: ${cases.length} cases`);
});
```

### Out of Memory

**Reduce cache size** in `snapshot-cache-enhanced.js`:
```javascript
CONFIG: {
  maxCacheSize: 20,  // Default: 50
  cacheExpiry: 10 * 60000  // 10 min instead of 30 min
}
```

## What Gets Cached?

**Automatically cached when snapshot >300 lines:**
- Full page accessibility tree
- All text content
- Interactive elements (buttons, links, etc.)
- Structure hints for navigation

**Split into parts if >1000 lines:**
- Part 1: Lines 1-1000
- Part 2: Lines 1001-2000
- etc.

## Full Documentation

See [SNAPSHOT-CACHE.md](./SNAPSHOT-CACHE.md) for complete API reference and advanced usage.
