/**
 * Custom Browser Server Backend
 *
 * Architecture for multi-session SSE support:
 *
 *   SharedBrowserCore  (one per server process)
 *     - Owns the single Context + browser lifecycle
 *     - Holds tools that are session-independent (tab-aware wrappers, cache, recording)
 *     - Lazy-initializes browser on first tool call from any session
 *
 *   SessionBrowserBackend  (one per SSE / stdio session)
 *     - Implements MCP backend interface (listTools, callTool, serverClosed)
 *     - Combines shared tools with session-scoped tools (browser_tabs, browser_close)
 *     - On disconnect, cleans up only this session's tabs
 *
 * @module custom-backend
 */

const path = require('path');

const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { z } = require('playwright-core/lib/mcpBundle');

const { Context } = require(path.join(mcpPath, 'browser', 'context'));
const { logUnhandledError } = require(path.join(mcpPath, 'log'));
const { SessionLog } = require(path.join(mcpPath, 'browser', 'sessionLog'));
const { toMcpTool } = require(path.join(mcpPath, 'sdk', 'tool'));
const { Response: OriginalResponse } = require(path.join(mcpPath, 'browser', 'response'));

const snapshotCache = require('./snapshot-cache-enhanced');
const recordingManager = require('./recording-manager');
const { createRecordingTools } = require('./recording-tools');
const outputCache = require('./output-cache');
const { createTabAwareTools, createEnhancedTabsTool, createSessionCloseTool, cleanupSession } = require('./tab-isolation');

class PatchedResponse extends OriginalResponse {
  serialize(options = {}) {
    const result = super.serialize(options);

    if (result.content?.[0]?.type === 'text') {
      let text = result.content[0].text;

      const yamlMatch = text.match(/```yaml\n([\s\S]*?)\n```/);
      if (yamlMatch?.[1] && snapshotCache.needsPagination(yamlMatch[1])) {
        const snapshotContent = yamlMatch[1];
        const urlMatch = text.match(/- Page URL: (.+)/);
        const titleMatch = text.match(/- Page Title: (.+)/);
        const url = urlMatch?.[1] || 'unknown';
        const title = titleMatch?.[1] || 'unknown';

        const { cacheId, totalLines, structureHints } = snapshotCache.cacheSnapshot(
          snapshotContent, url, title
        );

        const paginationMsg = snapshotCache.formatPaginationMessage(
          cacheId, totalLines, url, title, structureHints
        );

        text = text.replace(
          /- Page Snapshot:\n```yaml\n[\s\S]*?\n```/,
          paginationMsg
        );
        result.content[0].text = text;
        return result;
      }

      if (outputCache.needsCaching(text)) {
        const toolName = this._name || 'unknown';
        const { cacheId, totalLines, preview } = outputCache.cacheOutput(text, toolName);
        result.content[0].text = outputCache.formatCacheMessage(cacheId, totalLines, toolName, preview);
      }
    }

    return result;
  }
}

// Cache navigation tools — stateless, shared across sessions
const getCachedSnapshotTool = {
  schema: {
    name: 'get_cached_snapshot',
    title: 'Get cached snapshot',
    description: 'Get specific lines from a cached page snapshot. Use when snapshot was too large.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from browser_snapshot'),
      startLine: z.number().optional().describe('Starting line (1-indexed)'),
      endLine: z.number().optional().describe('Ending line (inclusive)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = snapshotCache.getPaginatedContent(params.cacheId, params.startLine || 1, params.endLine);
    if (result.error) { response.addError(result.error); return; }
    let text = `Lines ${result.startLine}-${result.endLine} of ${result.totalLines}:\n`;
    text += '```yaml\n' + result.content + '\n```';
    if (result.hasMore) text += `\n\n_More available. Next: startLine=${result.endLine + 1}_`;
    response.addResult(text);
  }
};

const searchCachedSnapshotTool = {
  schema: {
    name: 'search_cached_snapshot',
    title: 'Search cached snapshot',
    description: 'Search for text within a cached page snapshot.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from browser_snapshot'),
      query: z.string().describe('Text to search for'),
      maxResults: z.number().optional().describe('Max results (default: 10)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = snapshotCache.searchInCache(params.cacheId, params.query, params.maxResults || 10);
    if (result.error) { response.addError(result.error); return; }
    let text = `Search "${result.query}" - ${result.totalMatches} matches:\n\n`;
    for (const match of result.results) text += `Line ${match.line}: ${match.content}\n`;
    response.addResult(text);
  }
};

const getCachedOutputTool = {
  schema: {
    name: 'get_cached_output',
    title: 'Get cached output',
    description: 'Get specific lines from any cached large output.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from large output'),
      startLine: z.number().optional().describe('Starting line (1-indexed)'),
      endLine: z.number().optional().describe('Ending line (inclusive)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = outputCache.getPaginatedContent(params.cacheId, params.startLine || 1, params.endLine);
    if (result.error) { response.addError(result.error); return; }
    let text = `## Output (${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`;
    text += '```\n' + result.content + '\n```';
    if (result.hasMore) text += `\n\n_More available. Next: startLine=${result.endLine + 1}_`;
    response.addResult(text);
  }
};

const searchCachedOutputTool = {
  schema: {
    name: 'search_cached_output',
    title: 'Search cached output',
    description: 'Search for text within any cached large output.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from large output'),
      query: z.string().describe('Text to search for'),
      maxResults: z.number().optional().describe('Max results (default: 20)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = outputCache.searchInCache(params.cacheId, params.query, params.maxResults || 20);
    if (result.error) { response.addError(result.error); return; }
    let text = `## Search "${result.query}" - ${result.totalMatches} matches\n\n`;
    for (const match of result.results) text += `**L${match.line}:** ${match.content}\n`;
    response.addResult(text);
  }
};


/**
 * Shared browser infrastructure — one per server process.
 * Manages the single Context/browser and holds session-independent tools.
 */
class SharedBrowserCore {
  constructor(config, factory) {
    this._config = config;
    this._browserContextFactory = factory;
    this._context = null;
    this._initPromise = null;
    this._sessionCount = 0;

    const recordingTools = createRecordingTools();
    const tabAwareTools = createTabAwareTools(config);

    this._sharedTools = [
      ...tabAwareTools,
      getCachedSnapshotTool,
      searchCachedSnapshotTool,
      getCachedOutputTool,
      searchCachedOutputTool,
      ...recordingTools
    ];
  }

  async initialize(clientInfo) {
    if (!this._initPromise) {
      this._initPromise = this._doInitialize(clientInfo);
      this._initPromise.catch(() => { this._initPromise = null; });
    }
    return this._initPromise;
  }

  async _doInitialize(clientInfo) {
    this._sessionLog = this._config.saveSession
      ? await SessionLog.create(this._config, clientInfo)
      : undefined;
    this._context = new Context({
      config: this._config,
      browserContextFactory: this._browserContextFactory,
      sessionLog: this._sessionLog,
      clientInfo
    });

    // Prevent browser auto-close when last tab closes.
    // Context._onPageClosed calls closeBrowserContext() when _tabs empties —
    // in multi-session mode that would kill the browser under active sessions.
    // Browser only shuts down on server process exit via dispose().
    this._originalCloseBrowserContext = this._context.closeBrowserContext.bind(this._context);
    this._context.closeBrowserContext = async () => {};

    // Recover from browser disconnect (e.g. Chrome restarts while daemon is running).
    // The factory already clears its _browserPromise on disconnect, but the Context
    // still holds _browserContextPromise pointing at the dead browser context.
    // The no-op closeBrowserContext prevents normal cleanup from clearing it.
    // Clear it here so the next tool call re-enters _ensureBrowserContext and reconnects.
    this._hookBrowserDisconnect();
  }

  _hookBrowserDisconnect() {
    // Wrap _ensureBrowserContext to attach a disconnect handler after the first
    // successful browser creation. Preserves lazy init — browser is NOT launched here.
    const origEnsure = this._context._ensureBrowserContext.bind(this._context);
    const self = this;
    this._context._ensureBrowserContext = function () {
      const promise = origEnsure();
      promise.then(({ browserContext }) => {
        const browser = browserContext.browser();
        if (browser && !browser._mcpDisconnectHooked) {
          browser._mcpDisconnectHooked = true;
          browser.on('disconnected', () => {
            self._context._browserContextPromise = undefined;
            self._context._browserContext = undefined;
          });
        }
      }).catch(() => {});
      return promise;
    };
  }

  get context() { return this._context; }
  get sharedTools() { return this._sharedTools; }

  addSession() { this._sessionCount++; }

  removeSession() {
    this._sessionCount--;
    if (this._sessionCount <= 0) {
      this._sessionCount = 0;
      // Browser stays alive — Context._onPageClosed handles cleanup
      // when the last tab closes. No need to force-dispose here;
      // the browser re-launches lazily on next use if needed.
    }
  }

  dispose() {
    recordingManager.cleanupAll();
    if (this._context) {
      // Restore real closeBrowserContext so dispose() actually shuts down Chrome
      if (this._originalCloseBrowserContext) {
        this._context.closeBrowserContext = this._originalCloseBrowserContext;
      }
      this._context.dispose().catch(logUnhandledError);
    }
    this._context = null;
    this._initPromise = null;
  }
}


/**
 * Per-session backend implementing the MCP backend interface.
 * Delegates to SharedBrowserCore for browser operations.
 * Owns session-scoped tools (browser_tabs, browser_close).
 */
class SessionBrowserBackend {
  constructor(sessionId, sharedCore) {
    this._sessionId = sessionId;
    this._core = sharedCore;
    this._core.addSession();

    this._sessionTools = [
      createEnhancedTabsTool(sessionId),
      createSessionCloseTool(sessionId)
    ];

    this._allTools = [...this._core.sharedTools, ...this._sessionTools];
  }

  async initialize(clientInfo) {
    await this._core.initialize(clientInfo);
  }

  async listTools() {
    return this._allTools.map(tool => toMcpTool(tool.schema));
  }

  async callTool(name, rawArguments) {
    const tool = this._allTools.find(t => t.schema.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);

    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {});
    const context = this._core.context;
    const response = new PatchedResponse(context, name, parsedArguments);

    response.logBegin();
    context.setRunningTool(name);

    try {
      await tool.handle(context, parsedArguments, response);
      await response.finish();
      this._core._sessionLog?.logResponse(response);
    } catch (error) {
      response.addError(String(error));
    } finally {
      context.setRunningTool(undefined);
    }

    response.logEnd();
    return response.serialize();
  }

  serverClosed() {
    if (this._closed) return;
    this._closed = true;

    const context = this._core.context;
    if (context) {
      cleanupSession(this._sessionId, context);
    }
    this._core.removeSession();
  }
}


module.exports = { SharedBrowserCore, SessionBrowserBackend, PatchedResponse };
