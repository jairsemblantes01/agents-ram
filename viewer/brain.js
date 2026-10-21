// Vista "Cerebro": cada memoria (prompt o respuesta) es una neurona; se unen
// por similitud semántica (embeddings) y por pertenecer a la misma sesión.
// Layout de fuerzas en 3D calculado aquí mismo, sin librerías ni red.
(function () {
  const $ = (s) => document.querySelector(s);
  const canvas = $('#brain-canvas');
  const ctx = canvas.getContext('2d');
  const tip = $('#brain-tip');
  const detail = $('#brain-detail');
  const hud = $('#brain-hud');
  const legend = $('#brain-legend');
  const refreshBtn = $('#brain-refresh');

  let nodes = [];
  let edges = [];
  let byId = new Map();
  let loaded = false;
  let loadedTotal = null;
  let alpha = 0;
  let w = 0;
  let h = 0;
  let dpr = 1;
  const cam = { yaw: 0.4, pitch: 0.25, zoom: 0.8, auto: true };
  const view = { focusProject: '', hits: null, hover: null, selected: null };
  const palette = new Map();

  const hueOf = (name) => {
    let x = 0;
    for (let i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) >>> 0;
    return x % 360;
  };
  const colorOf = (n, a = 1) => `hsla(${palette.get(n.project)}, 80%, ${n.kind === 'session_summary' ? 66 : 58}%, ${a})`;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- Layout -----------------------------------------------------------
  function initLayout() {
    // Elipsoide más ancho que alto, como un cerebro visto de lado.
    nodes.forEach((n) => {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = 140 * Math.cbrt(Math.random());
      const s = Math.sqrt(1 - u * u);
      n.x = r * s * Math.cos(t) * 1.3;
      n.y = r * u * 0.8;
      n.z = r * s * Math.sin(t);
      n.vx = n.vy = n.vz = 0;
    });
    alpha = 1;
  }

  function tick() {
    const N = nodes.length;
    const rep = 900;
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz + 0.01;
        if (d2 > 160000) continue;
        const f = (rep / d2) * alpha;
        const inv = 1 / Math.sqrt(d2);
        dx *= inv; dy *= inv; dz *= inv;
        a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
        b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
      }
    }
    for (const e of edges) {
      const a = e.na, b = e.nb;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      const rest = e.type === 'session' ? 38 : 26 + (1 - e.w) * 90;
      const k = (e.type === 'session' ? 0.02 : 0.05 + e.w * 0.05) * alpha;
      const f = (d - rest) * k / d;
      a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
      b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
    }
    for (const n of nodes) {
      // Gravedad anisotrópica: mantiene la forma de elipsoide.
      n.vx -= n.x * 0.004 * alpha;
      n.vy -= n.y * 0.009 * alpha;
      n.vz -= n.z * 0.006 * alpha;
      n.vx *= 0.82; n.vy *= 0.82; n.vz *= 0.82;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
    }
    alpha *= 0.985;
  }

  // ---- Render -----------------------------------------------------------
  function project(n, cy, sy, cp, sp) {
    const x1 = n.x * cy - n.z * sy;
    const z1 = n.x * sy + n.z * cy;
    const y2 = n.y * cp - z1 * sp;
    const z2 = n.y * sp + z1 * cp;
    const persp = 520 / Math.max(80, 520 + z2);
    const sc = persp * cam.zoom * Math.min(w, h) / 420;
    n.sx = w / 2 + x1 * sc;
    n.sy = h / 2 + y2 * sc;
    n.sz = z2;
    n.sc = sc;
  }

  const isDim = (n) => {
    if (view.hits) return !view.hits.has(n.id);
    if (view.focusProject) return n.project !== view.focusProject;
    return false;
  };

  function render(time) {
    ctx.clearRect(0, 0, w, h);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    for (const n of nodes) project(n, cy, sy, cp, sp);

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    for (const e of edges) {
      const a = e.na, b = e.nb;
      const lit = view.selected && (a === view.selected || b === view.selected);
      const dim = isDim(a) || isDim(b);
      const depth = Math.max(0.15, Math.min(1, 1 - (a.sz + b.sz) / 900));
      const base = e.type === 'session' ? 0.12 : 0.22;
      const alphaE = lit ? 0.8 : dim ? 0.015 : base * depth;
      ctx.strokeStyle = lit ? 'rgba(160,200,255,' + alphaE + ')' : 'rgba(120,150,210,' + alphaE + ')';
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }

    const order = nodes.slice().sort((p, q) => q.sz - p.sz);
    const pulse = 0.5 + 0.5 * Math.sin(time / 400);
    for (const n of order) {
      const dim = isDim(n);
      const depth = Math.max(0.3, Math.min(1, 1 - n.sz / 700));
      const hit = view.hits && view.hits.has(n.id);
      let r = (n.kind === 'session_summary' ? 1.9 : 1.4) + Math.min(n.deg, 8) * 0.15;
      r = Math.max(0.6, r * n.sc);
      if (hit) r *= 1.6 + pulse * 0.5;
      if (n === view.hover || n === view.selected) r *= 1.6;
      const a = dim ? 0.1 : depth;
      const g = ctx.createRadialGradient(n.sx, n.sy, 0, n.sx, n.sy, r * 3);
      g.addColorStop(0, colorOf(n, a));
      g.addColorStop(0.35, colorOf(n, a * 0.45));
      g.addColorStop(1, colorOf(n, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(time) {
    requestAnimationFrame(frame);
    if ($('#brain-view').hidden || !loaded) return;
    if (alpha > 0.02) { tick(); tick(); }
    if (cam.auto && !drag.active) cam.yaw += 0.0012;
    render(time);
  }

  // ---- Interacción ------------------------------------------------------
  const drag = { active: false, moved: false, x: 0, y: 0 };

  function pick(mx, my) {
    let best = null;
    let bestD = 14 * 14;
    for (const n of nodes) {
      if (isDim(n)) continue;
      const d = (n.sx - mx) ** 2 + (n.sy - my) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    drag.active = true; drag.moved = false; drag.x = ev.clientX; drag.y = ev.clientY;
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    if (drag.active) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      cam.yaw += dx * 0.006;
      cam.pitch = Math.max(-1.4, Math.min(1.4, cam.pitch + dy * 0.006));
      drag.x = ev.clientX; drag.y = ev.clientY;
      tip.hidden = true;
      return;
    }
    const n = pick(mx, my);
    view.hover = n;
    if (n) {
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(n.project)}</b> · ${kindLabel(n)} · ${n.t.slice(0, 16)}<br>${esc(n.text.slice(0, 200))}`;
      tip.style.left = Math.min(mx + 14, w - 350) + 'px';
      tip.style.top = Math.min(my + 14, h - 90) + 'px';
    } else {
      tip.hidden = true;
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    drag.active = false;
    canvas.classList.remove('dragging');
    if (drag.moved) return;
    const rect = canvas.getBoundingClientRect();
    const n = pick(ev.clientX - rect.left, ev.clientY - rect.top);
    select(n);
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    cam.zoom = Math.max(0.4, Math.min(4, cam.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { cam.auto = !cam.auto; });

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kindLabel = (n) => ({ session_summary: 'respuesta', note: 'nota' }[n.kind] || 'prompt');

  function select(n) {
    view.selected = n;
    if (!n) { detail.hidden = true; return; }
    // El texto de nodo viene truncado; el detalle completo sale del feed.
    const neighbors = edges
      .filter((e) => e.na === n || e.nb === n)
      .map((e) => (e.na === n ? e.nb : e.na))
      .slice(0, 6);
    detail.hidden = false;
    detail.innerHTML = `<button class="close" aria-label="Cerrar">×</button>
      <h3>${esc(n.project)} · ${kindLabel(n)}</h3>
      <div class="meta">${n.t.slice(0, 16)} · ${n.deg} conexiones · sesión ${esc(n.session.slice(0, 8))}${n.source ? ' · ' + esc(n.source) : ''}</div>
      ${esc(n.text)}
      ${neighbors.length ? `<hr><div class="meta">Relacionadas:</div>${neighbors.map((m) => `<p><b>${esc(m.project)}</b> · ${kindLabel(m)}<br>${esc(m.text.slice(0, 140))}</p>`).join('')}` : ''}`;
    detail.querySelector('.close').addEventListener('click', () => select(null));
  }

  // ---- Datos ------------------------------------------------------------
  function renderLegend() {
    const counts = new Map();
    nodes.forEach((n) => counts.set(n.project, (counts.get(n.project) || 0) + 1));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    legend.innerHTML = '';
    for (const [name, c] of top) {
      const b = document.createElement('button');
      b.className = view.focusProject === name ? 'on' : '';
      b.innerHTML = `<span class="dot" style="background:hsl(${palette.get(name)},80%,60%)"></span>${esc(name)} <span style="color:var(--muted)">${c}</span>`;
      b.addEventListener('click', () => {
        view.focusProject = view.focusProject === name ? '' : name;
        renderLegend();
      });
      legend.appendChild(b);
    }
  }

  // Solo prompts y respuestas son neuronas; los tool_use no deben disparar el aviso.
  // Proyecto y cliente elegidos arriba: el Cerebro sigue los mismos filtros que el feed.
  function filterParams(extra = {}) {
    const params = new URLSearchParams(extra);
    const project = $('#project-select').value;
    const source = $('#source-select').value;
    if (project) params.set('project', project);
    if (source) params.set('source', source);
    return params;
  }

  async function memoryCount() {
    const { byKind } = await fetch(`/api/stats?${filterParams()}`).then((r) => r.json());
    return byKind.filter((k) => k.kind !== 'tool_use').reduce((sum, k) => sum + k.count, 0);
  }

  async function load() {
    hud.textContent = 'Cargando neuronas…';
    const g = await fetch(`/api/graph?${filterParams()}`).then((r) => r.json());
    nodes = g.nodes;
    byId = new Map(nodes.map((n) => [n.id, n]));
    edges = g.edges.map((e) => ({ ...e, na: byId.get(e.a), nb: byId.get(e.b) })).filter((e) => e.na && e.nb);
    palette.clear();
    nodes.forEach((n) => { if (!palette.has(n.project)) palette.set(n.project, hueOf(n.project)); });
    view.hits = null; view.hover = null; view.selected = null; view.focusProject = '';
    detail.hidden = true;
    refreshBtn.hidden = true;
    initLayout();
    renderLegend();
    loaded = true;
    loadedTotal = await memoryCount();
    hud.innerHTML = nodes.length
      ? `${nodes.length} neuronas · ${edges.length} sinapsis<br>arrastra para girar · rueda para acercar · doble clic pausa el giro`
      : 'Sin memorias con vector todavía (¿está Ollama activo? prueba <code>node bin/backfill-embeddings.js</code>).';
  }

  async function highlight(q) {
    if (!q) { view.hits = null; return; }
    const rows = await fetch(`/api/search?${filterParams({ q })}`).then((r) => r.json());
    view.hits = new Set(rows.map((r) => r.id));
    // Las búsquedas también devuelven tool_use, que no son nodos: si ninguna
    // neurona coincide, no atenuar todo el grafo.
    if (![...view.hits].some((id) => byId.has(id))) view.hits = null;
  }

  let searchTimer = null;
  $('#search-input').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    const q = ev.target.value.trim();
    searchTimer = setTimeout(() => { if (loaded) highlight(q); }, 350);
  });
  for (const sel of ['#project-select', '#source-select']) {
    $(sel).addEventListener('change', () => {
      if (!$('#brain-view').hidden) load();
      else loaded = false;
    });
  }

  // Aviso de memorias nuevas mientras la pestaña está abierta.
  setInterval(async () => {
    if ($('#brain-view').hidden || !loaded) return;
    try {
      const total = await memoryCount();
      if (loadedTotal !== null && total !== loadedTotal) refreshBtn.hidden = false;
    } catch { /* servidor caído: se reintenta en el siguiente ciclo */ }
  }, 20000);
  refreshBtn.addEventListener('click', load);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== tab.dataset.view; });
      if (tab.dataset.view === 'brain-view') {
        resize();
        if (!loaded) load();
      }
    });
  });

  window.addEventListener('resize', () => { if (!$('#brain-view').hidden) resize(); });
  requestAnimationFrame(frame);
})();
