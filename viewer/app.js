const KIND_COLORS = {
  tool_use: 'var(--tool_use)',
  user_prompt: 'var(--user_prompt)',
  session_summary: 'var(--session_summary)',
  note: 'var(--note)',
};
const KIND_LABELS = {
  tool_use: 'Herramientas',
  user_prompt: 'Prompts',
  session_summary: 'Respuestas',
  note: 'Notas',
};
const SOURCE_LABELS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const sourceLabel = (s) => SOURCE_LABELS[s] || s;

const state = { project: '', source: '', page: 0, pageSize: 40, searching: false };

const el = (sel) => document.querySelector(sel);
const feed = el('#feed');
const statusEl = el('#status');
const loadMoreBtn = el('#load-more');
const projectSelect = el('#project-select');
const sourceSelect = el('#source-select');
const searchInput = el('#search-input');

function fmtTime(iso) {
  return iso.replace('T', ' ').slice(0, 16);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderItems(rows, { append = false } = {}) {
  if (!append) feed.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = `item ${r.kind}`;
    li.innerHTML = `
      <div class="item-head">
        <span class="item-kind">${KIND_LABELS[r.kind] || r.kind}${r.tool_name ? ' · ' + escapeHtml(r.tool_name) : ''}${state.source || !r.source ? '' : `<span class="item-source">${escapeHtml(sourceLabel(r.source))}</span>`}</span>
        <span>${fmtTime(r.created_at)}</span>
      </div>
      <div class="item-summary">${escapeHtml(r.summary)}</div>
      ${state.project ? '' : `<div class="item-project">${escapeHtml(r.project_path)}</div>`}
    `;
    li.addEventListener('click', () => li.classList.toggle('expanded'));
    feed.appendChild(li);
  }
}

async function loadProjects() {
  const rows = await fetch('/api/projects').then((r) => r.json());
  for (const p of rows) {
    const opt = document.createElement('option');
    opt.value = p.project_path;
    opt.textContent = `${p.project_path} (${p.count})`;
    projectSelect.appendChild(opt);
  }
}

async function loadSources() {
  const rows = await fetch('/api/sources').then((r) => r.json());
  for (const s of rows) {
    const opt = document.createElement('option');
    opt.value = s.source;
    opt.textContent = `${sourceLabel(s.source)} (${s.count})`;
    sourceSelect.appendChild(opt);
  }
  // Con un solo cliente el filtro no aporta nada.
  sourceSelect.hidden = rows.length < 2;
}

// Proyecto y cliente seleccionados, para cualquier llamada a la API.
function filterParams(extra = {}) {
  const params = new URLSearchParams(extra);
  if (state.project) params.set('project', state.project);
  if (state.source) params.set('source', state.source);
  return params;
}

function renderChart(byDay) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const byDayMap = {};
  for (const row of byDay) {
    byDayMap[row.day] = byDayMap[row.day] || {};
    byDayMap[row.day][row.kind] = row.count;
  }
  const totals = days.map((d) => {
    const kinds = byDayMap[d] || {};
    return Object.values(kinds).reduce((a, b) => a + b, 0);
  });
  const max = Math.max(1, ...totals);

  const chart = document.createElement('div');
  chart.className = 'chart';
  days.forEach((d, i) => {
    const kinds = byDayMap[d] || {};
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.title = `${d}: ${totals[i]} observaciones`;
    col.style.height = '100%';
    for (const kind of Object.keys(KIND_COLORS)) {
      const count = kinds[kind] || 0;
      if (!count) continue;
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.background = KIND_COLORS[kind];
      seg.style.height = `${(count / max) * 100}%`;
      col.appendChild(seg);
    }
    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = d.slice(5);
    wrap.appendChild(col);
    wrap.appendChild(label);
    chart.appendChild(wrap);
  });
  return chart;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`;
}

async function loadStats() {
  const stats = await fetch(`/api/stats?${filterParams()}`).then((r) => r.json());
  const statsEl = el('#stats');
  statsEl.innerHTML = '';

  const badges = document.createElement('div');
  badges.className = 'stat-badges';
  badges.innerHTML = `
    <div class="badge badge-disk">💾 memoria total usada: <b>${formatBytes(stats.diskBytes)}</b></div>
    <div class="badge"><b>${stats.total}</b> observaciones</div>
    ${stats.byKind.map((k) => `<div class="badge"><span class="dot" style="background:${KIND_COLORS[k.kind] || '#888'}"></span> ${KIND_LABELS[k.kind] || k.kind} <b>${k.count}</b></div>`).join('')}
    ${stats.bySource.length > 1 ? stats.bySource.map((s) => `<div class="badge">${escapeHtml(sourceLabel(s.source))} <b>${s.count}</b></div>`).join('') : ''}
    <div class="badge">${stats.vecEnabled ? '🟢 búsqueda semántica activa' : '⚪ solo búsqueda por palabra clave'}</div>
  `;

  statsEl.appendChild(badges);
  statsEl.appendChild(renderChart(stats.byDay));
}

async function loadFeed({ append = false } = {}) {
  const offset = state.page * state.pageSize;
  const rows = await fetch(`/api/observations?${filterParams({ limit: state.pageSize, offset })}`).then((r) => r.json());
  renderItems(rows, { append });
  loadMoreBtn.hidden = rows.length < state.pageSize;
  statusEl.textContent = append ? '' : `Mostrando actividad reciente${state.project ? ' de ' + state.project : ' (todos los proyectos)'}${state.source ? ' · ' + sourceLabel(state.source) : ''}.`;
}

async function runSearch(query) {
  statusEl.textContent = 'Buscando…';
  const rows = await fetch(`/api/search?${filterParams({ q: query })}`).then((r) => r.json());
  loadMoreBtn.hidden = true;
  renderItems(rows);
  statusEl.textContent = rows.length
    ? `${rows.length} resultado(s) para "${query}" (búsqueda híbrida: palabra clave + semántica).`
    : `Sin resultados para "${query}".`;
}

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  searchTimer = setTimeout(() => {
    if (q) { state.searching = true; runSearch(q); }
    else { state.searching = false; state.page = 0; loadFeed(); }
  }, 300);
});

function onFilterChange() {
  state.project = projectSelect.value;
  state.source = sourceSelect.value;
  state.page = 0;
  searchInput.value = '';
  state.searching = false;
  loadStats();
  loadFeed();
}
projectSelect.addEventListener('change', onFilterChange);
sourceSelect.addEventListener('change', onFilterChange);

loadMoreBtn.addEventListener('click', () => {
  state.page += 1;
  loadFeed({ append: true });
});

(async function init() {
  await Promise.all([loadProjects(), loadSources()]);
  await loadStats();
  await loadFeed();
})();
