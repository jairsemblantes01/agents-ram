#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');
const { openDb, recentMeaningful, recentObservations, pruneToolUse } = require('../lib/db');
const { truncateMiddle, dedupeSimilar } = require('../lib/summarize');
const { readStdinJson, emitContext, safeRun } = require('../lib/hook-io');
const { env } = require('../lib/paths');

const RECENT_LIMIT = 8;
const LINE_MAX_CHARS = 260;
const BACKFILL_BATCH = 300;

// Poda opcional: solo si defines AGENTS_RAM_PRUNE_DAYS (>= 7). Sin la variable
// no se borra nada nunca.
function pruneDays() {
  const n = Number(env('PRUNE_DAYS'));
  return Number.isFinite(n) && n >= 7 ? n : null;
}

// Calienta el modelo de embeddings y completa los vectores pendientes en
// segundo plano, sin bloquear el arranque de la sesión.
function backgroundBackfill() {
  const script = path.join(__dirname, '..', 'bin', 'backfill-embeddings.js');
  spawn(process.execPath, [script, '--quiet', '--limit', String(BACKFILL_BATCH)], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

safeRun(() => {
  const input = readStdinJson();
  const projectPath = input.cwd || process.cwd();

  const db = openDb();
  const days = pruneDays();
  if (days) {
    try { pruneToolUse(db, { days, dryRun: false }); } catch { /* la poda nunca debe romper la sesión */ }
  }
  backgroundBackfill();

  // Primero lo que se pidió/respondió; solo si no hay nada, el rastro de herramientas.
  // Se leen de más para poder descartar las notas repetidas o ya superadas.
  const fetchLimit = RECENT_LIMIT * 3;
  let rows = recentMeaningful(db, { project_path: projectPath, limit: fetchLimit });
  if (rows.length === 0) rows = recentObservations(db, { project_path: projectPath, limit: fetchLimit });
  rows = dedupeSimilar(rows).slice(0, RECENT_LIMIT);
  if (rows.length === 0) return;

  const lines = rows
    .reverse()
    .map((r) => {
      const flat = r.summary.replace(/^Respuesta de \w+:\s*/, '').replace(/\s+/g, ' ');
      return `- [${r.created_at.slice(0, 10)}] (${r.kind}) ${truncateMiddle(flat, LINE_MAX_CHARS)}`;
    })
    .join('\n');

  const context = [
    'Memoria local de Agents RAM para este proyecto (sesiones pasadas, de la más antigua a la más reciente).',
    'Son notas sin verificar: el estado real (servidores, despliegues, archivos) pudo cambiar desde la fecha indicada. Compruébalo antes de darlo por cierto.',
    lines,
    '',
    'Usa `node ' + path.join(__dirname, '..', 'bin', 'search.js') + ' "<consulta>"` si necesitas buscar algo más específico en el historial.',
  ].join('\n');

  emitContext('SessionStart', context);
});
