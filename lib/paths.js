// Nombres y rutas compartidos. El proyecto se llamó Claude RAM: las variables
// CLAUDE_RAM_* y la carpeta ~/.claude/claude-ram siguen funcionando para que
// una instalación vieja no pierda su memoria al actualizar.
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();

// AGENTS_RAM_<name>, o CLAUDE_RAM_<name> si solo existe la variable vieja.
function env(name) {
  return process.env[`AGENTS_RAM_${name}`] ?? process.env[`CLAUDE_RAM_${name}`];
}

const LEGACY_DATA_DIR = path.join(home, '.claude', 'claude-ram');
const DEFAULT_DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'agents-ram');

// Mientras no se haya migrado (la nueva no existe y la vieja sí), se usa la vieja.
function dataDir() {
  const fromEnv = env('DB_DIR');
  if (fromEnv) return fromEnv;
  if (!fs.existsSync(DEFAULT_DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) return LEGACY_DATA_DIR;
  return DEFAULT_DATA_DIR;
}

module.exports = { env, dataDir, DEFAULT_DATA_DIR, LEGACY_DATA_DIR };
