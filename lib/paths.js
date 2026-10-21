// Rutas y variables de entorno compartidas.
const os = require('os');
const path = require('path');

// Variables de entorno del proyecto: AGENTS_RAM_<name>.
function env(name) {
  return process.env[`AGENTS_RAM_${name}`];
}

function dataDir() {
  return env('DB_DIR') || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'agents-ram');
}

module.exports = { env, dataDir };
