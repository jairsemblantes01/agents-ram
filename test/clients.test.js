// Adaptadores de cliente (Codex, Cursor) y los hooks reales corriendo con ellos.
// Usa una base temporal: nunca toca ~/.claude/claude-ram.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ram-clients-'));
process.env.CLAUDE_RAM_DB_DIR = DB_DIR;

const { clientFromArgv, normalizeInput, contextPayload } = require('../lib/hook-io');
const { openDb } = require('../lib/db');

const HOOKS = path.join(__dirname, '..', 'hooks');
const PROJECT = path.join(os.homedir(), 'proj', 'clients-test');

function runHook(name, client, input) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, name), '--client', client], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_RAM_DB_DIR: DB_DIR, OLLAMA_URL: 'http://127.0.0.1:9' },
    encoding: 'utf-8',
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout;
}

test('clientFromArgv: --client elige el cliente; sin él o desconocido, Claude', () => {
  assert.strictEqual(clientFromArgv(['node', 'h.js', '--client', 'cursor']), 'cursor');
  assert.strictEqual(clientFromArgv(['node', 'h.js', '--client', 'codex']), 'codex');
  assert.strictEqual(clientFromArgv(['node', 'h.js']), 'claude');
  assert.strictEqual(clientFromArgv(['node', 'h.js', '--client', 'otro']), 'claude');
});

test('normalizeInput: Cursor se traduce a los campos de Claude; Codex pasa igual', () => {
  const cursor = normalizeInput({
    conversation_id: 'c1', workspace_roots: ['/w/a', '/w/b'], text: 'hola', tool_output: 'out',
  }, 'cursor');
  assert.strictEqual(cursor.session_id, 'c1');
  assert.strictEqual(cursor.cwd, '/w/a');
  assert.strictEqual(cursor.last_assistant_message, 'hola');
  assert.strictEqual(cursor.tool_response, 'out');

  const codex = { session_id: 's', cwd: '/x', prompt: 'p' };
  assert.deepStrictEqual(normalizeInput(codex, 'codex'), codex);
});

test('contextPayload: Cursor usa additional_context; Claude y Codex hookSpecificOutput', () => {
  assert.deepStrictEqual(contextPayload('SessionStart', 'ctx', 'cursor'), { additional_context: 'ctx' });
  assert.deepStrictEqual(contextPayload('SessionStart', 'ctx', 'codex'), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
  });
});

test('hooks con --client cursor: guardan con su origen e inyectan al iniciar sesión', () => {
  const base = { conversation_id: 'cur-1', workspace_roots: [PROJECT] };

  const out = runHook('user-prompt-submit.js', 'cursor', { ...base, prompt: 'configura el pipeline de despliegue con docker swarm' });
  assert.deepStrictEqual(JSON.parse(out), { continue: true });

  runHook('stop.js', 'cursor', {
    ...base, text: 'Dejé el pipeline de despliegue listo: construye la imagen, la sube al registro y actualiza el stack de docker swarm.',
  });
  runHook('post-tool-use.js', 'cursor', { ...base, tool_name: 'Shell', tool_input: { command: 'docker stack deploy -c stack.yml app' } });

  const rows = openDb().prepare('SELECT kind, source, summary, session_id FROM observations WHERE project_path = ? ORDER BY id').all(PROJECT);
  assert.deepStrictEqual(rows.map((r) => [r.kind, r.source, r.session_id]), [
    ['user_prompt', 'cursor', 'cur-1'], ['session_summary', 'cursor', 'cur-1'], ['tool_use', 'cursor', 'cur-1'],
  ]);
  assert.match(rows[1].summary, /^Respuesta de Cursor:/);

  const start = JSON.parse(runHook('session-start.js', 'cursor', { conversation_id: 'cur-2', workspace_roots: [PROJECT] }));
  assert.match(start.additional_context, /pipeline de despliegue/);
  assert.doesNotMatch(start.additional_context, /Respuesta de Cursor:/);
});

test('hooks con --client codex: mismo protocolo que Claude, origen codex', () => {
  const p = path.join(PROJECT, 'codex');
  runHook('user-prompt-submit.js', 'codex', { session_id: 'cdx-1', cwd: p, prompt: 'migra la base de usuarios a postgres' });
  const out = runHook('user-prompt-submit.js', 'codex', { session_id: 'cdx-2', cwd: p, prompt: 'como quedo la migracion de usuarios a postgres' });
  const ctx = JSON.parse(out).hookSpecificOutput;
  assert.strictEqual(ctx.hookEventName, 'UserPromptSubmit');
  assert.match(ctx.additionalContext, /migra la base de usuarios/);

  const src = openDb().prepare('SELECT DISTINCT source FROM observations WHERE project_path = ?').all(p);
  assert.deepStrictEqual(src, [{ source: 'codex' }]);
});
