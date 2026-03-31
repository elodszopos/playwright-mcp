/**
 * Enhanced Snapshot Cache with Organized Disk Persistence
 *
 * Dual-layer caching:
 * 1. In-memory cache for fast agent searching (original functionality)
 * 2. Disk persistence organized by search context
 *
 * Format: ~/Downloads/rejust-searches/[search-name]/[case-id]-part-[x].json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// In-memory cache for snapshots (original)
const snapshotCache = new Map();

// Current search context (can be set externally)
let currentSearchContext = 'default-search';

// Configuration
const CONFIG = {
  maxLines: 300,           // Max lines before triggering pagination
  maxCacheSize: 50,        // Max cached snapshots
  cacheExpiry: 30 * 60000, // 30 minutes
  defaultPageSize: 100,    // Default lines per page
  persistToDisk: true,     // Enable disk persistence
  baseDir: path.join(os.homedir(), 'Downloads', 'rejust-searches'),
  maxLinesPerFile: 1000    // Split large caches into multiple files
};

/**
 * Set the current search context (folder name)
 * E.g., "protection-order-violations-cluj-2025"
 */
function setSearchContext(contextName) {
  if (!contextName) {
    throw new Error('Search context name cannot be empty');
  }
  // Sanitize context name for filesystem
  currentSearchContext = contextName
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100);

  console.error(`[Cache] Search context set to: ${currentSearchContext}`);
  return currentSearchContext;
}

/**
 * Get current search context
 */
function getSearchContext() {
  return currentSearchContext;
}

/**
 * Ensure search directory exists
 */
function ensureSearchDir(searchContext = currentSearchContext) {
  const searchDir = path.join(CONFIG.baseDir, searchContext);
  if (!fs.existsSync(searchDir)) {
    fs.mkdirSync(searchDir, { recursive: true });
  }
  return searchDir;
}

/**
 * Extract case ID from rejust.ro URL
 * Example: https://www.rejust.ro/juris/3g4974ed7 -> 3g4974ed7
 */
function extractCaseId(url) {
  if (!url) return 'unknown';

  try {
    // Match rejust.ro case ID pattern
    const match = url.match(/\/juris\/([a-z0-9]+)/i);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: use last path segment
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    return pathParts[pathParts.length - 1] || 'unknown';
  } catch (e) {
    // Fallback for invalid URLs
    return url
      .replace(/[^a-zA-Z0-9]/g, '_')
      .substring(0, 20);
  }
}

/**
 * Generate short cache ID
 */
function generateCacheId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Count lines in text
 */
function countLines(text) {
  return text.split('\n').length;
}

/**
 * Check if snapshot needs pagination
 */
function needsPagination(snapshotText) {
  return countLines(snapshotText) > CONFIG.maxLines;
}

/**
 * Save cache to disk in organized structure
 */
function saveCacheToDisk(cacheId, cacheData, searchContext = currentSearchContext) {
  if (!CONFIG.persistToDisk) return;

  try {
    const searchDir = ensureSearchDir(searchContext);
    const caseId = extractCaseId(cacheData.url);
    const lines = cacheData.lines;
    const totalLines = lines.length;

    // Calculate number of parts needed
    const numParts = Math.ceil(totalLines / CONFIG.maxLinesPerFile);

    // Save metadata file
    const metadataPath = path.join(searchDir, `${caseId}-meta.json`);
    fs.writeFileSync(metadataPath, JSON.stringify({
      cacheId,
      caseId,
      url: cacheData.url,
      title: cacheData.title,
      totalLines,
      numParts,
      searchContext,
      createdAt: cacheData.createdAt,
      structureHints: cacheData.structureHints
    }, null, 2));

    // Save content in parts
    for (let part = 0; part < numParts; part++) {
      const startIdx = part * CONFIG.maxLinesPerFile;
      const endIdx = Math.min(startIdx + CONFIG.maxLinesPerFile, totalLines);
      const partLines = lines.slice(startIdx, endIdx);

      const partPath = path.join(searchDir, `${caseId}-part-${part + 1}.json`);
      fs.writeFileSync(partPath, JSON.stringify({
        cacheId,
        caseId,
        url: cacheData.url,
        part: part + 1,
        totalParts: numParts,
        startLine: startIdx + 1,
        endLine: endIdx,
        lines: partLines
      }, null, 2));
    }

    console.error(`[Cache] Saved: ${searchContext}/${caseId} (${numParts} parts, ${totalLines} lines)`);
  } catch (error) {
    console.error(`[Cache] Failed to save to disk: ${error.message}`);
  }
}

/**
 * Load cache from disk
 */
function loadCacheFromDisk(caseId, searchContext = currentSearchContext) {
  try {
    const searchDir = path.join(CONFIG.baseDir, searchContext);
    if (!fs.existsSync(searchDir)) return null;

    const metadataPath = path.join(searchDir, `${caseId}-meta.json`);
    if (!fs.existsSync(metadataPath)) return null;

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    // Load all parts
    const allLines = [];
    for (let part = 1; part <= metadata.numParts; part++) {
      const partPath = path.join(searchDir, `${caseId}-part-${part}.json`);
      if (!fs.existsSync(partPath)) {
        console.error(`[Cache] Missing part ${part} for ${caseId}`);
        return null;
      }

      const partData = JSON.parse(fs.readFileSync(partPath, 'utf8'));
      allLines.push(...partData.lines);
    }

    console.error(`[Cache] Loaded: ${searchContext}/${caseId} (${metadata.numParts} parts, ${allLines.length} lines)`);

    return {
      content: allLines.join('\n'),
      lines: allLines,
      url: metadata.url,
      title: metadata.title,
      totalLines: metadata.totalLines,
      createdAt: metadata.createdAt,
      structureHints: metadata.structureHints
    };
  } catch (error) {
    console.error(`[Cache] Failed to load from disk: ${error.message}`);
    return null;
  }
}

/**
 * Cache a large snapshot and return metadata
 * Enhanced with organized disk persistence
 */
function cacheSnapshot(snapshotText, url, title, searchContext = currentSearchContext) {
  // Cleanup old entries if cache is full
  if (snapshotCache.size >= CONFIG.maxCacheSize) {
    const oldestKey = snapshotCache.keys().next().value;
    snapshotCache.delete(oldestKey);
  }

  const cacheId = generateCacheId();
  const lines = snapshotText.split('\n');
  const totalLines = lines.length;

  // Extract structure hints (elements with refs)
  const structureHints = extractStructureHints(lines);

  const cacheData = {
    content: snapshotText,
    lines: lines,
    url: url,
    title: title,
    totalLines: totalLines,
    createdAt: Date.now(),
    structureHints: structureHints
  };

  // Store in memory
  snapshotCache.set(cacheId, cacheData);

  // Persist to disk in organized structure
  saveCacheToDisk(cacheId, cacheData, searchContext);

  // Set expiry (only for in-memory, disk files persist)
  setTimeout(() => {
    snapshotCache.delete(cacheId);
  }, CONFIG.cacheExpiry);

  return {
    cacheId,
    totalLines,
    structureHints
  };
}

/**
 * Extract structure hints from snapshot
 * Finds main sections, iframes, important elements
 */
function extractStructureHints(lines) {
  const hints = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Find main structural elements
    if (line.match(/^- (main|nav|header|footer|aside|article|section|iframe|dialog|form)/i)) {
      hints.push({
        line: i + 1,
        element: line.trim().substring(2, 50) + (line.length > 52 ? '...' : '')
      });
    }

    // Find elements with refs (interactive elements)
    const refMatch = line.match(/\[ref=([a-z0-9]+)\]/);
    if (refMatch && hints.length < 20) {
      // Only add if it's a significant element
      if (line.match(/(button|link|textbox|checkbox|combobox|table|grid)/i)) {
        hints.push({
          line: i + 1,
          ref: refMatch[1],
          element: line.trim().substring(0, 60) + (line.length > 60 ? '...' : '')
        });
      }
    }
  }

  return hints.slice(0, 15); // Limit hints
}

/**
 * Get cached snapshot by ID
 * Tries memory first, then disk
 */
function getCachedSnapshot(cacheId) {
  // Try memory first
  let cached = snapshotCache.get(cacheId);

  // Note: For disk loading, we'd need the caseId which we don't have from cacheId alone
  // This is where the in-memory cache is essential during active session
  // For cross-session recovery, use loadCacheFromDisk with known caseId

  return cached;
}

/**
 * Get paginated content from cache
 */
function getPaginatedContent(cacheId, startLine = 1, endLine = null) {
  const cached = getCachedSnapshot(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }

  const start = Math.max(1, startLine) - 1; // Convert to 0-indexed
  const end = endLine ? Math.min(endLine, cached.totalLines) : Math.min(start + CONFIG.defaultPageSize, cached.totalLines);

  const content = cached.lines.slice(start, end).join('\n');

  return {
    content,
    startLine: start + 1,
    endLine: end,
    totalLines: cached.totalLines,
    hasMore: end < cached.totalLines
  };
}

/**
 * Search within cached snapshot
 */
function searchInCache(cacheId, query, maxResults = 10) {
  const cached = getCachedSnapshot(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }

  const results = [];
  const queryLower = query.toLowerCase();

  for (let i = 0; i < cached.lines.length && results.length < maxResults; i++) {
    if (cached.lines[i].toLowerCase().includes(queryLower)) {
      results.push({
        line: i + 1,
        content: cached.lines[i].substring(0, 100) + (cached.lines[i].length > 100 ? '...' : '')
      });
    }
  }

  return {
    query,
    totalMatches: results.length,
    results
  };
}

/**
 * Format pagination message for LLM
 */
function formatPaginationMessage(cacheId, totalLines, url, title, structureHints) {
  const caseId = extractCaseId(url);
  let message = `### Snapshot Too Large - Cached for Navigation

**Page:** ${title}
**URL:** ${url}
**Case ID:** ${caseId}
**Total Lines:** ${totalLines}
**Cache ID:** \`${cacheId}\`
**Search Context:** ${currentSearchContext}
**Saved to:** ~/Downloads/rejust-searches/${currentSearchContext}/${caseId}-part-*.json

The snapshot is ${totalLines} lines which would consume too many tokens.
Use these tools to navigate:

1. **Get specific lines:**
   \`get_cached_snapshot\` with cacheId="${cacheId}", startLine=1, endLine=100

2. **Search in snapshot:**
   \`search_cached_snapshot\` with cacheId="${cacheId}", query="button"

`;

  if (structureHints.length > 0) {
    message += `### Structure Overview (key elements):\n`;
    for (const hint of structureHints) {
      if (hint.ref) {
        message += `- Line ${hint.line}: ${hint.element} [ref=${hint.ref}]\n`;
      } else {
        message += `- Line ${hint.line}: ${hint.element}\n`;
      }
    }
  }

  return message;
}

/**
 * List all searches
 */
function listSearches() {
  try {
    if (!fs.existsSync(CONFIG.baseDir)) return [];

    const searches = fs.readdirSync(CONFIG.baseDir)
      .filter(name => {
        const searchPath = path.join(CONFIG.baseDir, name);
        return fs.statSync(searchPath).isDirectory();
      });

    return searches.map(searchName => {
      const searchDir = path.join(CONFIG.baseDir, searchName);
      const metaFiles = fs.readdirSync(searchDir)
        .filter(f => f.endsWith('-meta.json'));

      return {
        searchContext: searchName,
        caseCount: metaFiles.length,
        path: searchDir
      };
    });
  } catch (error) {
    console.error(`[Cache] Failed to list searches: ${error.message}`);
    return [];
  }
}

/**
 * List all cases in a search context
 */
function listCasesInSearch(searchContext = currentSearchContext) {
  try {
    const searchDir = path.join(CONFIG.baseDir, searchContext);
    if (!fs.existsSync(searchDir)) return [];

    const metaFiles = fs.readdirSync(searchDir)
      .filter(f => f.endsWith('-meta.json'));

    return metaFiles.map(file => {
      const metaPath = path.join(searchDir, file);
      const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return {
        caseId: metadata.caseId,
        url: metadata.url,
        title: metadata.title,
        totalLines: metadata.totalLines,
        numParts: metadata.numParts,
        createdAt: new Date(metadata.createdAt).toISOString()
      };
    });
  } catch (error) {
    console.error(`[Cache] Failed to list cases: ${error.message}`);
    return [];
  }
}

module.exports = {
  CONFIG,
  needsPagination,
  cacheSnapshot,
  getCachedSnapshot,
  getPaginatedContent,
  searchInCache,
  formatPaginationMessage,
  countLines,
  setSearchContext,
  getSearchContext,
  listSearches,
  listCasesInSearch,
  saveCacheToDisk,
  loadCacheFromDisk,
  extractCaseId
};
