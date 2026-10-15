#!/usr/bin/env node
// HTTP mode (streamable HTTP at /mcp): one SessionBrowserBackend and MCP server per client session,
// all sharing one browser with tabs isolated per session. Stdio mode: a single session.

const path = require('path');
const os = require('os');

const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { program } = require(path.join(playwrightCorePath, 'lib', 'utilsBundle'));
const { resolveCLIConfig } = require(path.join(mcpPath, 'browser', 'config'));
const { contextFactory } = require(path.join(mcpPath, 'browser', 'browserContextFactory'));
const mcpServer = require(path.join(mcpPath, 'sdk', 'server'));
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { randomUUID } = require('crypto');
const http = require('http');
const { SharedBrowserCore, SessionBrowserBackend } = require('./src/custom-backend');

const packageJSON = require('./package.json');

program
  .version('Version ' + packageJSON.version)
  .name('Playwright MCP Custom')
  .option('--browser <browser>', 'Browser or channel: chrome, chromium, firefox, webkit')
  .option('--headless', 'Run in headless mode')
  .option('--port <port>', 'Port for streamable HTTP at /mcp')
  .option('--host <host>', 'Host for streamable HTTP')
  .option('--vision', 'Enable vision mode (screenshots instead of snapshots)')
  .option('--config <path>', 'Path to config file')
  .option('--max-snapshot-lines <lines>', 'Max lines before caching (default: 300)', '300')
  .option('--search-context <name>', 'Search context folder name for organized cache storage')
  .action(async (options) => {
    const cache = require('./src/snapshot-cache-enhanced');

    if (options.maxSnapshotLines) {
      cache.CONFIG.maxLines = parseInt(options.maxSnapshotLines, 10);
    }

    if (options.searchContext) {
      cache.setSearchContext(options.searchContext);
      console.error(`[MCP] Search context: ${cache.getSearchContext()}`);
      console.error(`[MCP] Cache location: ~/Downloads/rejust-searches/${cache.getSearchContext()}/`);
    }

    const resolvedConfig = await resolveCLIConfig(options);

    // Pin one persistent profile dir so every launch reuses the same browser
    // profile (consistent logins/cookies). Honors PLAYWRIGHT_MCP_USER_DATA_DIR,
    // else a fixed fallback -- never the lib's volatile default.
    resolvedConfig.browser = resolvedConfig.browser ?? {};
    resolvedConfig.browser.userDataDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR
      || path.join(os.homedir(), '.playwright-mcp-profile');

    const factory = contextFactory(resolvedConfig);
    const sharedCore = new SharedBrowserCore(resolvedConfig, factory);

    if (options.port) {
      const port = parseInt(options.port, 10);
      const host = options.host || 'localhost';
      const sessions = new Map();

      const openSession = (id, transport) => {
        const backend = new SessionBrowserBackend(id, sharedCore);
        const connection = mcpServer.createServer('Playwright-Custom', packageJSON.version, backend, false);
        sessions.set(id, { transport, connection, backend });
        console.error(`[MCP] client connected: ${id} (total: ${sessions.size})`);
        return connection;
      };

      const closeSession = (id) => {
        const session = sessions.get(id);
        if (session) {
          session.backend.serverClosed();
          sessions.delete(id);
          console.error(`[MCP] client disconnected: ${id} (total: ${sessions.size})`);
        }
      };

      const handleStreamable = async (req, res) => {
        const requested = req.headers['mcp-session-id'];
        if (requested) {
          const session = sessions.get(requested);
          if (!session) {
            res.writeHead(404).end('Unknown session');
            return;
          }
          await session.transport.handleRequest(req, res);
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(400).end('Missing mcp-session-id');
          return;
        }
        const id = randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
        transport.onclose = () => closeSession(id);
        await openSession(id, transport).connect(transport);
        await transport.handleRequest(req, res);
        if (!transport.sessionId) {
          await transport.close();
        }
      };

      const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${host}`);

        if (url.pathname === '/mcp') {
          await handleStreamable(req, res);
        } else {
          res.writeHead(404).end();
        }
      });

      const shutdown = () => {
        for (const session of sessions.values()) {
          session.backend.serverClosed();
        }
        sessions.clear();
        sharedCore.dispose();
        httpServer.close();
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      httpServer.listen(port, host, () => {
        console.error(`[MCP] listening on http://${host}:${port}/mcp (streamable HTTP)`);
        console.error(`[MCP] Multi-session mode: all clients share one browser, tabs isolated per session`);
      });

    } else {
      const backend = new SessionBrowserBackend('stdio', sharedCore);
      const connection = mcpServer.createServer(
        'Playwright-Custom',
        packageJSON.version,
        backend,
        false
      );
      const transport = new StdioServerTransport();
      await connection.connect(transport);
    }
  });

program.parse(process.argv);
