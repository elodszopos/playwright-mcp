// One BrowserBackend per process: one browser shared by every client, each tab addressed by its tabId.

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
const { createTabAwareTools, createTabsTool } = require('./tab-isolation');

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


class BrowserBackend {
  constructor(config, factory) {
    this._config = config;
    this._browserContextFactory = factory;
    this._context = null;
    this._initPromise = null;

    this._tools = [
      ...createTabAwareTools(config),
      createTabsTool(),
      getCachedSnapshotTool,
      searchCachedSnapshotTool,
      getCachedOutputTool,
      searchCachedOutputTool,
      ...createRecordingTools()
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
    // that would kill the browser under other clients' tabs.
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

  async listTools() {
    return this._tools.map(tool => toMcpTool(tool.schema));
  }

  async callTool(name, rawArguments) {
    const tool = this._tools.find(t => t.schema.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);

    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {});
    const context = this._context;
    const response = new PatchedResponse(context, name, parsedArguments);

    response.logBegin();
    context.setRunningTool(name);

    try {
      await tool.handle(context, parsedArguments, response);
      await response.finish();
      this._sessionLog?.logResponse(response);
    } catch (error) {
      response.addError(String(error));
    } finally {
      context.setRunningTool(undefined);
    }

    response.logEnd();
    return response.serialize();
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


module.exports = { BrowserBackend, PatchedResponse };
