const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const LOG_DIR = dataDir();
const ERROR_LOG = path.join(LOG_DIR, 'hook-errors.log');
const ERROR_LOG_MAX_BYTES = 100 * 1024;

// Los mismos hooks sirven a varios clientes; el comando registrado dice cuál
// con `--client codex|cursor` (sin él, Claude Code). Codex usa el mismo
// protocolo que Claude; Cursor tiene otros nombres de campos y de salida.
const CLIENTS = {
  claude: { label: 'Claude', injects: ['SessionStart', 'UserPromptSubmit'] },
  codex: { label: 'Codex', injects: ['SessionStart', 'UserPromptSubmit'] },
  // beforeSubmitPrompt de Cursor solo puede dejar pasar o bloquear el mensaje.
  cursor: { label: 'Cursor', injects: ['SessionStart'] },
};

function clientFromArgv(argv = process.argv) {
  const i = argv.indexOf('--client');
  const name = i >= 0 ? argv[i + 1] : 'claude';
  return CLIENTS[name] ? name : 'claude';
}

const CLIENT = clientFromArgv();

// Lleva la entrada de cada cliente a los campos que usan los hooks (los de Claude Code).
function normalizeInput(raw, client = CLIENT) {
  if (client !== 'cursor') return raw;
  return {
    ...raw,
    // conversation_id llega en todos los eventos de Cursor; session_id solo en algunos.
    session_id: raw.conversation_id || raw.session_id,
    cwd: raw.cwd || (Array.isArray(raw.workspace_roots) ? raw.workspace_roots[0] : undefined),
    tool_response: raw.tool_response ?? raw.tool_output,
    last_assistant_message: raw.last_assistant_message ?? raw.text,
  };
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    return normalizeInput(raw ? JSON.parse(raw) : {});
  } catch {
    return {};
  }
}

function canInject(hookEventName, client = CLIENT) {
  return CLIENTS[client].injects.includes(hookEventName);
}

function contextPayload(hookEventName, additionalContext, client = CLIENT) {
  if (client === 'cursor') return { additional_context: additionalContext };
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

function emitContext(hookEventName, additionalContext) {
  if (!additionalContext || !canInject(hookEventName)) return;
  process.stdout.write(JSON.stringify(contextPayload(hookEventName, additionalContext)));
}

// Cursor espera una decisión en beforeSubmitPrompt; los demás no esperan nada.
function allowPrompt() {
  if (CLIENT === 'cursor') process.stdout.write(JSON.stringify({ continue: true }));
}

// Los errores de los hooks se tragan a propósito (no deben romper la sesión),
// pero eso los hacía invisibles: el bug de `user_input` duró semanas. Ahora
// también quedan en un log acotado que `bin/doctor.js` muestra.
function logHookError(err) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(ERROR_LOG).size > ERROR_LOG_MAX_BYTES) fs.truncateSync(ERROR_LOG, 0);
    } catch { /* aún no existe */ }
    const msg = String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 300);
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${path.basename(process.argv[1] || 'hook')} ${msg}\n`);
  } catch { /* el log nunca debe fallar */ }
}

// Hooks must never break the user's session: any failure here is logged
// to stderr (visible only in debug mode) and swallowed, exit code stays 0.
// fn may be sync or async (return a Promise) — either is awaited safely.
async function safeRun(fn) {
  try {
    await fn();
  } catch (err) {
    process.stderr.write(`agents-ram hook error: ${err && err.stack ? err.stack : err}\n`);
    logHookError(err);
  }
  process.exit(0);
}

function toolResultToText(toolResult) {
  if (toolResult == null) return '';
  if (typeof toolResult === 'string') return toolResult;
  if (typeof toolResult === 'object') {
    if (typeof toolResult.text === 'string') return toolResult.text;
    try { return JSON.stringify(toolResult); } catch { return ''; }
  }
  return String(toolResult);
}

module.exports = {
  readStdinJson, emitContext, canInject, allowPrompt, safeRun, toolResultToText, ERROR_LOG,
  CLIENT, CLIENT_LABEL: CLIENTS[CLIENT].label, clientFromArgv, normalizeInput, contextPayload,
};
