#!/usr/bin/env node
// Servidor MCP (stdio) de Agents RAM: la misma memoria para Claude Code,
// Codex y Cursor. Sin SDK: MCP por stdio es JSON-RPC 2.0, un mensaje por
// línea. stdout es solo del protocolo; cualquier diagnóstico va a stderr.
const readline = require('readline');
const { openDb, addObservation, addEmbedding, hybridSearch, recentMeaningful } = require('../lib/db');
const { embed } = require('../lib/embeddings');
const { stripPrivate, truncateMiddle, dedupeSimilar } = require('../lib/summarize');
const { env } = require('../lib/paths');

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
const NOTE_MAX_CHARS = 1000;
const LINE_MAX_CHARS = 400;
const EMBED_TIMEOUT_MS = 3000;

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Busca en la memoria persistente compartida (sesiones pasadas de Claude Code, Codex y Cursor) por palabras clave y por significado. Úsala antes de preguntar al usuario algo que pudo decidirse antes: decisiones, configuraciones, errores ya resueltos.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Qué buscar, en lenguaje natural.' },
        project: { type: 'string', description: 'Ruta absoluta del proyecto. Por defecto, la carpeta de trabajo actual.' },
        all_projects: { type: 'boolean', description: 'true para buscar en todos los proyectos.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_recent',
    description: 'Lo último que se pidió, respondió o anotó en este proyecto, desde cualquier cliente. Útil al empezar una sesión para retomar el contexto.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Ruta absoluta del proyecto. Por defecto, la carpeta de trabajo actual.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
    },
  },
  {
    name: 'memory_save',
    description: 'Guarda una nota en la memoria compartida para sesiones futuras (de cualquier cliente). Para decisiones, convenciones o hallazgos que valga la pena recordar; no para el rastro de cada paso.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'La nota, autocontenida y breve.' },
        project: { type: 'string', description: 'Ruta absoluta del proyecto. Por defecto, la carpeta de trabajo actual.' },
      },
      required: ['text'],
    },
  },
];

// El cliente se identifica en `initialize`; AGENTS_RAM_SOURCE lo fuerza.
function sourceFromClient(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('codex')) return 'codex';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('claude')) return 'claude';
  return n.replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'mcp';
}

const state = {
  source: env('SOURCE') || 'mcp',
  sessionId: `mcp-${process.pid}-${Date.now()}`,
  db: null,
};

function db() {
  if (!state.db) state.db = openDb();
  return state.db;
}

function clampLimit(n) {
  const v = Number.isInteger(n) ? n : DEFAULT_LIMIT;
  return Math.min(Math.max(v, 1), MAX_LIMIT);
}

function formatRows(rows, { showProject = false } = {}) {
  return rows.map((r) => {
    const where = showProject ? ` ${r.project_path}` : '';
    const flat = r.summary.replace(/\s+/g, ' ');
    return `- [${r.created_at}] (${r.kind}, ${r.source || 'claude'})${where} ${truncateMiddle(flat, LINE_MAX_CHARS)}`;
  }).join('\n');
}

const handlers = {
  async memory_search({ query, project, all_projects, limit }) {
    if (!query || !String(query).trim()) throw new Error('query vacío');
    const project_path = all_projects ? null : (project || process.cwd());
    const n = clampLimit(limit);
    const rows = dedupeSimilar(await hybridSearch(db(), { query: String(query), project_path, limit: n * 2 })).slice(0, n);
    if (rows.length === 0) return 'Sin resultados en la memoria.';
    return formatRows(rows, { showProject: !project_path });
  },

  async memory_recent({ project, limit }) {
    const n = clampLimit(limit);
    const rows = dedupeSimilar(recentMeaningful(db(), { project_path: project || process.cwd(), limit: n * 3 })).slice(0, n);
    if (rows.length === 0) return 'No hay memoria para este proyecto todavía.';
    return [
      'Notas sin verificar, de la más reciente a la más antigua; el estado real pudo cambiar desde entonces.',
      formatRows(rows),
    ].join('\n');
  },

  async memory_save({ text, project }) {
    const clean = stripPrivate(String(text || '')).trim().replace(/\s+/g, ' ');
    if (!clean) throw new Error('text vacío');
    const summary = truncateMiddle(clean, NOTE_MAX_CHARS);
    const id = addObservation(db(), {
      session_id: state.sessionId,
      project_path: project || process.cwd(),
      kind: 'note',
      summary,
      source: state.source,
    });
    addEmbedding(db(), id, await embed(summary, { timeoutMs: EMBED_TIMEOUT_MS }));
    return `Guardado (#${id}).`;
  },
};

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      if (!env('SOURCE')) state.source = sourceFromClient(params.clientInfo && params.clientInfo.name);
      return {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agents-ram', version: require('../package.json').version },
        instructions: 'Memoria local compartida entre Claude Code, Codex y Cursor. Consulta memory_recent al empezar y memory_search antes de pedir al usuario contexto que pudo darse en otra sesión.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const fn = handlers[params.name];
      if (!fn) throw Object.assign(new Error(`herramienta desconocida: ${params.name}`), { code: -32602 });
      // Un fallo de la herramienta es un resultado con isError, no un error de protocolo:
      // así el modelo lo ve y puede corregir los argumentos.
      try {
        const text = await fn(params.arguments || {});
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notificaciones (p. ej. notifications/initialized)
      throw Object.assign(new Error(`método no soportado: ${method}`), { code: -32601 });
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Las peticiones se atienden en paralelo; al cerrarse stdin se espera a que
// terminen las pendientes para no perder una respuesta ni una nota a medio guardar.
const pending = new Set();

async function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    return;
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    process.stderr.write(`agents-ram mcp: ${err.stack || err}\n`);
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const p = onLine(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
