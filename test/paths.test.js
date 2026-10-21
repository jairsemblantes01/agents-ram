// Compatibilidad con el nombre anterior (Claude RAM): variables y carpeta de datos.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

// lib/paths calcula las rutas al cargarse: se recarga con el entorno indicado.
function loadPaths(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../lib/paths')];
  const paths = require('../lib/paths');
  return {
    paths,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

test('env: AGENTS_RAM_* gana; CLAUDE_RAM_* sirve si es la única', () => {
  const a = loadPaths({ CLAUDE_RAM_X_TEST: 'viejo', AGENTS_RAM_X_TEST: undefined });
  assert.strictEqual(a.paths.env('X_TEST'), 'viejo');
  a.restore();

  const b = loadPaths({ CLAUDE_RAM_X_TEST: 'viejo', AGENTS_RAM_X_TEST: 'nuevo' });
  assert.strictEqual(b.paths.env('X_TEST'), 'nuevo');
  b.restore();
});

test('dataDir: usa la carpeta vieja mientras la nueva no exista', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ram-paths-'));
  const vars = { HOME: home, XDG_DATA_HOME: path.join(home, 'data'), AGENTS_RAM_DB_DIR: undefined, CLAUDE_RAM_DB_DIR: undefined };
  const dataDir = () => {
    const l = loadPaths(vars);
    try { return l.paths.dataDir(); } finally { l.restore(); }
  };

  assert.strictEqual(dataDir(), path.join(home, 'data', 'agents-ram'));
  fs.mkdirSync(path.join(home, '.claude', 'claude-ram'), { recursive: true });
  assert.strictEqual(dataDir(), path.join(home, '.claude', 'claude-ram'));
  fs.mkdirSync(path.join(home, 'data', 'agents-ram'), { recursive: true });
  assert.strictEqual(dataDir(), path.join(home, 'data', 'agents-ram'));
});
