const path = require('path');

// Solo lo que vale la pena ver como "neuronas": lo pedido y lo respondido.
// Los tool_use son ~95% de la base y llenarían el grafo de ruido.
const GRAPH_KINDS = ['session_summary', 'user_prompt', 'note'];

function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(na * nb) || 1);
}

// Con vectores unitarios la distancia coseno es 1 - producto punto: evita
// recalcular normas en las ~n² comparaciones.
function normalized(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dotDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

function projectName(project_path) {
  return path.basename(project_path) || project_path;
}

// Observaciones con vector, más recientes primero. Sin vec0 no hay grafo
// semántico, así que se devuelve vacío en vez de fallar.
function loadNodes(db, { project_path, source, limit }) {
  if (!db.vecEnabled) return [];
  const kinds = GRAPH_KINDS.map(() => '?').join(',');
  const where = `${project_path ? 'AND o.project_path = ?' : ''} ${source ? 'AND o.source = ?' : ''}`;
  const params = [...GRAPH_KINDS, ...(project_path ? [project_path] : []), ...(source ? [source] : []), limit];
  const rows = db.prepare(`
    SELECT o.id, o.session_id, o.project_path, o.kind, o.summary, o.created_at, o.source, v.embedding AS embedding
    FROM observations o
    JOIN observations_vec v ON v.rowid = o.id
    WHERE o.kind IN (${kinds}) ${where}
    ORDER BY o.id DESC
    LIMIT ?
  `).all(...params);
  return rows.reverse().map((r) => ({
    ...r,
    vector: normalized(new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))),
  }));
}

// Grafo de similitud: cada nodo se une a sus `k` vecinos semánticos más
// cercanos (si están por debajo de `maxDist`) y a la memoria anterior de su
// misma sesión, que da la "columna vertebral" temporal del grafo.
function buildGraph(db, { project_path = null, source = null, limit = 1200, k = 3, maxDist = 0.4 } = {}) {
  const rows = loadNodes(db, { project_path, source, limit });
  const edges = new Map();
  const addEdge = (a, b, w, type) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const prev = edges.get(key);
    if (prev) {
      if (type === 'semantic' && prev.type === 'session') prev.type = 'both';
      prev.w = Math.max(prev.w, w);
      return;
    }
    edges.set(key, { a, b, w, type });
  };

  // La distancia es simétrica: se calcula una vez por par y se reparte a ambos.
  const near = rows.map(() => []);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const d = dotDistance(rows[i].vector, rows[j].vector);
      if (d < maxDist) {
        near[i].push({ j, d });
        near[j].push({ j: i, d });
      }
    }
  }
  for (let i = 0; i < rows.length; i++) {
    near[i].sort((x, y) => x.d - y.d);
    for (const { j, d } of near[i].slice(0, k)) addEdge(rows[i].id, rows[j].id, 1 - d, 'semantic');
  }

  const lastOfSession = new Map();
  for (const r of rows) {
    const prev = lastOfSession.get(r.session_id);
    if (prev !== undefined) addEdge(prev, r.id, 0.5, 'session');
    lastOfSession.set(r.session_id, r.id);
  }

  const degree = new Map();
  for (const e of edges.values()) {
    degree.set(e.a, (degree.get(e.a) || 0) + 1);
    degree.set(e.b, (degree.get(e.b) || 0) + 1);
  }

  const nodes = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    project: projectName(r.project_path),
    project_path: r.project_path,
    session: r.session_id,
    source: r.source,
    t: r.created_at,
    text: r.summary.length > 320 ? r.summary.slice(0, 320) + '…' : r.summary,
    deg: degree.get(r.id) || 0,
  }));

  return { nodes, edges: [...edges.values()] };
}

module.exports = { buildGraph, projectName, cosineDistance, GRAPH_KINDS };
