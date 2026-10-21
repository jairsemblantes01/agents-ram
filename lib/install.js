// Registra (o quita) los hooks y el servidor MCP de Agents RAM en la config de
// cada cliente. Toca solo las entradas propias: todo lo demás de cada archivo
// se conserva, y una entrada que ya apunta al hook correcto no se reescribe.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, 'hooks');
const MCP_SERVER = path.join(ROOT, 'bin', 'mcp.js');
const MCP_NAME = 'agents-ram';
// Nombres de antes de llamarse Agents RAM: se quitan al instalar o desinstalar.
const LEGACY_MCP_NAMES = ['claude-ram'];

// Evento de cada cliente → hook. Codex usa los mismos nombres que Claude Code.
const EVENTS = {
  claude: { SessionStart: 'session-start.js', UserPromptSubmit: 'user-prompt-submit.js', PostToolUse: 'post-tool-use.js', Stop: 'stop.js' },
  codex: { SessionStart: 'session-start.js', UserPromptSubmit: 'user-prompt-submit.js', PostToolUse: 'post-tool-use.js', Stop: 'stop.js' },
  cursor: { sessionStart: 'session-start.js', beforeSubmitPrompt: 'user-prompt-submit.js', postToolUse: 'post-tool-use.js', afterAgentResponse: 'stop.js' },
};

function hooksFile(client, home) {
  return {
    claude: path.join(home, '.claude', 'settings.json'),
    codex: path.join(home, '.codex', 'hooks.json'),
    cursor: path.join(home, '.cursor', 'hooks.json'),
  }[client];
}

function hookCommand(client, file, node) {
  return `${node} ${path.join(HOOKS_DIR, file)}${client === 'claude' ? '' : ` --client ${client}`}`;
}

// Propio = apunta a uno de nuestros hooks, en esta carpeta o en otra copia del
// proyecto (la de antes del cambio de nombre, o una que se movió de lugar).
const OUR_HOOK = /[\\/](?:claude-ram|agents-ram)[\\/]hooks[\\/](?:session-start|user-prompt-submit|post-tool-use|stop)\.js\b/;
const isCurrent = (cmd) => typeof cmd === 'string' && cmd.includes(HOOKS_DIR + path.sep);
const isOurs = (cmd) => isCurrent(cmd) || (typeof cmd === 'string' && OUR_HOOK.test(cmd));
const isStale = (cmd) => isOurs(cmd) && !isCurrent(cmd);

// Ya instalado = algún comando apunta a ese hook con el --client que toca
// (sin él, para Claude). Así no se pisa un `node` del PATH por una ruta absoluta.
function hasHook(cmds, client, file) {
  const target = path.join(HOOKS_DIR, file);
  return cmds.some((c) => c.includes(target) && (client === 'claude' ? !/--client\s/.test(c) : c.includes(`--client ${client}`)));
}

// Claude y Codex agrupan: [{ matcher?, hooks: [{ type, command }] }]; Cursor no: [{ command }].
function groupCommands(client, list) {
  return client === 'cursor'
    ? list.map((g) => g.command || '')
    : list.flatMap((g) => (g.hooks || []).map((h) => h.command || ''));
}

// Las entradas que apuntan a otra copia del proyecto se reemplazan, no se duplican.
function withHooks(config, client, node) {
  const { config: base, removed: replaced } = stripHooks(config, client, isStale);
  const next = { ...base, hooks: { ...(base.hooks || {}) } };
  if (client === 'cursor' && next.version === undefined) next.version = 1;
  const added = [];
  for (const [event, file] of Object.entries(EVENTS[client])) {
    const list = next.hooks[event] || [];
    if (hasHook(groupCommands(client, list), client, file)) continue;
    const command = hookCommand(client, file, node);
    const entry = client === 'cursor'
      ? { command }
      : { hooks: [{ type: 'command', command, ...(client === 'codex' ? { timeout: 10 } : {}) }] };
    next.hooks[event] = [...list, entry];
    added.push(event);
  }
  return { config: next, added, replaced };
}

function withoutHooks(config, client) {
  return stripHooks(config, client, isOurs);
}

function stripHooks(config, client, drop) {
  if (!config.hooks) return { config, removed: [] };
  const next = { ...config, hooks: {} };
  const removed = [];
  for (const [event, list] of Object.entries(config.hooks)) {
    let kept = list;
    if (Array.isArray(list)) {
      kept = client === 'cursor'
        ? list.filter((g) => !drop(g.command))
        : list
          .map((g) => (g.hooks ? { ...g, hooks: g.hooks.filter((h) => !drop(h.command)) } : g))
          .filter((g) => !g.hooks || g.hooks.length > 0);
      if (kept.length !== list.length || JSON.stringify(kept) !== JSON.stringify(list)) removed.push(event);
    }
    if (!Array.isArray(kept) || kept.length) next.hooks[event] = kept;
  }
  return { config: next, removed };
}

function withCursorMcp(config, node, { remove = false } = {}) {
  const servers = { ...(config.mcpServers || {}) };
  let changed = false;
  for (const name of [...LEGACY_MCP_NAMES, ...(remove ? [MCP_NAME] : [])]) {
    if (servers[name]) { delete servers[name]; changed = true; }
  }
  if (!remove && !servers[MCP_NAME]) {
    servers[MCP_NAME] = { command: node, args: [MCP_SERVER] };
    changed = true;
  }
  return changed ? { config: { ...config, mcpServers: servers }, changed } : { config, changed };
}

// config.toml de Codex: sin parser TOML, se agrega o quita el bloque propio como
// texto (incluidas sus subtablas, p. ej. [mcp_servers.agents-ram.env]).
const CODEX_MCP_HEADER = `[mcp_servers.${MCP_NAME}]`;
const codexHeader = (name) => `[mcp_servers.${name}]`;
const codexBlock = (name) => new RegExp(`\\n?\\[mcp_servers\\.${name}(\\.[^\\]]+)?\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${name}[.\\]])|$)`, 'g');
const hasCodexBlock = (text, name) => text.split('\n').some((l) => l.trim() === codexHeader(name));

function withCodexMcp(text, node, { remove = false } = {}) {
  let next = text;
  for (const name of [...LEGACY_MCP_NAMES, ...(remove ? [MCP_NAME] : [])]) {
    if (hasCodexBlock(next, name)) next = next.replace(codexBlock(name), '').replace(/^\n+/, '');
  }
  if (!remove && !hasCodexBlock(next, MCP_NAME)) {
    const block = `${CODEX_MCP_HEADER}\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(MCP_SERVER)}]\n`;
    const sep = !next ? '' : next.endsWith('\n\n') ? '' : next.endsWith('\n') ? '\n' : '\n\n';
    next += sep + block;
  }
  return { text: next, changed: next !== text };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

function readJsonFile(file) {
  const text = readText(file);
  return text.trim() ? JSON.parse(text) : {};
}

// Copia de seguridad antes de cambiar un archivo que ya existía.
function writeFile(file, content, { dryRun }) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, content);
}

module.exports = {
  EVENTS, MCP_NAME, LEGACY_MCP_NAMES, MCP_SERVER, HOOKS_DIR, CODEX_MCP_HEADER,
  hooksFile, hookCommand, withHooks, withoutHooks, withCursorMcp, withCodexMcp,
  readText, readJsonFile, writeFile,
};
