const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EMBEDDING_DIMS } = require('./embeddings');
const { significantTerms, normalizeText } = require('./summarize');
const { dataDir } = require('./paths');

const DB_DIR = dataDir();
const DB_PATH = path.join(DB_DIR, 'memory.db');

function openDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Vector search is optional: if the native extension can't load on this
  // platform, fall back silently to keyword-only (FTS5) search.
  try {
    sqliteVec.load(db);
    // Cosine distance is bounded to [0, 2] regardless of text length, which
    // makes it possible to threshold "is this actually relevant" — L2
    // (the vec0 default) scales with vector magnitude and can't be
    // thresholded reliably across different summaries.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observations_vec USING vec0(embedding float[${EMBEDDING_DIMS}] distance_metric=cosine)`);
    db.vecEnabled = true;
  } catch (err) {
    process.stderr.write(`agents-ram: sqlite-vec unavailable, falling back to keyword search only (${err.message})\n`);
    db.vecEnabled = false;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      kind TEXT NOT NULL,           -- 'tool_use' | 'user_prompt' | 'session_summary' | 'note'
      tool_name TEXT,
      source TEXT NOT NULL DEFAULT 'claude', -- cliente que la guardó: claude | codex | cursor
      summary TEXT NOT NULL,        -- compact human-readable text, this is what gets indexed
      detail TEXT,                  -- optional raw JSON with extra info
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project_path);
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      summary,
      content='observations',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, summary) VALUES (new.id, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
      INSERT INTO observations_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
  `);

  // Bases creadas antes de que hubiera más de un cliente: todo lo viejo es de Claude.
  if (!db.prepare('PRAGMA table_info(observations)').all().some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'");
  }
  return db;
}

function addObservation(db, { session_id, project_path, kind, tool_name = null, summary, detail = null, source = 'claude' }) {
  const info = db.prepare(`
    INSERT INTO observations (session_id, project_path, kind, tool_name, summary, detail, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(session_id, project_path, kind, tool_name, summary, detail ? JSON.stringify(detail) : null, source);
  return info.lastInsertRowid;
}

// vec0 requires the rowid to be bound with strict INTEGER affinity —
// a plain JS number sometimes binds as REAL and gets rejected, so use BigInt.
function addEmbedding(db, id, vector) {
  if (!db.vecEnabled || !vector) return;
  db.prepare('INSERT INTO observations_vec(rowid, embedding) VALUES (?, ?)').run(BigInt(id), vector);
}

// Lecturas de archivos y búsquedas se encuentran bien por palabras y son el
// grueso del volumen (≈40% de los tool_use): no merecen un vector cada una.
const EMBED_SKIP_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'ToolSearch'];

function shouldEmbed({ kind, tool_name }) {
  return kind !== 'tool_use' || !EMBED_SKIP_TOOLS.includes(tool_name);
}

// Filas que deberían tener vector y no lo tienen, lo importante primero
// (resúmenes y mensajes antes que herramientas) y lo más nuevo antes.
function missingEmbeddings(db, { limit = 500 } = {}) {
  if (!db.vecEnabled) return [];
  const skip = EMBED_SKIP_TOOLS.map(() => '?').join(',');
  return db.prepare(`
    SELECT o.id, o.summary
    FROM observations o
    LEFT JOIN observations_vec v ON v.rowid = o.id
    WHERE v.rowid IS NULL
      AND (o.kind != 'tool_use' OR o.tool_name IS NULL OR o.tool_name NOT IN (${skip}))
    ORDER BY (o.kind = 'tool_use'), o.id DESC
    LIMIT ?
  `).all(...EMBED_SKIP_TOOLS, limit);
}

function lastSummaryOfSession(db, session_id) {
  const row = db.prepare(`
    SELECT summary FROM observations
    WHERE session_id = ? AND kind = 'session_summary'
    ORDER BY id DESC LIMIT 1
  `).get(session_id);
  return row ? row.summary : null;
}

function hasEmbedding(db, id) {
  if (!db.vecEnabled) return true; // nothing to backfill if vec is disabled
  return !!db.prepare('SELECT 1 FROM observations_vec WHERE rowid = ?').get(BigInt(id));
}

// Broad KNN pass, filtered/joined afterwards — simpler and plenty fast at
// personal-memory scale than fighting vec0's partition-key API for scoping.
function semanticSearchRaw(db, vector, { limit = 40 } = {}) {
  if (!db.vecEnabled) return [];
  return db.prepare(`
    SELECT o.id, o.session_id, o.project_path, o.kind, o.tool_name, o.summary, o.created_at, o.source,
           v.distance AS distance
    FROM observations_vec v
    JOIN observations o ON o.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(vector, limit);
}

// FTS5 MATCH syntax breaks on raw punctuation/operators; sanitize the query
// into a safe OR-of-terms expression before handing it to MATCH.
function sanitizeFtsQuery(query) {
  const terms = significantTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

// Una sesión en /a/b/c comparte memoria con su misma carpeta, sus subcarpetas
// y sus carpetas padre (así apps, apps/api y apps/api/src cuentan como un
// mismo proyecto aunque no haya git). Se excluyen HOME y las superiores:
// unir todo lo que cuelga de ahí mezclaría proyectos que no tienen relación.
function scopePaths(project_path) {
  const home = os.homedir();
  const isDeep = (p) => p.startsWith(home + path.sep) && p.length > home.length + 1;
  if (!project_path || !isDeep(project_path)) return { exact: [project_path], prefix: null };

  const exact = [];
  for (let p = project_path; isDeep(p); p = path.dirname(p)) exact.push(p);
  return { exact, prefix: project_path.replace(/[\\%_]/g, '\\$&') + path.sep + '%' };
}

// Fragmento SQL (con alias de tabla opcional) + parámetros para el alcance.
function scopeClause(project_path, col = 'project_path') {
  const { exact, prefix } = scopePaths(project_path);
  const marks = exact.map(() => '?').join(',');
  if (!prefix) return { sql: `${col} IN (${marks})`, params: exact };
  return { sql: `(${col} IN (${marks}) OR ${col} LIKE ? ESCAPE '\\')`, params: [...exact, prefix] };
}

function inScope(project_path, other) {
  const { exact, prefix } = scopePaths(project_path);
  return exact.includes(other) || (!!prefix && other.startsWith(project_path + path.sep));
}

function searchObservations(db, { query, project_path = null, limit = 15 }) {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const params = [ftsQuery];
  let sql = `
    SELECT o.id, o.session_id, o.project_path, o.kind, o.tool_name, o.summary, o.created_at, o.source,
           bm25(observations_fts) AS rank
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?
  `;
  if (project_path) {
    const scope = scopeClause(project_path, 'o.project_path');
    sql += ` AND ${scope.sql}`;
    params.push(...scope.params);
  }
  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function recentObservations(db, { project_path, limit = 10 }) {
  const scope = scopeClause(project_path);
  return db.prepare(`
    SELECT id, session_id, project_path, kind, tool_name, summary, created_at
    FROM observations
    WHERE ${scope.sql}
    ORDER BY id DESC
    LIMIT ?
  `).all(...scope.params, limit);
}

// Lo que vale la pena recordar al abrir una sesión: lo que se pidió y lo que
// se respondió (y las notas guardadas a mano), no el rastro de cada herramienta.
function recentMeaningful(db, { project_path, limit = 8 }) {
  const scope = scopeClause(project_path);
  return db.prepare(`
    SELECT id, session_id, project_path, kind, tool_name, summary, created_at, source
    FROM observations
    WHERE ${scope.sql} AND kind IN ('session_summary', 'user_prompt', 'note')
    ORDER BY id DESC
    LIMIT ?
  `).all(...scope.params, limit);
}

// Retención: los tool_use son ~95% de la base y pierden valor rápido.
// Con dryRun solo cuenta; borra también los vectores para no dejar huérfanos.
function pruneToolUse(db, { days = 30, dryRun = true } = {}) {
  const ids = db.prepare(`
    SELECT id FROM observations
    WHERE kind = 'tool_use' AND created_at < datetime('now', ?)
  `).all(`-${Number(days)} days`).map((r) => r.id);
  if (dryRun || ids.length === 0) return ids.length;
  const delObs = db.prepare('DELETE FROM observations WHERE id = ?');
  const delVec = db.vecEnabled ? db.prepare('DELETE FROM observations_vec WHERE rowid = ?') : null;
  db.transaction(() => {
    for (const id of ids) {
      delObs.run(id);
      if (delVec) delVec.run(BigInt(id));
    }
  })();
  return ids.length;
}

// Reciprocal Rank Fusion: combines the FTS5 (keyword) ranking and the vec0
// (semantic) ranking into one list. A row that shows up near the top of
// either list outranks one that's mediocre on both — no score normalization
// needed since RRF only cares about rank position, not raw distance/bm25 units.
const RRF_K = 60;

function fuseRankings(lists) {
  const scored = new Map();
  for (const list of lists) {
    list.forEach((row, idx) => {
      const prev = scored.get(row.id);
      const add = 1 / (RRF_K + idx + 1);
      if (prev) prev.score += add;
      else scored.set(row.id, { row, score: add });
    });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).map((s) => s.row);
}

// Cosine distance ([0,2], lower = closer) below which a semantic match is
// worth surfacing at all. Calibrated empirically: genuinely related queries
// against this project's own memory landed at ~0.21-0.30; unrelated ones
// (e.g. "que opinas del clima hoy") never went below ~0.35. RRF rank alone
// can't make this call — vector search always returns *a* closest match
// even when nothing in memory is actually relevant, so this cutoff is what
// keeps irrelevant memory from being injected into every single prompt.
// Re-medido el 2026-10-08 con 11k observaciones y vectores completos:
// 8 consultas relevantes quedaron entre 0.18 y 0.29; 8 ajenas entre 0.32 y
// 0.42. El corte en 0.3 cae en el hueco, pero con poco margen: si empiezan a
// colarse notas ajenas, bajarlo a 0.28; si faltan las pertinentes, no pasar de 0.31.
const SEMANTIC_DISTANCE_THRESHOLD = 0.3;

// The async, best-quality search: keyword (FTS5) + semantic (vec0) fused
// with RRF. Degrades to keyword-only automatically if Ollama/vec is down.
// `vector`: embedding de la consulta ya calculado (así un hook no lo pide dos
// veces); `embedTimeoutMs`: cuánto esperar si hay que calcularlo aquí.
async function hybridSearch(db, { query, project_path = null, limit = 8, minTerms = 2, vector: given, embedTimeoutMs }) {
  const { embed } = require('./embeddings');

  // Con varias palabras clave, una sola coincidencia suelta no basta: exigir
  // al menos dos evita inyectar notas que solo comparten una palabra común.
  const terms = significantTerms(query);
  const need = Math.min(minTerms, terms.length);
  const overlap = (row) => {
    const text = normalizeText(row.summary);
    return terms.filter((t) => text.includes(t)).length;
  };
  const ftsHits = searchObservations(db, { query, project_path, limit: limit * 5 })
    .filter((r) => overlap(r) >= need)
    .slice(0, limit * 3);

  let vecHits = [];
  const vector = given !== undefined ? given : await embed(query, embedTimeoutMs ? { timeoutMs: embedTimeoutMs } : undefined);
  if (vector) {
    const raw = semanticSearchRaw(db, vector, { limit: Math.max(40, limit * 8) });
    vecHits = raw.filter((r) => r.distance < SEMANTIC_DISTANCE_THRESHOLD);
    if (project_path) vecHits = vecHits.filter((r) => inScope(project_path, r.project_path));
    vecHits = vecHits.slice(0, limit * 3);
  }

  return fuseRankings([ftsHits, vecHits]).slice(0, limit);
}

function listProjects(db) {
  return db.prepare(`
    SELECT project_path, COUNT(*) AS count, MAX(created_at) AS last_activity
    FROM observations
    GROUP BY project_path
    ORDER BY last_activity DESC
  `).all();
}

// Filtros exactos por proyecto y cliente de origen, compartidos por el dashboard.
function whereExact({ project_path = null, kind = null, source = null }) {
  const clauses = [];
  const params = [];
  if (project_path) { clauses.push('project_path = ?'); params.push(project_path); }
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  if (source) { clauses.push('source = ?'); params.push(source); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function listSources(db) {
  return db.prepare(`
    SELECT source, COUNT(*) AS count, MAX(created_at) AS last_activity
    FROM observations
    GROUP BY source
    ORDER BY count DESC
  `).all();
}

function overallStats(db, { project_path = null, source = null } = {}) {
  const { where, params } = whereExact({ project_path, source });

  const total = db.prepare(`SELECT COUNT(*) AS c FROM observations ${where}`).get(...params).c;

  const byKind = db.prepare(`
    SELECT kind, COUNT(*) AS count FROM observations ${where} GROUP BY kind
  `).all(...params);

  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS count FROM observations ${where} GROUP BY source ORDER BY count DESC
  `).all(...params);

  const byDay = db.prepare(`
    SELECT date(created_at) AS day, kind, COUNT(*) AS count
    FROM observations
    ${where ? where + ' AND' : 'WHERE'} date(created_at) >= date('now', '-13 days')
    GROUP BY day, kind
    ORDER BY day ASC
  `).all(...params);

  return { total, byKind, bySource, byDay, vecEnabled: db.vecEnabled, diskBytes: diskUsageBytes() };
}

// Real bytes on disk, including the WAL/SHM files — in WAL mode most recent
// writes live there until a checkpoint, so the main .db file alone
// understates actual usage.
function diskUsageBytes() {
  return ['', '-wal', '-shm'].reduce((sum, suffix) => {
    try { return sum + fs.statSync(DB_PATH + suffix).size; } catch { return sum; }
  }, 0);
}

function pagedObservations(db, { project_path = null, kind = null, source = null, limit = 50, offset = 0 }) {
  const { where, params } = whereExact({ project_path, kind, source });
  params.push(limit, offset);
  return db.prepare(`
    SELECT id, session_id, project_path, kind, tool_name, summary, created_at, source
    FROM observations
    ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params);
}

module.exports = {
  openDb,
  addObservation,
  addEmbedding,
  hasEmbedding,
  searchObservations,
  semanticSearchRaw,
  hybridSearch,
  recentObservations,
  recentMeaningful,
  pruneToolUse,
  shouldEmbed,
  missingEmbeddings,
  lastSummaryOfSession,
  EMBED_SKIP_TOOLS,
  listProjects,
  listSources,
  overallStats,
  pagedObservations,
  DB_PATH,
  DB_DIR,
};
