#!/usr/bin/env node
// Redacta secretos que ya estaban guardados antes del filtro. Por defecto solo
// cuenta (dry-run); reescribe con --apply. Los vectores no se tocan: un
// embedding no contiene el texto original.
//   node bin/scrub.js            # cuántas filas cambiarían
//   node bin/scrub.js --apply    # las reescribe
const { openDb } = require('../lib/db');
const { redactSecrets } = require('../lib/summarize');

const apply = process.argv.includes('--apply');
const db = openDb();

const rows = db.prepare('SELECT id, summary, detail FROM observations').all();
const changed = [];
for (const r of rows) {
  const summary = redactSecrets(r.summary);
  const detail = r.detail ? redactSecrets(r.detail) : r.detail;
  if (summary !== r.summary || detail !== r.detail) changed.push({ id: r.id, summary, detail });
}

if (apply && changed.length) {
  const upd = db.prepare('UPDATE observations SET summary = ?, detail = ? WHERE id = ?');
  db.transaction(() => changed.forEach((c) => upd.run(c.summary, c.detail, c.id)))();
}

console.log(apply
  ? `Reescritas ${changed.length} de ${rows.length} filas.`
  : `${changed.length} de ${rows.length} filas contienen algo que se redactaría. Usa --apply para reescribirlas.`);
