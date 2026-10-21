#!/usr/bin/env node
// Poda los tool_use viejos. Por defecto solo cuenta (dry-run); borra con --apply.
//   node bin/prune.js                 # cuántos se borrarían (más de 30 días)
//   node bin/prune.js --days 14       # otro umbral
//   node bin/prune.js --apply         # borra de verdad
const { openDb, pruneToolUse } = require('../lib/db');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const i = args.indexOf('--days');
const days = i >= 0 ? Number(args[i + 1]) : 30;
if (!Number.isFinite(days) || days < 1) {
  console.error('--days debe ser un número mayor o igual a 1');
  process.exit(1);
}

const db = openDb();
const n = pruneToolUse(db, { days, dryRun: !apply });
console.log(apply
  ? `Borrados ${n} tool_use con más de ${days} días.`
  : `${n} tool_use con más de ${days} días se borrarían. Usa --apply para borrarlos.`);
