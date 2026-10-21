#!/usr/bin/env node
const { openDb, addObservation, addEmbedding, shouldEmbed } = require('../lib/db');
const { embed } = require('../lib/embeddings');
const { summarizeToolUse } = require('../lib/summarize');
const { readStdinJson, safeRun, CLIENT } = require('../lib/hook-io');

// Este hook corre tras cada herramienta y bloquea a Claude mientras tanto:
// el embedding es opcional y con el modelo caliente tarda ~13 ms, así que si
// no llega rápido se guarda la fila sin vector (el backfill la completa luego).
const EMBED_TIMEOUT_MS = 600;

safeRun(async () => {
  const input = readStdinJson();
  const { session_id, cwd, tool_name, tool_input } = input;
  if (!tool_name) return;

  const summary = summarizeToolUse(tool_name, tool_input || {});
  if (!summary) return;

  const db = openDb();
  const id = addObservation(db, {
    session_id: session_id || 'unknown',
    project_path: cwd || process.cwd(),
    kind: 'tool_use',
    tool_name,
    summary,
    source: CLIENT,
  });
  if (shouldEmbed({ kind: 'tool_use', tool_name })) {
    addEmbedding(db, id, await embed(summary, { timeoutMs: EMBED_TIMEOUT_MS }));
  }
});
