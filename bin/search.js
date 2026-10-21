#!/usr/bin/env node
const { openDb, hybridSearch, recentObservations } = require('../lib/db');

function parseArgs(argv) {
  const args = { query: null, project: null, limit: 15, recent: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 15;
    else if (a === '--recent') args.recent = true;
    else rest.push(a);
  }
  args.query = rest.join(' ');
  return args;
}

async function main() {
  const { query, project, limit, recent } = parseArgs(process.argv.slice(2));
  const db = openDb();

  const projectPath = project || process.cwd();
  const rows = recent
    ? recentObservations(db, { project_path: projectPath, limit })
    : await hybridSearch(db, { query, project_path: projectPath, limit });

  if (rows.length === 0) {
    console.log('No matching observations found.');
    return;
  }

  for (const r of rows) {
    console.log(`[${r.created_at}] (${r.kind}${r.tool_name ? ':' + r.tool_name : ''}) ${r.summary}`);
  }
}

main();
