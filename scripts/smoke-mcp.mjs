#!/usr/bin/env node
/**
 * End-to-end smoke test for the latoile MCP server over real stdio.
 *
 * Usage:
 *   yarn build:server
 *   node scripts/smoke-mcp.mjs                        # handshake + tools/list
 *   node scripts/smoke-mcp.mjs get_context '{"jiraKey":"PV2-17892","maxAgeSeconds":86400}'
 *
 * Requires the same environment as the server (.env / LATOILE_* vars).
 * Exits 0 when every step succeeded, 1 otherwise — safe for CI.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/src/mcp/server.js');
const TIMEOUT_MS = 120_000;

const [toolName, toolArgsJson] = process.argv.slice(2);

function request(id, method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
const responses = new Map();
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  }
});

function waitFor(id) {
  const deadline = Date.now() + TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(poll);
        resolve(responses.get(id));
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for response id=${id}`));
      }
    }, 25);
  });
}

function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}`);
  child.kill();
  process.exit(1);
}

child.stdin.write(
  request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'latoile-smoke', version: '0' },
  })
);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const init = await waitFor(1).catch((err) => fail('initialize', err.message));
if (init.error) fail('initialize', JSON.stringify(init.error));
console.log(`OK initialize (${init.result.serverInfo.name} ${init.result.serverInfo.version})`);

child.stdin.write(request(2, 'tools/list', {}));
const list = await waitFor(2).catch((err) => fail('tools/list', err.message));
if (list.error) fail('tools/list', JSON.stringify(list.error));
const tools = list.result.tools.map((t) => t.name);
console.log(`OK tools/list (${tools.length} tools: ${tools.join(', ')})`);

if (toolName) {
  const args = toolArgsJson ? JSON.parse(toolArgsJson) : {};
  child.stdin.write(request(3, 'tools/call', { name: toolName, arguments: args, _meta: { progressToken: 'smoke' } }));
  const call = await waitFor(3).catch((err) => fail(`tools/call ${toolName}`, err.message));
  if (call.error) fail(`tools/call ${toolName}`, JSON.stringify(call.error));
  if (call.result.isError) fail(`tools/call ${toolName}`, call.result.content?.[0]?.text ?? 'tool returned isError');
  const structured = call.result.structuredContent;
  console.log(`OK tools/call ${toolName}:`, JSON.stringify(structured).slice(0, 400));
}

// Closing stdin must terminate the server (drain + driver close); if it
// doesn't, the timeout below catches the regression.
child.stdin.end();
const exitTimer = setTimeout(() => fail('shutdown', 'server did not exit within 15s of stdin EOF'), 15_000);
child.on('exit', () => {
  clearTimeout(exitTimer);
  console.log('OK shutdown (server exited on stdin EOF)');
  process.exit(0);
});
