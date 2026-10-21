#!/usr/bin/env node
const { openDb, addObservation, addEmbedding, lastSummaryOfSession } = require('../lib/db');
const { embed } = require('../lib/embeddings');
const { stripPrivate, truncateMiddle } = require('../lib/summarize');
const { readStdinJson, safeRun, CLIENT, CLIENT_LABEL } = require('../lib/hook-io');

// Respuestas de una línea ("Listo", "Sí, ya está") no aportan nada al
// recordarlas y llenaban la base: se descartan.
const MIN_CHARS = 100;
const EMBED_TIMEOUT_MS = 1500;

safeRun(async () => {
  const input = readStdinJson();
  const { session_id, cwd, last_assistant_message } = input;
  if (!last_assistant_message) return;

  const clean = stripPrivate(last_assistant_message).trim().replace(/\s+/g, ' ');
  if (clean.length < MIN_CHARS) return;

  // Se compacta antes de truncar: los saltos de línea y tablas gastan espacio.
  const summary = truncateMiddle(`Respuesta de ${CLIENT_LABEL}: ${clean}`, 500);
  const db = openDb();
  const sid = session_id || 'unknown';
  if (lastSummaryOfSession(db, sid) === summary) return; // el hook puede dispararse dos veces

  const id = addObservation(db, {
    session_id: sid,
    project_path: cwd || process.cwd(),
    kind: 'session_summary',
    summary,
    source: CLIENT,
  });
  addEmbedding(db, id, await embed(summary, { timeoutMs: EMBED_TIMEOUT_MS }));
});
