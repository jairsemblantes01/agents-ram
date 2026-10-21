const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_URL = `${OLLAMA_BASE}/api/embeddings`;
const MODEL = 'nomic-embed-text';
const DEFAULT_TIMEOUT_MS = 3000;
// Ollama descarga el modelo a los 5 min por defecto. Cargarlo en frío tarda
// ~7 s: más que cualquier timeout razonable de un hook, y abortar la petición
// reinicia la carga, así que el modelo nunca llegaba a calentarse y casi
// ningún vector se guardaba. Mantenerlo cargado evita ese bucle.
const KEEP_ALIVE = '1h';

// Returns a Float32Array, or null if Ollama is unreachable/slow — callers
// must fall back to keyword-only search rather than fail the hook.
// `timeoutMs`: los hooks que bloquean al usuario usan uno corto; los procesos
// en segundo plano (backfill) uno largo para poder esperar la carga en frío.
async function embed(text, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: text, keep_alive: KEEP_ALIVE }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.embedding)) return null;
    return new Float32Array(data.embedding);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { embed, EMBEDDING_DIMS: 768, OLLAMA_BASE, MODEL };
