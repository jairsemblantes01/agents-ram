const MAX_LEN = 300;

function truncate(s, max = MAX_LEN) {
  if (!s) return s;
  s = String(s);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Conserva el principio y el final: en una respuesta larga la conclusión
// suele estar al final, y cortar solo la cola la perdía.
function truncateMiddle(s, max = MAX_LEN) {
  if (!s) return s;
  s = String(s);
  if (s.length <= max) return s;
  const mark = ' […] ';
  const room = max - mark.length;
  const head = Math.ceil(room * 0.4);
  return s.slice(0, head) + mark + s.slice(s.length - (room - head));
}

// Patrones de secretos comunes. No es exhaustivo: cubre llaves con prefijo
// conocido, JWT, credenciales en URLs, cadenas hex largas y pares
// NOMBRE=valor / NOMBRE: valor cuyo nombre sugiere un secreto.
const SECRET_PATTERNS = [
  [/\b(?:GOCSPX|sk-ant|sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]'],
  [/(:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1[redacted]@'],
  [/\b[a-fA-F0-9]{32,}\b/g, '[redacted]'],
  [
    /(\b[\w-]*(?:secret|password|passwd|pwd|token|api[_-]?key|private[_-]?key|access[_-]?key|encryption[_-]?key)[\w-]*["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi,
    '$1[redacted]',
  ],
];

function redactSecrets(text) {
  if (!text) return text;
  return SECRET_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), String(text));
}

// Strip anything the user wrapped in <private>...</private>, y además los
// secretos reconocibles, antes de que lleguen a la base de datos.
function stripPrivate(text) {
  if (!text) return text;
  return redactSecrets(text.replace(/<private>[\s\S]*?<\/private>/gi, '[redacted]'));
}

const STOPWORDS = new Set((
  'el la los las un una unos unas de del al y o u e en con por para sin sobre entre hasta desde que como cual cuales ' +
  'quien cuando donde mas menos muy pero sino porque aunque si no ni ya se me te lo le les nos mi tu su sus este esta ' +
  'estos estas ese esa eso esto aqui alli hay son ser fue era soy eres estoy esta estan hacer haz hace puedes puedo ' +
  'tiene tienen tener algo todo todos toda todas otra otro otros ahora luego tambien solo ver the and for with that ' +
  'this from have has are was were not you your can will what how why when where which into than then them they there ' +
  'existe existen quiero necesito favor puede pueden pueda puedan podria podrias podemos debe deben deba debas ' +
  'hazlo haces hagas hagamos dime dame muestra'
).split(/\s+/));

function normalizeText(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// Términos que sí distinguen una consulta de otra: sin palabras vacías ni
// palabras de menos de 3 letras. Si no queda ninguno (consulta muy corta),
// se usan los términos tal cual para no devolver siempre vacío.
function significantTerms(query) {
  const all = String(query)
    .split(/\s+/)
    .map((t) => normalizeText(t).replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean);
  const strong = all.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(strong.length ? strong : all)];
}

const NOISY_TOOLS = new Set(['TodoWrite', 'ExitPlanMode']);

function summarizeToolUse(toolName, toolInput = {}, toolResponse = null) {
  if (NOISY_TOOLS.has(toolName)) return null;

  let summary;
  switch (toolName) {
    case 'Bash':
      summary = `Bash: ${toolInput.description ? toolInput.description + ' — ' : ''}${truncate(redactSecrets(toolInput.command), 200)}`;
      break;
    case 'Read':
      summary = `Read ${toolInput.file_path}`;
      break;
    case 'Write':
      summary = `Wrote ${toolInput.file_path}`;
      break;
    case 'Edit':
      summary = `Edited ${toolInput.file_path}`;
      break;
    case 'Grep':
      summary = `Searched for "${truncate(toolInput.pattern, 100)}"${toolInput.path ? ' in ' + toolInput.path : ''}`;
      break;
    case 'Glob':
      summary = `Listed files matching "${toolInput.pattern}"`;
      break;
    case 'WebFetch':
      summary = `Fetched ${toolInput.url}`;
      break;
    case 'WebSearch':
      summary = `Searched web for "${truncate(toolInput.query, 150)}"`;
      break;
    case 'Task':
    case 'Agent':
      summary = `Spawned agent: ${truncate(toolInput.description || toolInput.prompt, 200)}`;
      break;
    default: {
      const keys = Object.keys(toolInput || {}).slice(0, 3);
      const brief = keys.map((k) => `${k}=${truncate(redactSecrets(JSON.stringify(toolInput[k])), 60)}`).join(', ');
      summary = `${toolName}: ${brief}`;
    }
  }

  return truncate(stripPrivate(summary));
}

function summarizeUserPrompt(prompt) {
  const clean = stripPrivate(prompt);
  if (!clean || !clean.trim()) return null;
  return truncateMiddle(`User asked: ${clean.trim().replace(/\s+/g, ' ')}`, 400);
}

// Notas casi idénticas sobre el mismo tema (p. ej. "no tiene la variable" y
// luego "ya la tiene") se contradicen o repiten: se queda la más nueva (mayor
// id) y se descarta la anterior. Conserva el orden de entrada.
function dedupeSimilar(rows, { threshold = 0.6 } = {}) {
  const sets = rows.map((r) => new Set(significantTerms(String(r.summary).replace(/^Respuesta de \w+:\s*/, ''))));
  const jaccard = (a, b) => {
    if (a.size < 3 || b.size < 3) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  return rows.filter((row, i) =>
    !rows.some((other, j) => j !== i && other.id > row.id && jaccard(sets[i], sets[j]) >= threshold));
}

module.exports = {
  dedupeSimilar,
  summarizeToolUse,
  summarizeUserPrompt,
  stripPrivate,
  redactSecrets,
  truncate,
  truncateMiddle,
  significantTerms,
  normalizeText,
};
