#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  openDb, listProjects, listSources, overallStats, pagedObservations, hybridSearch,
} = require('../lib/db');
const { buildGraph } = require('../lib/graph');

const PORT = process.env.CLAUDE_RAM_VIEWER_PORT || 4317;
const STATIC_DIR = path.join(__dirname, '..', 'viewer');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const db = openDb();

// Armar el grafo cuesta ~2 s (n² comparaciones de vectores): se reutiliza
// mientras no entren observaciones nuevas.
const graphCache = new Map();
function cachedGraph(opts) {
  const last = db.prepare('SELECT MAX(id) AS m FROM observations').get().m;
  const key = JSON.stringify(opts);
  const hit = graphCache.get(key);
  if (hit && hit.last === last) return hit.graph;
  const graph = buildGraph(db, opts);
  graphCache.clear();
  graphCache.set(key, { last, graph });
  return graph;
}

const server = http.createServer(async (req, res) => {
  // Everything here binds to localhost only (see listen() below) and reads
  // your own memory.db — never touches the network beyond your machine.
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/projects') {
      return sendJson(res, 200, listProjects(db));
    }

    if (url.pathname === '/api/sources') {
      return sendJson(res, 200, listSources(db));
    }

    const source = url.searchParams.get('source') || null;

    if (url.pathname === '/api/stats') {
      const project_path = url.searchParams.get('project') || null;
      return sendJson(res, 200, overallStats(db, { project_path, source }));
    }

    if (url.pathname === '/api/observations') {
      const project_path = url.searchParams.get('project') || null;
      const kind = url.searchParams.get('kind') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      return sendJson(res, 200, pagedObservations(db, { project_path, kind, source, limit, offset }));
    }

    if (url.pathname === '/api/graph') {
      const project_path = url.searchParams.get('project') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '1200', 10), 3000);
      return sendJson(res, 200, cachedGraph({ project_path, source, limit }));
    }

    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const project_path = url.searchParams.get('project') || null;
      if (!query.trim()) return sendJson(res, 200, []);
      // El filtro por cliente va después de la búsqueda: se pide de más para que no se quede corta.
      const hits = await hybridSearch(db, { query, project_path, limit: source ? 90 : 30 });
      return sendJson(res, 200, (source ? hits.filter((h) => h.source === source) : hits).slice(0, 30));
    }

    // Static frontend
    const relPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(STATIC_DIR, relPath);
    if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return; }
    return serveStatic(res, filePath);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude RAM viewer -> http://localhost:${PORT}`);
});
