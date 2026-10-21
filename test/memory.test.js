// Usa una base temporal: nunca toca ~/.claude/claude-ram.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

process.env.CLAUDE_RAM_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ram-test-'));

const {
  openDb, addObservation, recentObservations, recentMeaningful, hybridSearch, pruneToolUse,
} = require('../lib/db');
const { shouldEmbed, missingEmbeddings, addEmbedding, lastSummaryOfSession } = require('../lib/db');
const {
  redactSecrets, stripPrivate, truncateMiddle, significantTerms, summarizeToolUse, dedupeSimilar,
} = require('../lib/summarize');

const HOME = os.homedir();
const P = (...s) => path.join(HOME, 'proj', ...s);

test('redactSecrets: llaves, JWT, URLs con clave y pares NOMBRE: valor', () => {
  const cases = [
    'client GOCSPX-abcdefghij1234567890',
    'key sk-ant-api03-abcdefghijklmnop',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'mongodb://app:hunter2pass@mongodb:27017/db',
    'hex deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef',
    'SMTP_SECRET_KEY: "q7Wv2LmN9xKp4RtZ8bYc"',
    'ADMIN_PASSWORD=NotARealPass42!',
  ];
  for (const c of cases) {
    const out = redactSecrets(c);
    assert.match(out, /\[redacted\]/, c);
    assert.doesNotMatch(out, /GOCSPX-abc|sk-ant-api03|abcdefghijklmnopqrstuvwxyz|hunter2pass|deadbeefcafe|q7Wv2LmN9x|NotARealPass42/, out);
  }
});

test('redactSecrets: no toca texto normal ni nombres de variables sin valor', () => {
  const ok = 'FRONTEND_URL: https://app.example.com y RENTALS_FRONTEND_URL apuntan al front';
  assert.strictEqual(redactSecrets(ok), ok);
});

test('stripPrivate también redacta secretos', () => {
  assert.doesNotMatch(stripPrivate('<private>x</private> token=abcdef123456'), /abcdef123456|>x</);
});

test('un secreto largo en un comando se redacta antes de truncar', () => {
  const cmd = 'curl -H "x: ' + 'a'.repeat(170) + '" -d password=supersecreto123';
  const s = summarizeToolUse('Bash', { command: cmd });
  assert.doesNotMatch(s, /supersecreto123/);
});

test('truncateMiddle conserva principio y final', () => {
  const s = 'INICIO ' + 'x'.repeat(1000) + ' FINAL';
  const out = truncateMiddle(s, 100);
  assert.ok(out.length <= 100);
  assert.match(out, /^INICIO/);
  assert.match(out, /FINAL$/);
  assert.strictEqual(truncateMiddle('corto', 100), 'corto');
});

test('significantTerms quita palabras vacías y cortas', () => {
  assert.deepStrictEqual(significantTerms('existe algo más que se pueda mejorar?'), ['mejorar']);
  assert.deepStrictEqual(significantTerms('RENTALS_FRONTEND_URL del stack'), ['rentals_frontend_url', 'stack']);
  assert.ok(significantTerms('de la').length > 0, 'consulta solo de palabras vacías no queda vacía');
});

test('alcance por carpeta: padres e hijos comparten; ajenos y HOME no', () => {
  const db = openDb();
  const s = (p, t, kind = 'session_summary') => addObservation(db, { session_id: 'a', project_path: p, kind, summary: t });
  s(P(), 'raíz'); s(P('api'), 'api'); s(P('api', 'src'), 'src'); s(P('web'), 'web');
  s(P('otro_x'), 'otro'); s(HOME, 'home'); s(path.join(HOME, 'ajeno'), 'ajeno');

  const texts = (p) => recentObservations(db, { project_path: p, limit: 50 }).map((r) => r.summary).sort();
  assert.deepStrictEqual(texts(P('api')), ['api', 'raíz', 'src']);
  assert.deepStrictEqual(texts(P()), ['api', 'otro', 'raíz', 'src', 'web']);
  assert.deepStrictEqual(texts(HOME), ['home']);
  assert.deepStrictEqual(texts(P('ot_o_x')), ['raíz'], 'solo el padre: los _ de la ruta no actúan como comodín');
  assert.ok(recentMeaningful(db, { project_path: P('api'), limit: 5 }).length === 3);
});

test('hybridSearch exige 2 términos y no devuelve notas con una palabra suelta', async () => {
  const db = openDb();
  const p = P('busqueda');
  const add = (t) => addObservation(db, { session_id: 'b', project_path: p, kind: 'session_summary', summary: t });
  add('Cambié la letra del superadmin a Hanken Grotesk');
  add('El stack de acme necesita RENTALS_FRONTEND_URL en el servicio api');
  add('Deploy del stack acme sin la variable');

  const sinRuido = await hybridSearch(db, { query: 'existe algo más que se pueda mejorar en la letra?', project_path: p });
  assert.strictEqual(sinRuido.length, 0);

  const hits = await hybridSearch(db, { query: 'variable RENTALS_FRONTEND_URL del stack acme', project_path: p });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => /acme/.test(h.summary)));
});

test('pruneToolUse: dry-run no borra; apply borra solo tool_use viejos', () => {
  const db = openDb();
  const p = P('poda');
  const add = (kind, when) => {
    const id = addObservation(db, { session_id: 'c', project_path: p, kind, summary: kind });
    db.prepare('UPDATE observations SET created_at = datetime(\'now\', ?) WHERE id = ?').run(when, id);
  };
  add('tool_use', '-40 days'); add('tool_use', '-1 days'); add('session_summary', '-40 days');

  const count = () => db.prepare('SELECT COUNT(*) c FROM observations WHERE project_path = ?').get(p).c;
  assert.strictEqual(pruneToolUse(db, { days: 30 }), 1);
  assert.strictEqual(count(), 3);
  assert.strictEqual(pruneToolUse(db, { days: 30, dryRun: false }), 1);
  assert.strictEqual(count(), 2);
});

test('dedupeSimilar descarta la nota vieja que repite o contradice a una más nueva', () => {
  const rows = [
    { id: 3, summary: 'Respuesta de Claude: El servicio acme_api no tiene la variable RENTALS_FRONTEND_URL en el stack' },
    { id: 9, summary: 'Respuesta de Claude: El servicio acme_api ya tiene la variable RENTALS_FRONTEND_URL en el stack' },
    { id: 5, summary: 'Cambié la tipografía del superadmin a Hanken Grotesk' },
  ];
  assert.deepStrictEqual(dedupeSimilar(rows).map((r) => r.id), [9, 5]);
  assert.strictEqual(dedupeSimilar([rows[2]]).length, 1);
  const corto = [{ id: 1, summary: 'ok listo' }, { id: 2, summary: 'ok listo' }];
  assert.strictEqual(dedupeSimilar(corto).length, 2, 'textos muy cortos no se comparan');
});

test('shouldEmbed salta Read/Glob/Grep pero no Bash ni los resúmenes', () => {
  assert.strictEqual(shouldEmbed({ kind: 'tool_use', tool_name: 'Read' }), false);
  assert.strictEqual(shouldEmbed({ kind: 'tool_use', tool_name: 'Grep' }), false);
  assert.strictEqual(shouldEmbed({ kind: 'tool_use', tool_name: 'Bash' }), true);
  assert.strictEqual(shouldEmbed({ kind: 'session_summary' }), true);
});

test('missingEmbeddings: solo lo que debería tener vector, lo importante primero', () => {
  const db = openDb();
  if (!db.vecEnabled) return;
  const p = P('vectores');
  const add = (kind, tool_name, summary) => addObservation(db, { session_id: 'v', project_path: p, kind, tool_name, summary });
  const read = add('tool_use', 'Read', 'Read a.txt');
  const bash = add('tool_use', 'Bash', 'Bash: ls');
  const resumen = add('session_summary', null, 'resumen con vector pendiente');
  const hecho = add('session_summary', null, 'resumen ya embebido');
  addEmbedding(db, hecho, new Float32Array(768));

  const ids = missingEmbeddings(db, { limit: 100 }).map((r) => r.id).filter((id) => [read, bash, resumen, hecho].includes(id));
  assert.deepStrictEqual(ids, [resumen, bash], 'sin Read ni el ya embebido; el resumen antes que la herramienta');
});

test('lastSummaryOfSession devuelve el último resumen de esa sesión', () => {
  const db = openDb();
  const add = (sid, t) => addObservation(db, { session_id: sid, project_path: P('ult'), kind: 'session_summary', summary: t });
  add('s1', 'primero'); add('s2', 'otra sesión'); add('s1', 'segundo');
  assert.strictEqual(lastSummaryOfSession(db, 's1'), 'segundo');
  assert.strictEqual(lastSummaryOfSession(db, 'nunca'), null);
});

test('buildGraph: une vecinos semánticos y la secuencia de una sesión, ignora tool_use', () => {
  const { buildGraph } = require('../lib/graph');
  const db = openDb();
  const vec = (...head) => { const v = new Float32Array(768); head.forEach((x, i) => { v[i] = x; }); return v; };
  const add = (sid, kind, summary, v) => {
    const id = addObservation(db, { session_id: sid, project_path: P('grafo'), kind, summary });
    addEmbedding(db, id, v);
    return id;
  };
  const a = add('g1', 'user_prompt', 'docker compose arriba', vec(1, 0.05));
  const b = add('g2', 'session_summary', 'levanté los contenedores', vec(1, 0.1));
  const c = add('g3', 'session_summary', 'receta de pan', vec(0, 0, 1));
  const tool = addObservation(db, { session_id: 'g1', project_path: P('grafo'), kind: 'tool_use', tool_name: 'Bash', summary: 'Bash: ls' });

  const g = buildGraph(db, { project_path: P('grafo') });
  const ids = g.nodes.map((n) => n.id);
  assert.deepStrictEqual(ids.sort(), [a, b, c].sort());
  assert.ok(!ids.includes(tool));
  const linked = (x, y) => g.edges.some((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x));
  assert.ok(linked(a, b), 'vectores casi iguales deben unirse');
  assert.ok(!linked(a, c) && !linked(b, c), 'un tema ajeno queda aislado');
});
