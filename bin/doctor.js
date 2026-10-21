#!/usr/bin/env node
// Revisa que Agents RAM esté funcionando de verdad: hooks registrados (Claude
// Code, Codex y Cursor), servidor MCP, Ollama al día, vectores guardados y
// errores recientes. Sale con código 1 si hay algo que corregir. Solo lee,
// salvo con --clear-errors, que únicamente vacía el log de errores.
//   node bin/doctor.js
//   node bin/doctor.js --clear-errors
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, DB_PATH, overallStats } = require('../lib/db');
const { embed, OLLAMA_BASE, MODEL } = require('../lib/embeddings');
const { ERROR_LOG } = require('../lib/hook-io');

const ROOT = path.join(__dirname, '..');
const EVENTS = { SessionStart: 'session-start.js', UserPromptSubmit: 'user-prompt-submit.js', PostToolUse: 'post-tool-use.js', Stop: 'stop.js' };
const CURSOR_EVENTS = { sessionStart: 'session-start.js', beforeSubmitPrompt: 'user-prompt-submit.js', postToolUse: 'post-tool-use.js', afterAgentResponse: 'stop.js' };
const problems = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => { problems.push(m); console.log(`  ✗ ${m}`); };
const title = (t) => console.log(`\n${t}`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Comandos registrados para un evento, en el formato de Claude/Codex
// ({ hooks: [{ command }] } por grupo) o en el de Cursor ({ command } directo).
function commandsFor(hooks, event) {
  return (hooks?.[event] || []).flatMap((g) => (g.hooks ? g.hooks.map((h) => h.command || '') : [g.command || '']));
}

function checkClientHooks({ name, file, events, client, optional }) {
  title(`Hooks de ${name} en ${file.replace(os.homedir(), '~')}`);
  let config;
  try {
    config = readJson(file);
  } catch (e) {
    // Codex y Cursor son opcionales: sin su carpeta, no se usan aquí.
    if (optional && e.code === 'ENOENT') return console.log('  - sin configurar (opcional)');
    return warn(`No se pudo leer ${file} (${e.message})`);
  }
  for (const [event, hookFile] of Object.entries(events)) {
    const target = path.join(ROOT, 'hooks', hookFile);
    const cmds = commandsFor(config.hooks, event).filter((c) => c.includes(target));
    const flag = client ? `--client ${client}` : null;
    if (cmds.length === 0) warn(`${event} no apunta a ${target}`);
    else if (flag && !cmds.some((c) => c.includes(flag))) warn(`${event} apunta a ${hookFile} pero sin \`${flag}\``);
    else ok(`${event} → ${hookFile}`);
  }
}

function checkHooks() {
  checkClientHooks({ name: 'Claude Code', file: path.join(os.homedir(), '.claude', 'settings.json'), events: EVENTS });
  const optionalClients = [
    { name: 'Codex', dir: '.codex', file: 'hooks.json', client: 'codex', events: EVENTS },
    { name: 'Cursor', dir: '.cursor', file: 'hooks.json', client: 'cursor', events: CURSOR_EVENTS },
  ];
  for (const c of optionalClients) {
    const dir = path.join(os.homedir(), c.dir);
    if (fs.existsSync(dir)) checkClientHooks({ ...c, file: path.join(dir, c.file), optional: true });
  }
}

// El servidor MCP es lo que deja a cada cliente buscar y guardar a mano.
function checkMcp() {
  title('Servidor MCP (bin/mcp.js)');
  const server = path.join(ROOT, 'bin', 'mcp.js');
  const home = os.homedir();
  const configs = [
    { name: 'Claude Code', file: path.join(home, '.claude.json'), dir: '.claude' },
    { name: 'Codex', file: path.join(home, '.codex', 'config.toml'), dir: '.codex' },
    { name: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), dir: '.cursor' },
  ];
  for (const c of configs) {
    if (!fs.existsSync(path.join(home, c.dir))) continue;
    let text = '';
    try { text = fs.readFileSync(c.file, 'utf-8'); } catch { /* sin archivo = sin registrar */ }
    text.includes(server)
      ? ok(`${c.name} lo tiene registrado`)
      : console.log(`  - ${c.name}: no registrado (opcional; ver README)`);
  }
}

function checkDb() {
  title('Base de datos');
  if (!fs.existsSync(DB_PATH)) return warn(`No existe ${DB_PATH}`);
  const db = openDb();
  const stats = overallStats(db);
  ok(`${stats.total} observaciones, ${(stats.diskBytes / 1048576).toFixed(1)} MB en disco`);
  if (stats.diskBytes > 200 * 1048576) warn('La base supera 200 MB: considera `node bin/prune.js`');

  const recent = db.prepare(`
    SELECT kind, COUNT(*) AS n FROM observations
    WHERE created_at >= datetime('now', '-7 days') GROUP BY kind
  `).all();
  const n = Object.fromEntries(recent.map((r) => [r.kind, r.n]));
  console.log(`    últimos 7 días: ${recent.map((r) => `${r.kind}=${r.n}`).join(', ') || 'sin actividad'}`);
  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS n FROM observations
    WHERE created_at >= datetime('now', '-7 days') GROUP BY source ORDER BY n DESC
  `).all();
  if (bySource.length) console.log(`    por cliente: ${bySource.map((r) => `${r.source}=${r.n}`).join(', ')}`);

  // Cada mensaje del usuario debería guardarse junto a respuestas. Si hay muchas
  // respuestas y casi ningún mensaje, UserPromptSubmit está fallando.
  if ((n.session_summary || 0) >= 10 && (n.user_prompt || 0) < (n.session_summary || 0) * 0.3) {
    warn(`Hay ${n.session_summary} respuestas pero solo ${n.user_prompt || 0} mensajes guardados: UserPromptSubmit no está guardando`);
  } else ok('Mensajes y respuestas guardándose en proporción');

  if (!db.vecEnabled) return warn('sqlite-vec no se pudo cargar: solo hay búsqueda por palabras');
  const cov = db.prepare(`
    SELECT COUNT(*) AS total, SUM(v.rowid IS NOT NULL) AS con
    FROM observations o LEFT JOIN observations_vec v ON v.rowid = o.id
    WHERE o.created_at >= datetime('now', '-7 days')
      AND (o.kind != 'tool_use' OR o.tool_name IS NULL OR o.tool_name NOT IN ('Read','Glob','Grep','LS','ToolSearch'))
  `).get();
  const pct = cov.total ? Math.round((100 * (cov.con || 0)) / cov.total) : 100;
  pct >= 80
    ? ok(`Vectores al día: ${pct}% de lo que debería tenerlos (últimos 7 días)`)
    : warn(`Solo ${pct}% con vector (últimos 7 días). Ejecuta \`node bin/backfill-embeddings.js\``);
}

async function checkOllama() {
  title('Ollama (búsqueda semántica)');
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const tags = await res.json();
    if (!tags.models?.some((m) => m.name.startsWith(MODEL))) return warn(`Falta el modelo: ollama pull ${MODEL}`);
    ok(`Ollama responde y tiene ${MODEL}`);
  } catch {
    return warn(`Ollama no responde en ${OLLAMA_BASE} (la búsqueda cae a solo palabras)`);
  }
  const t0 = Date.now();
  const v = await embed('prueba de latencia', { timeoutMs: 20000 });
  const ms = Date.now() - t0;
  if (!v) return warn('Ollama respondió pero no devolvió un embedding');
  ms < 800
    ? ok(`Embedding en ${ms} ms (modelo caliente)`)
    : warn(`Embedding en ${ms} ms: el modelo estaba frío. Ya queda cargado; los hooks usan timeouts de 0,6 a 1,5 s`);
}

// Solo cuentan como problema los errores recientes: uno viejo ya corregido no
// debería dejar el diagnóstico en rojo para siempre.
const ERROR_WINDOW_DAYS = 7;

function checkErrors() {
  title('Errores recientes de los hooks');
  let lines;
  try {
    lines = fs.readFileSync(ERROR_LOG, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return ok('Sin errores registrados');
  }
  const since = Date.now() - ERROR_WINDOW_DAYS * 86400000;
  const recent = lines.filter((l) => Date.parse(l.split(' ')[0]) >= since);
  const old = lines.length - recent.length;
  if (recent.length) {
    warn(`${recent.length} errores en los últimos ${ERROR_WINDOW_DAYS} días. Últimos:`);
    recent.slice(-5).forEach((l) => console.log(`      ${l}`));
  } else {
    ok(`Sin errores en los últimos ${ERROR_WINDOW_DAYS} días`);
  }
  if (old) console.log(`    ${old} más antiguos en el log; \`node bin/doctor.js --clear-errors\` lo vacía`);
}

function clearErrors() {
  try {
    fs.truncateSync(ERROR_LOG, 0);
    console.log(`Log de errores vaciado (${ERROR_LOG}).`);
  } catch {
    console.log('No hay log de errores que vaciar.');
  }
}

(async () => {
  if (process.argv.includes('--clear-errors')) return clearErrors();
  console.log('Agents RAM · diagnóstico');
  checkHooks();
  checkMcp();
  checkDb();
  await checkOllama();
  checkErrors();
  console.log(problems.length ? `\n${problems.length} problema(s) por revisar.` : '\nTodo en orden.');
  process.exit(problems.length ? 1 : 0);
})();
