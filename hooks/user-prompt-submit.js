#!/usr/bin/env node
const { openDb, addObservation, addEmbedding, hybridSearch } = require('../lib/db');
const { embed } = require('../lib/embeddings');
const { summarizeUserPrompt, truncateMiddle, dedupeSimilar } = require('../lib/summarize');
const { readStdinJson, emitContext, canInject, allowPrompt, safeRun, CLIENT } = require('../lib/hook-io');

const MIN_RELEVANT_RESULTS = 1;
const INJECT_LIMIT = 3;
const LINE_MAX_CHARS = 240;
// Este hook bloquea el mensaje del usuario. Con el modelo caliente el
// embedding tarda ~13 ms; si está frío (7 s), mejor seguir sin él.
const EMBED_TIMEOUT_MS = 1200;

safeRun(async () => {
  allowPrompt();
  const input = readStdinJson();
  // Claude Code manda el texto en `prompt`; `user_input` queda por compatibilidad.
  const { session_id, cwd } = input;
  const user_input = input.prompt || input.user_input;
  if (!user_input) return;

  const projectPath = cwd || process.cwd();
  const db = openDb();

  // Un solo embedding por mensaje: sirve para guardarlo y para buscar con él.
  const vector = await embed(user_input, { timeoutMs: EMBED_TIMEOUT_MS });

  // Record the prompt itself as an observation for future recall.
  const summary = summarizeUserPrompt(user_input);
  if (summary) {
    const id = addObservation(db, {
      session_id: session_id || 'unknown',
      project_path: projectPath,
      kind: 'user_prompt',
      summary,
      source: CLIENT,
    });
    addEmbedding(db, id, vector);
  }

  // Si el cliente no deja inyectar contexto aquí, buscar solo haría esperar al usuario.
  if (!canInject('UserPromptSubmit')) return;

  // Surface older, relevant memory triggered by this prompt (skip anything
  // from the current session — that's already in the live conversation).
  const found = (await hybridSearch(db, {
    query: user_input, project_path: projectPath, limit: INJECT_LIMIT * 3, vector,
  })).filter((r) => r.session_id !== session_id);
  const hits = dedupeSimilar(found).slice(0, INJECT_LIMIT);

  if (hits.length < MIN_RELEVANT_RESULTS) return;

  const context = [
    'Memoria relevante encontrada (sesiones anteriores) para este mensaje:',
    ...hits.map((r) => `- (${r.created_at}) ${truncateMiddle(r.summary, LINE_MAX_CHARS)}`),
  ].join('\n');

  emitContext('UserPromptSubmit', context);
});
