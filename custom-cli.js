#!/usr/bin/env node
/**
 * Custom Playwright MCP CLI with snapshot caching, recording, and multi-session support.
 *
 * Architecture:
 *   Stdio mode  — one SharedBrowserCore, one SessionBrowserBackend, one MCP Server
 *   SSE mode    — one SharedBrowserCore, N SessionBrowserBackends (one per SSE client),
 *                 N MCP Servers. All sessions share one browser; tab isolation via registry.
 */

const path = require('path');

const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { program } = require(path.join(playwrightCorePath, 'lib', 'utilsBundle'));
const { resolveCLIConfig } = require(path.join(mcpPath, 'browser', 'config'));
const { contextFactory } = require(path.join(mcpPath, 'browser', 'browserContextFactory'));
const mcpServer = require(path.join(mcpPath, 'sdk', 'server'));
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const http = require('http');
const { SharedBrowserCore, SessionBrowserBackend } = require('./src/custom-backend');

const packageJSON = require('./package.json');

program
  .version('Version ' + packageJSON.version)
  .name('Playwright MCP Custom')
  .option('--browser <browser>', 'Browser or channel: chrome, chromium, firefox, webkit')
  .option('--headless', 'Run in headless mode')
  .option('--port <port>', 'Port for SSE transport')
  .option('--host <host>', 'Host for SSE transport')
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
    const factory = contextFactory(resolvedConfig);
    const sharedCore = new SharedBrowserCore(resolvedConfig, factory);

    if (options.port) {
      const port = parseInt(options.port, 10);
      const host = options.host || 'localhost';
      const sessions = new Map();

      const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${host}`);

        if (req.method === 'GET' && url.pathname === '/sse') {
          const transport = new SSEServerTransport('/messages', res);
          const sessionId = transport.sessionId;

          const backend = new SessionBrowserBackend(sessionId, sharedCore);
          const connection = mcpServer.createServer(
            'Playwright-Custom',
            packageJSON.version,
            backend,
            false
          );

          sessions.set(sessionId, { transport, connection, backend });
          console.error(`[MCP] SSE client connected: ${sessionId} (total: ${sessions.size})`);

          res.on('close', () => {
            const session = sessions.get(sessionId);
            if (session) {
              session.backend.serverClosed();
              sessions.delete(sessionId);
            }
            console.error(`[MCP] SSE client disconnected: ${sessionId} (total: ${sessions.size})`);
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

      const shutdown = () => {
        for (const [id, session] of sessions) {
          session.backend.serverClosed();
        }
        sessions.clear();
        sharedCore.dispose();
        httpServer.close();
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      httpServer.listen(port, host, () => {
        console.error(`[MCP] SSE server listening on http://${host}:${port}/sse`);
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
