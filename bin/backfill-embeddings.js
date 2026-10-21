#!/usr/bin/env node
// Completa los vectores que faltan (filas guardadas con Ollama apagado, con el
// modelo frío o antes de sqlite-vec). Idempotente: solo toca lo que no tiene.
//   node bin/backfill-embeddings.js              # todo lo pendiente
//   node bin/backfill-embeddings.js --limit 300  # a lo sumo 300 (lo usa SessionStart)
//   node bin/backfill-embeddings.js --quiet      # sin salida si no hay nada que decir
const fs = require('fs');
const path = require('path');
const { openDb, addEmbedding, missingEmbeddings, DB_DIR } = require('../lib/db');
const { embed } = require('../lib/embeddings');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) || 500 : 100000;
const say = (m) => { if (!quiet) console.log(m); };

// Carga en frío del modelo: ~7 s. Aquí sí se puede esperar.
const COLD_START_TIMEOUT_MS = 20000;
const LOCK = path.join(DB_DIR, 'backfill.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

function takeLock() {
  try {
    if (Date.now() - fs.statSync(LOCK).mtimeMs < LOCK_STALE_MS) return false;
  } catch { /* sin lock previo */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

async function main() {
  const db = openDb();
  if (!db.vecEnabled) return say('sqlite-vec no está disponible, nada que hacer.');
  if (!takeLock()) return say('Ya hay otro backfill en curso.');

  try {
    const rows = missingEmbeddings(db, { limit });
    if (rows.length === 0) return say('No falta ningún vector.');

    // La primera llamada puede tardar por la carga en frío; las siguientes ~13 ms.
    let done = 0;
    for (const [i, row] of rows.entries()) {
      const vector = await embed(row.summary, { timeoutMs: i === 0 ? COLD_START_TIMEOUT_MS : 5000 });
      if (!vector) {
        say(`id=${row.id}: Ollama no respondió, se detiene (reintenta luego). Hechos: ${done}.`);
        return;
      }
      try { addEmbedding(db, row.id, vector); } catch { /* otro proceso se adelantó */ }
      done++;
    }
    say(`Listo: ${done} vectores añadidos.`);
  } finally {
    try { fs.unlinkSync(LOCK); } catch { /* ya no está */ }
  }
}

main();
