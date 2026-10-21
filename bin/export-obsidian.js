#!/usr/bin/env node
// Exporta la memoria como una bóveda de Obsidian para usar su vista de grafo:
// una nota por sesión, una por proyecto, y enlaces entre sesiones parecidas.
// Por defecto escribe en ~/agents-ram-vault (o en ~/claude-ram-vault si ya
// existía de antes del cambio de nombre), NO en tu bóveda Cerebro: esa la
// mantiene Claude con su propio esquema y no debe mezclarse con memoria de máquina.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../lib/db');
const { buildGraph, projectName } = require('../lib/graph');

function defaultVault() {
  const vault = path.join(os.homedir(), 'agents-ram-vault');
  const legacy = path.join(os.homedir(), 'claude-ram-vault');
  return !fs.existsSync(vault) && fs.existsSync(legacy) ? legacy : vault;
}

const out = path.resolve(process.argv[2] || defaultVault());
const db = openDb();
const graph = buildGraph(db, { limit: 3000 });

const safe = (s) => s.replace(/[\\/:*?"<>|#^\[\]]/g, '-').trim();
const sessions = new Map();
for (const n of graph.nodes) {
  if (!sessions.has(n.session)) sessions.set(n.session, { id: n.session, project: n.project, project_path: n.project_path, nodes: [] });
  sessions.get(n.session).nodes.push(n);
}

const noteName = (s) => `${s.nodes[0].t.slice(0, 10)} ${safe(s.project)} ${s.id.slice(0, 6)}`;
const bySession = new Map([...sessions.values()].map((s) => [s.id, s]));
const sessionOf = new Map(graph.nodes.map((n) => [n.id, n.session]));

// Sesiones relacionadas = las que más aristas semánticas comparten.
const related = new Map();
for (const e of graph.edges) {
  if (e.type === 'session') continue;
  const sa = sessionOf.get(e.a), sb = sessionOf.get(e.b);
  if (sa === sb) continue;
  for (const [x, y] of [[sa, sb], [sb, sa]]) {
    if (!related.has(x)) related.set(x, new Map());
    related.get(x).set(y, (related.get(x).get(y) || 0) + e.w);
  }
}

const full = db.prepare('SELECT id, summary FROM observations WHERE id = ?');

fs.rmSync(path.join(out, 'sessions'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'projects'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(out, 'projects'), { recursive: true });

const projects = new Map();
for (const s of sessions.values()) {
  const name = noteName(s);
  if (!projects.has(s.project)) projects.set(s.project, []);
  projects.get(s.project).push(name);

  const rel = [...(related.get(s.id) || [])]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id]) => `- [[${noteName(bySession.get(id))}]]`);
  const body = s.nodes.map((n) => {
    const label = n.kind === 'user_prompt' ? 'Prompt' : 'Respuesta';
    return `### ${label} · ${n.t.slice(11, 16)}\n\n${full.get(n.id).summary}\n`;
  }).join('\n');

  const note = [
    '---',
    `project: "${s.project}"`,
    `path: "${s.project_path}"`,
    `date: ${s.nodes[0].t.slice(0, 10)}`,
    `session: ${s.id}`,
    'tags: [agents-ram]',
    '---',
    `Proyecto: [[${safe(s.project)}]]`,
    '',
    body,
    rel.length ? `## Relacionadas\n\n${rel.join('\n')}\n` : '',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'sessions', `${name}.md`), note);
}

for (const [project, names] of projects) {
  const lines = names.sort().reverse().map((n) => `- [[${n}]]`);
  fs.writeFileSync(path.join(out, 'projects', `${safe(project)}.md`),
    `---\ntags: [agents-ram, proyecto]\n---\n# ${project}\n\n${lines.join('\n')}\n`);
}

console.log(`${sessions.size} sesiones y ${projects.size} proyectos exportados a ${out}`);
console.log('Ábrela en Obsidian: "Abrir carpeta como bóveda" y luego la vista de grafo.');
