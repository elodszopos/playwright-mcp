/**
 * Tab Isolation Module
 *
 * Provides tab-aware tool wrappers that allow multi-session browser access.
 * Each session owns its tabs via a session-tagged global registry.
 * Tab IDs are globally unique 6-char strings; session ownership is tracked
 * so list/cleanup operations scope to the owning session.
 *
 * @module tab-isolation
 */

const path = require('path');
const { z } = require('playwright-core/lib/mcpBundle');

const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');
const { filteredTools } = require(path.join(mcpPath, 'browser', 'tools'));

// Global registry: tabId -> { page, tab, createdAt, title, sessionId }
const tabRegistry = new Map();

function generateTabId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (tabRegistry.has(id)) return generateTabId();
  return id;
}

const BACKGROUND_TAB_ATTACH_TIMEOUT_MS = 5000;
const BACKGROUND_TAB_POLL_INTERVAL_MS = 50;
const BACKGROUND_TAB_MAX_ATTEMPTS = 3;

/**
 * Create a tab via CDP Target.createTarget with background:true.
 * context.newPage() always steals focus; this does not.
 * Snapshot-then-diff: records context.tabs() before creation, polls for the new one after.
 * Falls back to context.newTab() if CDP is unavailable (non-Chromium browsers).
 */
async function createBackgroundTab(context) {
  const { browserContext } = await context._ensureBrowserContext();
  const browser = browserContext.browser?.();

  if (!browser || typeof browser.newBrowserCDPSession !== 'function') {
    const tab = await context.newTab();
    return { tab, page: tab.page || tab };
  }

  for (let attempt = 1; attempt <= BACKGROUND_TAB_MAX_ATTEMPTS; attempt++) {
    const tabsBefore = new Set(context.tabs());

    const cdpSession = await browser.newBrowserCDPSession();
    await cdpSession.send('Target.createTarget', { url: 'about:blank', background: true });
    await cdpSession.detach();

    const deadline = Date.now() + BACKGROUND_TAB_ATTACH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const newTab = context.tabs().find(t => !tabsBefore.has(t));
      if (newTab) {
        return { tab: newTab, page: newTab.page || newTab };
      }
      await new Promise(r => setTimeout(r, BACKGROUND_TAB_POLL_INTERVAL_MS));
    }
  }

  // Final fallback — better to steal focus than fail
  const tab = await context.newTab();
  return { tab, page: tab.page || tab };
}

const tabIdSchema = z.string().length(6).describe(
  'Tab ID (6-char string) to operate on. REQUIRED. Get this from browser_tabs(action="new").'
);

function getTabByStringId(context, tabId) {
  const entry = tabRegistry.get(tabId);
  if (!entry) {
    throw new Error(`Tab "${tabId}" not found. It may have been closed or never existed. Use browser_tabs(action="new") to create a new tab.`);
  }

  const page = entry.page;
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      tabRegistry.delete(tabId);
      throw new Error(`Tab "${tabId}" was closed. Use browser_tabs(action="new") to create a new tab.`);
    }
    page.url();
  } catch (e) {
    if (e.message && e.message.includes('was closed')) throw e;
    tabRegistry.delete(tabId);
    throw new Error(`Tab "${tabId}" is no longer valid (browser may have been closed). Use browser_tabs(action="new") to create a new tab.`);
  }

  return entry.tab || entry.page;
}

function createTabProxyContext(context, tabId) {
  if (!tabId || typeof tabId !== 'string') {
    throw new Error('tabId is required. First call browser_tabs(action="new") to get your tab ID.');
  }

  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'currentTab') return () => getTabByStringId(target, tabId);
      if (prop === 'currentTabOrDie') return () => getTabByStringId(target, tabId);
      if (prop === 'ensureTab') return async () => getTabByStringId(target, tabId);

      const value = target[prop];
      if (typeof value === 'function') return value.bind(target);
      return value;
    }
  });
}

function wrapToolWithTabId(tool) {
  const originalSchema = tool.schema;
  const originalHandle = tool.handle;

  return {
    ...tool,
    schema: {
      ...originalSchema,
      inputSchema: originalSchema.inputSchema.extend({ tabId: tabIdSchema })
    },
    handle: async (context, params, response) => {
      const { tabId, ...restParams } = params;

      if (!tabId || typeof tabId !== 'string' || tabId.length !== 6) {
        throw new Error(
          'tabId (6-char string) is REQUIRED. First call browser_tabs(action="new") to create a tab and get your tabId.'
        );
      }

      const proxyContext = createTabProxyContext(context, tabId);
      response._context = proxyContext;
      return await originalHandle(proxyContext, restParams, response);
    }
  };
}

const TAB_AWARE_TOOLS = new Set([
  'browser_snapshot',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_generate_locator',
  'browser_navigate',
  'browser_navigate_back',
  'browser_press_key',
  'browser_type',
  'browser_fill_form',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_evaluate',
  'browser_console_messages',
  'browser_network_requests',
  'browser_handle_dialog',
  'browser_file_upload',
  'browser_run_code',
  'browser_mouse_move_xy',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
  'browser_resize'
]);

function createTabAwareTools(config) {
  const originalTools = filteredTools(config);

  return originalTools.map(tool => {
    if (tool.schema.name === 'browser_tabs') return null;
    if (tool.schema.name === 'browser_close') return null;
    if (TAB_AWARE_TOOLS.has(tool.schema.name)) return wrapToolWithTabId(tool);
    return tool;
  }).filter(Boolean);
}

/**
 * Session-scoped browser_tabs tool.
 * Each session gets its own instance with sessionId baked in via closure.
 */
function createEnhancedTabsTool(sessionId) {
  return {
    schema: {
      name: 'browser_tabs',
      title: 'Manage tabs',
      description: 'Create, close, or list browser tabs. Use action="new" to create a tab and get your tabId (6-char string). Use action="close" with your tabId to close it. Use action="list" to see all tabs with their IDs and titles.',
      inputSchema: z.object({
        action: z.enum(['new', 'close', 'list']).describe('Operation: "new" to create tab, "close" to close tab, "list" to see all tabs'),
        tabId: z.string().length(6).optional().describe('Tab ID (6-char string) to close (required for close action)')
      }),
      type: 'action'
    },
    capability: 'core-tabs',
    handle: async (context, params, response) => {
      switch (params.action) {
        case 'new': {
          const { tab, page } = await createBackgroundTab(context);
          const tabId = generateTabId();

          tabRegistry.set(tabId, {
            page,
            tab,
            createdAt: new Date(),
            title: 'New Tab',
            sessionId
          });

          const pageRef = page;
          const thisTabId = tabId;
          if (typeof page.on === 'function') {
            page.on('close', () => {
              const currentEntry = tabRegistry.get(thisTabId);
              if (currentEntry && currentEntry.page === pageRef) {
                tabRegistry.delete(thisTabId);
              }
            });
          }

          page.on('load', async () => {
            const entry = tabRegistry.get(tabId);
            if (entry) {
              try {
                entry.title = await page.title() || 'Untitled';
              } catch (e) { /* page might be closed */ }
            }
          });

          response.addResult(
            `## Tab Created\n\n` +
            `**Your tabId: \`${tabId}\`**\n\n` +
            `Use this tabId with ALL browser tools:\n` +
            `- \`browser_navigate(tabId="${tabId}", url="...")\`\n` +
            `- \`browser_snapshot(tabId="${tabId}")\`\n` +
            `- \`browser_click(tabId="${tabId}", ref="...", element="...")\`\n` +
            `- \`browser_tabs(action="close", tabId="${tabId}")\` when done\n\n` +
            `tabId is REQUIRED for all browser operations.`
          );
          return;
        }

        case 'close': {
          if (!params.tabId || params.tabId.length !== 6) {
            throw new Error('tabId (6-char string) is required for close action.');
          }

          const entry = tabRegistry.get(params.tabId);
          if (!entry) {
            throw new Error(`Tab "${params.tabId}" not found. It may have already been closed.`);
          }

          const tabs = context.tabs();
          const tabIndex = tabs.findIndex(t => t === entry.tab || t === entry.page || t.page === entry.page);

          if (tabIndex === -1) {
            tabRegistry.delete(params.tabId);
            throw new Error(`Tab "${params.tabId}" was already closed.`);
          }

          await context.closeTab(tabIndex);
          tabRegistry.delete(params.tabId);

          response.addResult(`Tab \`${params.tabId}\` closed.`);
          return;
        }

        case 'list': {
          const tabs = context.tabs();
          const tabList = [];

          for (const [id, entry] of tabRegistry.entries()) {
            if (entry.sessionId !== sessionId) continue;

            const tabIndex = tabs.findIndex(t => t === entry.tab || t === entry.page || t.page === entry.page);
            if (tabIndex === -1) {
              tabRegistry.delete(id);
              continue;
            }

            const tab = tabs[tabIndex];
            let title = 'Untitled';
            let url = 'about:blank';

            try {
              if (tab.page) {
                url = tab.page.url() || 'about:blank';
                title = await tab.page.title() || tab.lastTitle?.() || 'Untitled';
              } else if (typeof tab.lastTitle === 'function') {
                title = tab.lastTitle();
              }
            } catch (e) { /* keep defaults */ }

            tabList.push({ id, title, url, createdAt: entry.createdAt.toISOString() });
          }

          if (tabList.length === 0) {
            response.addResult(
              `## No Tabs\n\n` +
              `No tabs are currently open for this session.\n` +
              `Use \`browser_tabs(action="new")\` to create one.`
            );
            return;
          }

          let result = `## Open Tabs (${tabList.length})\n\n`;
          result += `| ID | Title | URL |\n`;
          result += `|----|-------|-----|\n`;

          for (const tab of tabList) {
            const shortUrl = tab.url.length > 50 ? tab.url.substring(0, 47) + '...' : tab.url;
            const shortTitle = tab.title.length > 30 ? tab.title.substring(0, 27) + '...' : tab.title;
            result += `| \`${tab.id}\` | ${shortTitle} | ${shortUrl} |\n`;
          }

          response.addResult(result);
          return;
        }

        default:
          throw new Error(`Unknown action: ${params.action}. Use "new", "close", or "list".`);
      }
    }
  };
}

/**
 * Session-scoped browser_close tool.
 * Closes only the calling session's tabs instead of killing the browser.
 */
function createSessionCloseTool(sessionId) {
  return {
    schema: {
      name: 'browser_close',
      title: 'Close session tabs',
      description: 'Close all tabs owned by this session. The browser stays running for other sessions.',
      inputSchema: z.object({}),
      type: 'action'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const closed = cleanupSession(sessionId, context);
      response.addResult(`Closed ${closed} tab(s) for this session.`);
    }
  };
}

/**
 * Close all tabs belonging to a session.
 * Closes pages directly to avoid index-shifting bugs.
 * Returns the number of tabs closed.
 */
function cleanupSession(sessionId, context) {
  let closed = 0;
  const toClose = [];

  for (const [tabId, entry] of tabRegistry.entries()) {
    if (entry.sessionId !== sessionId) continue;
    toClose.push({ tabId, page: entry.page });
  }

  for (const { tabId, page } of toClose) {
    tabRegistry.delete(tabId);
    try {
      if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
        page.close().catch(() => {});
      }
    } catch (e) { /* best effort */ }
    closed++;
  }

  return closed;
}

function getTabRegistry() {
  return tabRegistry;
}

module.exports = {
  tabIdSchema,
  generateTabId,
  getTabByStringId,
  createTabProxyContext,
  wrapToolWithTabId,
  createTabAwareTools,
  createEnhancedTabsTool,
  createSessionCloseTool,
  cleanupSession,
  getTabRegistry,
  TAB_AWARE_TOOLS
};
