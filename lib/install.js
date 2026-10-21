// Registra (o quita) los hooks y el servidor MCP de Claude RAM en la config de
// cada cliente. Toca solo las entradas propias: todo lo demás de cada archivo
// se conserva, y una entrada que ya apunta al hook correcto no se reescribe.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, 'hooks');
const MCP_SERVER = path.join(ROOT, 'bin', 'mcp.js');
const MCP_NAME = 'claude-ram';

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

const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes(HOOKS_DIR + path.sep);

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

function withHooks(config, client, node) {
  const next = { ...config, hooks: { ...(config.hooks || {}) } };
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
  return { config: next, added };
}

function withoutHooks(config, client) {
  if (!config.hooks) return { config, removed: [] };
  const next = { ...config, hooks: {} };
  const removed = [];
  for (const [event, list] of Object.entries(config.hooks)) {
    let kept = list;
    if (Array.isArray(list)) {
      kept = client === 'cursor'
        ? list.filter((g) => !isOurs(g.command))
        : list
          .map((g) => (g.hooks ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) } : g))
          .filter((g) => !g.hooks || g.hooks.length > 0);
      if (kept.length !== list.length || JSON.stringify(kept) !== JSON.stringify(list)) removed.push(event);
    }
    if (!Array.isArray(kept) || kept.length) next.hooks[event] = kept;
  }
  return { config: next, removed };
}

function withCursorMcp(config, node, { remove = false } = {}) {
  const servers = { ...(config.mcpServers || {}) };
  if (remove) {
    if (!servers[MCP_NAME]) return { config, changed: false };
    delete servers[MCP_NAME];
    return { config: { ...config, mcpServers: servers }, changed: true };
  }
  if (servers[MCP_NAME]) return { config, changed: false };
  servers[MCP_NAME] = { command: node, args: [MCP_SERVER] };
  return { config: { ...config, mcpServers: servers }, changed: true };
}

// config.toml de Codex: sin parser TOML, se agrega o quita el bloque propio como
// texto (incluidas sus subtablas, p. ej. [mcp_servers.claude-ram.env]).
const CODEX_MCP_HEADER = `[mcp_servers.${MCP_NAME}]`;
const CODEX_MCP_BLOCK = new RegExp(`\\n?\\[mcp_servers\\.${MCP_NAME}(\\.[^\\]]+)?\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${MCP_NAME}[.\\]])|$)`, 'g');

function withCodexMcp(text, node, { remove = false } = {}) {
  const has = text.split('\n').some((l) => l.trim() === CODEX_MCP_HEADER);
  if (remove) {
    if (!has) return { text, changed: false };
    return { text: text.replace(CODEX_MCP_BLOCK, '').replace(/^\n+/, ''), changed: true };
  }
  if (has) return { text, changed: false };
  const block = `${CODEX_MCP_HEADER}\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(MCP_SERVER)}]\n`;
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: text + sep + block, changed: true };
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
  EVENTS, MCP_NAME, MCP_SERVER, HOOKS_DIR, CODEX_MCP_HEADER,
  hooksFile, hookCommand, withHooks, withoutHooks, withCursorMcp, withCodexMcp,
  readText, readJsonFile, writeFile,
};
