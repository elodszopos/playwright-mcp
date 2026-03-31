#!/usr/bin/env node
/**
 * Custom Playwright MCP CLI with snapshot caching and recording
 */

const path = require('path');

// Direct paths to playwright internals
const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { program } = require(path.join(playwrightCorePath, 'lib', 'utilsBundle'));
const { resolveConfig } = require(path.join(mcpPath, 'browser', 'config'));
const { contextFactory } = require(path.join(mcpPath, 'browser', 'browserContextFactory'));
const mcpServer = require(path.join(mcpPath, 'sdk', 'server'));
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const http = require('http');
const { CustomBrowserServerBackend } = require('./src/custom-backend');

const packageJSON = require('./package.json');

async function createCustomConnection(userConfig = {}) {
  const config = await resolveConfig(userConfig);
  const factory = contextFactory(config);
  return mcpServer.createServer(
    'Playwright-Custom',
    packageJSON.version,
    new CustomBrowserServerBackend(config, factory),
    false
  );
}

// CLI setup
program
  .version('Version ' + packageJSON.version)
  .name('Playwright MCP Custom')
  .option('--browser <browser>', 'Browser type: chromium, firefox, webkit', 'chromium')
  .option('--headless', 'Run in headless mode')
  .option('--port <port>', 'Port for SSE transport')
  .option('--host <host>', 'Host for SSE transport')
  .option('--vision', 'Enable vision mode (screenshots instead of snapshots)')
  .option('--config <path>', 'Path to config file')
  .option('--max-snapshot-lines <lines>', 'Max lines before caching (default: 300)', '300')
  .option('--search-context <name>', 'Search context folder name for organized cache storage')
  .action(async (options) => {
    // Use enhanced cache with disk persistence
    const cache = require('./src/snapshot-cache-enhanced');

    // Update cache config if provided
    if (options.maxSnapshotLines) {
      cache.CONFIG.maxLines = parseInt(options.maxSnapshotLines, 10);
    }

    // Set search context if provided
    if (options.searchContext) {
      cache.setSearchContext(options.searchContext);
      console.error(`[MCP] Search context: ${cache.getSearchContext()}`);
      console.error(`[MCP] Cache location: ~/Downloads/rejust-searches/${cache.getSearchContext()}/`);
    }

    const config = {};
    if (options.browser) config.browser = { browserName: options.browser };
    if (options.headless) config.browser = { ...config.browser, headless: true };
    if (options.vision) config.vision = true;

    if (options.port) {
      // SSE transport — one MCP Server per SSE client.
      // Each client gets its own Server + Backend + Context to avoid lifecycle
      // conflicts (old client disconnect would dispose the current client's browser).
      const port = parseInt(options.port, 10);
      const host = options.host || 'localhost';
      const sessions = new Map();

      const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${host}`);

        if (req.method === 'GET' && url.pathname === '/sse') {
          const connection = await createCustomConnection(config);
          const transport = new SSEServerTransport('/messages', res);
          sessions.set(transport.sessionId, { transport, connection });
          console.error(`[MCP] SSE client connected: ${transport.sessionId} (total: ${sessions.size})`);
          res.on('close', () => {
            sessions.delete(transport.sessionId);
            console.error(`[MCP] SSE client disconnected: ${transport.sessionId} (total: ${sessions.size})`);
          });
          await connection.connect(transport);
        } else if (req.method === 'POST' && url.pathname === '/messages') {
          const sessionId = url.searchParams.get('sessionId');
          const session = sessions.get(sessionId);

          if (session) {
            await session.transport.handlePostMessage(req, res);
          } else {
            res.writeHead(404).end('Unknown session');
          }
        } else {
          res.writeHead(404).end();
        }
      });

      httpServer.listen(port, host, () => {
        console.error(`[MCP] SSE server listening on http://${host}:${port}/sse`);
        console.error(`[MCP] Each session gets its own browser context`);
      });
    } else {
      // Stdio transport — single session (default)
      const connection = await createCustomConnection(config);
      const transport = new StdioServerTransport();
      await connection.connect(transport);
    }
  });

program.parse(process.argv);
