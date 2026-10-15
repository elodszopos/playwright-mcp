#!/usr/bin/env node
// HTTP mode: stateless streamable HTTP at /mcp, a fresh MCP server per POST over one shared BrowserBackend.

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
const http = require('http');
const { BrowserBackend } = require('./src/custom-backend');

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
    const backend = new BrowserBackend(resolvedConfig, factory);
    const createServer = () => mcpServer.createServer('Playwright-Custom', packageJSON.version, backend, false);

    if (options.port) {
      const port = parseInt(options.port, 10);
      const host = options.host || 'localhost';

      const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${host}`);
        if (url.pathname !== '/mcp') {
          res.writeHead(404).end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' }).end();
          return;
        }
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      });

      const shutdown = () => {
        backend.dispose();
        httpServer.close();
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      httpServer.listen(port, host, () => {
        console.error(`[MCP] listening on http://${host}:${port}/mcp (stateless streamable HTTP, one shared browser)`);
      });

    } else {
      await createServer().connect(new StdioServerTransport());
    }
  });

program.parse(process.argv);
