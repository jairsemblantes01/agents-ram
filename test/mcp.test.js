// Levanta bin/mcp.js con una base temporal y habla MCP con él por stdio.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const SERVER = path.join(__dirname, '..', 'bin', 'mcp.js');
const PROJECT = path.join(os.homedir(), 'proj', 'mcp-test');

function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      CLAUDE_RAM_DB_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ram-mcp-')),
      OLLAMA_URL: 'http://127.0.0.1:9', // sin Ollama: solo búsqueda por palabras
      ...env,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  return { child, request, notify, call };
}

test('mcp: initialize, tools/list, guardar y encontrar una nota con su cliente de origen', async () => {
  const s = startServer();
  try {
    const init = await s.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '1' },
    });
    assert.strictEqual(init.result.serverInfo.name, 'claude-ram');
    s.notify('notifications/initialized');

    const { result } = await s.request('tools/list', {});
    assert.deepStrictEqual(result.tools.map((t) => t.name).sort(), ['memory_recent', 'memory_save', 'memory_search']);

    const saved = await s.call('memory_save', { text: 'Decidimos usar Postgres con migraciones de Prisma', project: PROJECT });
    assert.match(saved.content[0].text, /Guardado/);

    const found = await s.call('memory_search', { query: 'postgres prisma', project: PROJECT });
    assert.match(found.content[0].text, /\(note, codex\).*Postgres/);

    const recent = await s.call('memory_recent', { project: PROJECT });
    assert.match(recent.content[0].text, /Prisma/);

    const elsewhere = await s.call('memory_search', { query: 'postgres prisma', project: path.join(os.homedir(), 'otro') });
    assert.match(elsewhere.content[0].text, /Sin resultados/);
  } finally {
    s.child.kill();
  }
});

test('mcp: errores de herramienta vuelven como isError y los secretos no se guardan', async () => {
  const s = startServer({ CLAUDE_RAM_SOURCE: 'cursor' });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x' } });
    const bad = await s.call('memory_search', { query: '  ' });
    assert.strictEqual(bad.isError, true);

    await s.call('memory_save', { text: 'clave del deploy token=abcdef123456 en el servidor', project: PROJECT });
    const found = await s.call('memory_search', { query: 'clave deploy servidor', project: PROJECT });
    assert.match(found.content[0].text, /\(note, cursor\)/);
    assert.doesNotMatch(found.content[0].text, /abcdef123456/);

    const unknown = await s.request('nope/nope', {});
    assert.strictEqual(unknown.error.code, -32601);
  } finally {
    s.child.kill();
  }
});
