# Snapshot Cache System

## Overview

The Playwright MCP server includes a **dual-layer snapshot caching system** designed for efficient analysis of large web documents:

1. **In-memory cache** - Fast access for active session searches and agent operations
2. **Disk persistence** - Organized storage for cross-session recovery and dataset building

This is particularly useful for legal case research, where you need to systematically process hundreds of documents while preserving the data for later analysis.

## Architecture

### Dual-Layer Design

```
┌─────────────────────────────────────────┐
│           Agent navigates to URL        │
│    https://www.rejust.ro/juris/3g4974ed7│
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│         Takes snapshot (too large)      │
│              479 lines                  │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴──────────┐
        │                    │
        ▼                    ▼
┌──────────────┐    ┌────────────────────┐
│  IN-MEMORY   │    │  DISK PERSISTENCE  │
│              │    │                    │
│ Cache ID:    │    │ ~/Downloads/       │
│ 1879f050     │    │   rejust-searches/ │
│              │    │     [context]/     │
│ Fast search  │    │       [case-id]-   │
│ by agents    │    │         part-N.json│
└──────────────┘    └────────────────────┘
```

### File Organization

Snapshots are organized by **search context** (user-defined folder name):

```
~/Downloads/rejust-searches/
├── protection-order-cluj-2025/
│   ├── 3g4974ed7-meta.json         # Metadata: title, URL, structure hints
│   ├── 3g4974ed7-part-1.json       # Content: lines 1-1000
│   ├── 3g4974ed7-part-2.json       # Content: lines 1001-2000
│   ├── gg9d836ee-meta.json
│   ├── gg9d836ee-part-1.json
│   └── ...
│
├── theft-cases-bucharest-2024/
│   ├── 7a2b3c4d-meta.json
│   ├── 7a2b3c4d-part-1.json
│   └── ...
│
└── contract-disputes-2025/
    └── ...
```

## Configuration

### Setting Search Context

**Method 1: MCP Server Config (Recommended)**

Edit `~/.claude/config/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "playwright-multi-tab": {
      "command": "node",
      "args": [
        "/Users/elod.szopos/Projects/playwright-mcp/custom-cli.js",
        "--search-context",
        "protection-order-cluj-2025"
      ]
    }
  }
}
```

**Method 2: Runtime (via code)**

```javascript
const snapshotCache = require('./src/snapshot-cache-enhanced');

// Set search context before processing cases
snapshotCache.setSearchContext('protection-order-cluj-2025');

// Now all snapshots will be saved to:
// ~/Downloads/rejust-searches/protection-order-cluj-2025/
```

### Search Context Naming

Search context names are automatically sanitized:

| User Input | Sanitized Folder Name |
|------------|----------------------|
| `Protection Order - Cluj 2025` | `protection-order-cluj-2025` |
| `Theft Cases (Bucharest)` | `theft-cases-bucharest-` |
| `Contract Disputes 2025!` | `contract-disputes-2025-` |

**Rules:**
- Lowercase only
- Alphanumeric + hyphens/underscores
- Max 100 characters
- Multiple spaces/special chars collapsed to single hyphen

## Usage Examples

### Example 1: Single Case Analysis

```javascript
// Agent navigates to case
await page.goto('https://www.rejust.ro/juris/3g4974ed7');

// Takes snapshot (automatically cached if >300 lines)
const snapshot = await page.snapshot();

// If cached, returns:
{
  cacheId: "1879f050",
  totalLines: 479,
  structureHints: [...]
}

// Saved to disk:
// ~/Downloads/rejust-searches/[context]/3g4974ed7-meta.json
// ~/Downloads/rejust-searches/[context]/3g4974ed7-part-1.json
```

### Example 2: Multi-Agent Processing

**Main session:**
```javascript
// Set search context
snapshotCache.setSearchContext('cluj-protection-orders-dec-2025');

// Spawn 10 agents, each processing 20 cases
for (let i = 0; i < 10; i++) {
  const startIdx = i * 20;
  const endIdx = startIdx + 20;
  const caseBatch = allCases.slice(startIdx, endIdx);

  spawnAgent(`process-batch-${i}`, caseBatch);
}
```

**Each agent:**
```javascript
// Agent processes its 20 cases
for (const caseUrl of caseBatch) {
  await page.goto(caseUrl);
  const snapshot = await page.snapshot(); // Auto-cached

  // Extract data using cache
  const courtInfo = await searchInCache(snapshot.cacheId, 'Judecătoria');
  const decision = await searchInCache(snapshot.cacheId, 'pedeapsa');

  // Build case record...
}
```

**Result:**
```
~/Downloads/rejust-searches/cluj-protection-orders-dec-2025/
├── 3g4974ed7-meta.json     # Case 1
├── 3g4974ed7-part-1.json
├── gg9d836ee-meta.json     # Case 2
├── gg9d836ee-part-1.json
├── ...                     # Cases 3-200
```

### Example 3: Cross-Session Recovery

**Session 1: Collect data**
```bash
# Process 200 cases, all cached to disk
# ~/Downloads/rejust-searches/protection-orders-2025/
```

**Session 2 (next day): Analyze data**
```javascript
// List all cases from previous session
const cases = snapshotCache.listCasesInSearch('protection-orders-2025');

console.log(cases);
// [
//   { caseId: '3g4974ed7', url: '...', totalLines: 479, ... },
//   { caseId: 'gg9d836ee', url: '...', totalLines: 312, ... },
//   ...
// ]

// Load specific case from disk
const caseData = snapshotCache.loadCacheFromDisk('3g4974ed7', 'protection-orders-2025');

// Analyze...
```

## API Reference

### Configuration

```javascript
const snapshotCache = require('./src/snapshot-cache-enhanced');

// CONFIG object
snapshotCache.CONFIG = {
  maxLines: 300,           // Trigger caching threshold
  maxCacheSize: 50,        // Max in-memory snapshots
  cacheExpiry: 1800000,    // 30 minutes (memory only)
  defaultPageSize: 100,    // Lines per page
  persistToDisk: true,     // Enable disk persistence
  baseDir: '~/Downloads/rejust-searches',
  maxLinesPerFile: 1000    // Lines per part file
}
```

### Core Functions

#### `setSearchContext(contextName)`
Set the current search context (folder name).

```javascript
snapshotCache.setSearchContext('protection-order-cluj-2025');
// Returns: 'protection-order-cluj-2025'
```

#### `getSearchContext()`
Get the current search context.

```javascript
const context = snapshotCache.getSearchContext();
// Returns: 'protection-order-cluj-2025'
```

#### `cacheSnapshot(snapshotText, url, title, searchContext?)`
Cache a snapshot (automatically called by MCP tools).

```javascript
const result = snapshotCache.cacheSnapshot(
  largeSnapshotText,
  'https://www.rejust.ro/juris/3g4974ed7',
  'Case Title',
  'optional-context-override'
);

// Returns:
{
  cacheId: '1879f050',
  totalLines: 479,
  structureHints: [
    { line: 113, element: 'nr. 557/2025 din 22.12.2025...' },
    ...
  ]
}
```

#### `getCachedSnapshot(cacheId)`
Retrieve cached snapshot (tries memory, falls back to disk).

```javascript
const cached = snapshotCache.getCachedSnapshot('1879f050');

// Returns:
{
  content: '...',  // Full text
  lines: [...],    // Array of lines
  url: '...',
  title: '...',
  totalLines: 479,
  createdAt: 1704553200000,
  structureHints: [...]
}
```

#### `getPaginatedContent(cacheId, startLine, endLine)`
Get a range of lines from cache.

```javascript
const page = snapshotCache.getPaginatedContent('1879f050', 1, 100);

// Returns:
{
  content: '...',      // Lines 1-100 joined
  startLine: 1,
  endLine: 100,
  totalLines: 479,
  hasMore: true
}
```

#### `searchInCache(cacheId, query, maxResults?)`
Search for text within cached snapshot.

```javascript
const results = snapshotCache.searchInCache('1879f050', 'Judecătoria', 5);

// Returns:
{
  query: 'Judecătoria',
  totalMatches: 3,
  results: [
    { line: 113, content: 'pronunțată de Judecătoria Zalău...' },
    { line: 138, content: 'Hotărâre din 22.12.2025, Judecătoria Zalău...' },
    ...
  ]
}
```

### Management Functions

#### `listSearches()`
List all search contexts.

```javascript
const searches = snapshotCache.listSearches();

// Returns:
[
  {
    searchContext: 'protection-orders-2025',
    caseCount: 200,
    path: '/Users/.../Downloads/rejust-searches/protection-orders-2025'
  },
  ...
]
```

#### `listCasesInSearch(searchContext?)`
List all cases in a search context.

```javascript
const cases = snapshotCache.listCasesInSearch('protection-orders-2025');

// Returns:
[
  {
    caseId: '3g4974ed7',
    url: 'https://www.rejust.ro/juris/3g4974ed7',
    title: 'Penal - nerespectarea ordinelor de protecţie',
    totalLines: 479,
    numParts: 1,
    createdAt: '2025-01-06T17:15:00.000Z'
  },
  ...
]
```

#### `loadCacheFromDisk(caseId, searchContext?)`
Load a specific case from disk.

```javascript
const caseData = snapshotCache.loadCacheFromDisk('3g4974ed7', 'protection-orders-2025');

// Returns same structure as getCachedSnapshot()
```

#### `extractCaseId(url)`
Extract case ID from rejust.ro URL.

```javascript
const caseId = snapshotCache.extractCaseId('https://www.rejust.ro/juris/3g4974ed7');
// Returns: '3g4974ed7'
```

## File Formats

### Metadata File (`[case-id]-meta.json`)

```json
{
  "cacheId": "1879f050",
  "caseId": "3g4974ed7",
  "url": "https://www.rejust.ro/juris/3g4974ed7",
  "title": "Penal - nerespectarea ordinelor de protecţie",
  "totalLines": 479,
  "numParts": 1,
  "searchContext": "protection-orders-2025",
  "createdAt": 1704553200000,
  "structureHints": [
    {
      "line": 113,
      "element": "nr. 557/2025 din 22.12.2025 pronunțată de Judecătoria Zalău..."
    },
    {
      "line": 138,
      "ref": "e70",
      "element": "link \"Hotărâre din 22.12.2025, Judecătoria Zalău...\""
    }
  ]
}
```

### Content Part File (`[case-id]-part-N.json`)

```json
{
  "cacheId": "1879f050",
  "caseId": "3g4974ed7",
  "url": "https://www.rejust.ro/juris/3g4974ed7",
  "part": 1,
  "totalParts": 1,
  "startLine": 1,
  "endLine": 479,
  "lines": [
    "- <changed> generic [ref=e2]:",
    "  - link \"Sigla CSM\" [ref=e10] [cursor=pointer]:",
    "    - /url: /",
    "..."
  ]
}
```

## Performance Characteristics

### In-Memory Cache

- **Speed**: Instant (Map lookup)
- **Capacity**: 50 snapshots (configurable)
- **Eviction**: LRU (oldest first when full)
- **Expiry**: 30 minutes after creation
- **Persistence**: Session only

### Disk Cache

- **Speed**: ~10-50ms per case (depends on size)
- **Capacity**: Unlimited (disk space)
- **Eviction**: Manual deletion only
- **Expiry**: Never (persists indefinitely)
- **Persistence**: Cross-session

### Splitting

Large snapshots are split into parts:
- Max 1000 lines per JSON file
- Example: 2500-line snapshot → 3 part files
- Enables efficient partial loading

## Common Use Cases

### Legal Case Research

**Scenario**: Analyze 200 protection order violation cases from Cluj courts.

**Setup**:
```bash
# Set search context in MCP config
--search-context protection-orders-cluj-2025
```

**Workflow**:
1. Main session spawns 10 agents
2. Each agent processes 20 cases
3. Each case snapshot auto-saved to disk
4. All 200 cases cached in organized folder
5. Cross-session analysis of collected data

**Output**:
```
~/Downloads/rejust-searches/protection-orders-cluj-2025/
  400 files (200 cases × 2 files each: meta + content)
```

### Dataset Building

**Scenario**: Build training dataset for legal AI model.

**Setup**:
```javascript
snapshotCache.setSearchContext('ai-training-dataset-2025');
```

**Workflow**:
1. Process cases over multiple sessions
2. All snapshots accumulate in same folder
3. Export to JSON for model training
4. Metadata includes structure hints for parsing

**Export**:
```javascript
const cases = snapshotCache.listCasesInSearch('ai-training-dataset-2025');

const dataset = cases.map(c => {
  const data = snapshotCache.loadCacheFromDisk(c.caseId, 'ai-training-dataset-2025');
  return {
    id: c.caseId,
    url: c.url,
    content: data.content,
    metadata: c
  };
});

fs.writeFileSync('training-data.json', JSON.stringify(dataset, null, 2));
```

### Multi-Search Projects

**Scenario**: Compare different types of cases.

**Setup**:
```javascript
// Search 1: Protection orders
snapshotCache.setSearchContext('protection-orders-2025');
// ... process cases ...

// Search 2: Theft cases
snapshotCache.setSearchContext('theft-cases-2025');
// ... process cases ...

// Search 3: Contract disputes
snapshotCache.setSearchContext('contract-disputes-2025');
// ... process cases ...
```

**Analysis**:
```javascript
const searches = snapshotCache.listSearches();

for (const search of searches) {
  console.log(`${search.searchContext}: ${search.caseCount} cases`);

  const cases = snapshotCache.listCasesInSearch(search.searchContext);
  // Comparative analysis...
}
```

## Troubleshooting

### Cache Not Persisting

**Issue**: Snapshots not saved to disk.

**Check**:
1. Verify `CONFIG.persistToDisk = true`
2. Check permissions on `~/Downloads/`
3. Look for errors in MCP server logs
4. Ensure search context is set

### Missing Parts

**Issue**: Cannot load cache from disk.

**Possible causes**:
- Part files deleted manually
- Incomplete save (server crashed mid-write)
- Wrong search context specified

**Solution**:
```javascript
// List available searches
const searches = snapshotCache.listSearches();

// Check which cases are in each search
searches.forEach(s => {
  const cases = snapshotCache.listCasesInSearch(s.searchContext);
  console.log(`${s.searchContext}:`, cases.map(c => c.caseId));
});
```

### Memory Pressure

**Issue**: Too many snapshots in memory.

**Solution**:
```javascript
// Reduce max cache size
snapshotCache.CONFIG.maxCacheSize = 20;

// Reduce expiry time
snapshotCache.CONFIG.cacheExpiry = 10 * 60000; // 10 minutes
```

## Best Practices

### Naming Conventions

Use descriptive search context names:

✅ **Good**:
- `protection-orders-cluj-2025`
- `theft-vehicles-bucharest-q4-2024`
- `contract-disputes-commercial-2025`

❌ **Bad**:
- `search1`
- `cases`
- `temp`

### Batching

For large datasets, process in batches:

```javascript
const batchSize = 50;
const totalCases = 200;

for (let i = 0; i < totalCases; i += batchSize) {
  const batch = cases.slice(i, i + batchSize);

  // Process batch
  await processBatch(batch);

  // Log progress
  console.log(`Processed ${i + batch.length}/${totalCases} cases`);
}
```

### Cleanup

Periodically clean up old searches:

```bash
# Remove old searches
rm -rf ~/Downloads/rejust-searches/old-search-2024/

# Or selectively keep recent ones
find ~/Downloads/rejust-searches/ -type d -mtime +90 -exec rm -rf {} \;
```

## Migration Guide

If you have existing code using the old cache system:

### Before (old cache)

```javascript
const snapshotCache = require('./src/snapshot-cache');

// Snapshots only in memory, lost after session
```

### After (enhanced cache)

```javascript
const snapshotCache = require('./src/snapshot-cache-enhanced');

// Set search context for organized persistence
snapshotCache.setSearchContext('my-search-2025');

// Everything else works the same
// Plus: snapshots persisted to disk automatically
```

**Breaking changes**: None. The enhanced cache is fully backward compatible.

## Future Enhancements

Potential future additions:

- [ ] Automatic deduplication (same case cached twice)
- [ ] Compression (gzip part files for large datasets)
- [ ] Search across all cached cases (full-text index)
- [ ] Export to CSV/Excel with structured extraction
- [ ] S3/cloud storage backend option
- [ ] Incremental updates (re-cache only changed cases)
