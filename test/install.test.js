// Lógica del instalador sobre configs en memoria: nunca toca los archivos reales.
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const {
  HOOKS_DIR, MCP_SERVER, withHooks, withoutHooks, withCursorMcp, withCodexMcp, hookCommand,
} = require('../lib/install');

const NODE = '/opt/node/bin/node';
const foreign = { type: 'command', command: 'python3 ~/otro-hook.py' };

test('withHooks (codex): agrega los 4 eventos con --client, conserva lo ajeno y es idempotente', () => {
  const start = { hooks: { Stop: [{ hooks: [foreign] }] }, otra: 1 };
  const { config, added } = withHooks(start, 'codex', NODE);
  assert.deepStrictEqual(added, ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
  assert.strictEqual(config.otra, 1);
  assert.deepStrictEqual(config.hooks.Stop[0], { hooks: [foreign] });
  assert.strictEqual(config.hooks.Stop[1].hooks[0].command, `${NODE} ${path.join(HOOKS_DIR, 'stop.js')} --client codex`);

  assert.deepStrictEqual(withHooks(config, 'codex', NODE).added, []);
});

test('withHooks (claude): un `node` del PATH ya registrado cuenta como instalado', () => {
  const cmd = `node ${path.join(HOOKS_DIR, 'stop.js')}`;
  const { added } = withHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } }, 'claude', NODE);
  assert.ok(!added.includes('Stop'));
  assert.strictEqual(added.length, 3);
});

test('withHooks: un hook registrado para otro cliente no cuenta como el propio', () => {
  const cmd = hookCommand('codex', 'stop.js', NODE);
  const { added } = withHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } }, 'claude', NODE);
  assert.ok(added.includes('Stop'));
});

test('withHooks / withoutHooks (cursor): formato plano, version 1 y desinstalación limpia', () => {
  const start = { hooks: { afterFileEdit: [{ command: './format.sh' }] } };
  const { config } = withHooks(start, 'cursor', NODE);
  assert.strictEqual(config.version, 1);
  assert.deepStrictEqual(config.hooks.sessionStart, [{ command: `${NODE} ${path.join(HOOKS_DIR, 'session-start.js')} --client cursor` }]);

  const { config: back, removed } = withoutHooks(config, 'cursor');
  assert.strictEqual(removed.length, 4);
  assert.deepStrictEqual(back.hooks, start.hooks);
});

test('withoutHooks (claude): quita solo lo propio y deja los grupos ajenos', () => {
  const { config } = withHooks({ hooks: { Stop: [{ hooks: [foreign] }] } }, 'claude', 'node');
  const { config: back } = withoutHooks(config, 'claude');
  assert.deepStrictEqual(back.hooks, { Stop: [{ hooks: [foreign] }] });
});

test('withCursorMcp: registra, no duplica y quita sin tocar otros servidores', () => {
  const start = { mcpServers: { otro: { command: 'x' } } };
  const { config, changed } = withCursorMcp(start, NODE);
  assert.ok(changed);
  assert.deepStrictEqual(config.mcpServers['claude-ram'], { command: NODE, args: [MCP_SERVER] });
  assert.strictEqual(withCursorMcp(config, NODE).changed, false);
  assert.deepStrictEqual(withCursorMcp(config, NODE, { remove: true }).config, start);
});

test('withCodexMcp: agrega el bloque TOML y lo quita con sus subtablas, sin tocar el resto', () => {
  const start = 'model = "gpt-5"\n\n[mcp_servers.otro]\ncommand = "x"\n';
  const { text, changed } = withCodexMcp(start, NODE);
  assert.ok(changed);
  assert.match(text, /\[mcp_servers\.claude-ram\]\ncommand = "\/opt\/node\/bin\/node"\nargs = \[".*mcp\.js"\]\n$/);
  assert.strictEqual(withCodexMcp(text, NODE).changed, false);

  const withEnv = text + '\n[mcp_servers.claude-ram.env]\nX = "1"\n\n[profiles.rapido]\nmodel = "o4"\n';
  const removed = withCodexMcp(withEnv, NODE, { remove: true }).text;
  assert.doesNotMatch(removed, /claude-ram/);
  assert.match(removed, /\[mcp_servers\.otro\]\ncommand = "x"/);
  assert.match(removed, /\[profiles\.rapido\]\nmodel = "o4"/);
});
