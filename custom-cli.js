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
const express = require('express');
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
  .action(async (options) => {
    // Update cache config if provided
    if (options.maxSnapshotLines) {
      const cache = require('./src/snapshot-cache');
      cache.CONFIG.maxLines = parseInt(options.maxSnapshotLines, 10);
    }

    const config = {};
    if (options.browser) config.browser = { browserName: options.browser };
    if (options.headless) config.browser = { ...config.browser, headless: true };
    if (options.vision) config.vision = true;

    const connection = await createCustomConnection(config);

    if (options.port) {
      // SSE transport for multi-agent sharing
      const app = express();
      const port = parseInt(options.port, 10);
      const host = options.host || 'localhost';

      // Store active transports for cleanup
      const transports = new Map();

      app.get('/sse', async (req, res) => {
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = Date.now().toString(36);
        transports.set(sessionId, transport);

        res.on('close', () => {
          transports.delete(sessionId);
        });

        await connection.connect(transport);
      });

      app.post('/messages', express.json(), async (req, res) => {
        // Find the transport that should handle this message
        for (const transport of transports.values()) {
          if (transport.handlePostMessage) {
            await transport.handlePostMessage(req, res);
            return;
          }
        }
        res.status(404).send('No active transport');
      });

      app.listen(port, host, () => {
        console.error(`Playwright Custom MCP SSE server running on http://${host}:${port}/sse`);
      });
    } else {
      // Stdio transport for single client
      const transport = new StdioServerTransport();
      await connection.connect(transport);
    }
  });

program.parse(process.argv);
