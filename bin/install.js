#!/usr/bin/env node
// Instala Agents RAM en Claude Code, Codex y Cursor: los cuatro hooks y el
// servidor MCP, con una sola base de memoria. Es idempotente y conserva el
// resto de cada archivo (deja un .bak antes de cambiarlo).
//   node bin/install.js                    todos los clientes presentes
//   node bin/install.js --client cursor    solo uno (claude | codex | cursor)
//   node bin/install.js --dry-run          muestra qué haría, sin escribir
//   node bin/install.js --uninstall        quita solo lo de Agents RAM
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  MCP_NAME, LEGACY_MCP_NAMES, MCP_SERVER, hooksFile, withHooks, withoutHooks, withCursorMcp, withCodexMcp,
  readText, readJsonFile, writeFile,
} = require('../lib/install');

const CLIENTS = ['claude', 'codex', 'cursor'];
const NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const DIRS = { claude: '.claude', codex: '.codex', cursor: '.cursor' };

function parseArgs(argv) {
  const args = { client: null, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--client') args.client = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--uninstall') args.uninstall = true;
    else throw new Error(`Opción desconocida: ${argv[i]}`);
  }
  if (args.client && !CLIENTS.includes(args.client)) throw new Error(`--client debe ser ${CLIENTS.join(' | ')}`);
  return args;
}

const home = os.homedir();
const short = (f) => f.replace(home, '~');
// Ruta absoluta de node: las apps de escritorio no suelen ver el PATH de nvm.
// En Claude Code se respeta el `node` que ya hubiera registrado.
const NODE = process.execPath;

function installHooks(client, { dryRun, uninstall }) {
  const file = hooksFile(client, home);
  const config = readJsonFile(file);
  const res = uninstall ? withoutHooks(config, client) : withHooks(config, client, client === 'claude' ? 'node' : NODE);
  const events = uninstall ? res.removed : res.added;
  const replaced = uninstall ? [] : res.replaced;
  if (events.length === 0 && replaced.length === 0) return console.log(`  - hooks: ${uninstall ? 'no había' : 'ya estaban'} (${short(file)})`);
  writeFile(file, JSON.stringify(res.config, null, 2) + '\n', { dryRun });
  if (replaced.length) console.log(`  ✓ hooks de una copia vieja quitados: ${replaced.join(', ')} (${short(file)})`);
  if (events.length) console.log(`  ✓ hooks ${uninstall ? 'quitados' : 'agregados'}: ${events.join(', ')} (${short(file)})`);
}

function installCursorMcp({ dryRun, uninstall }) {
  const file = path.join(home, '.cursor', 'mcp.json');
  const res = withCursorMcp(readJsonFile(file), NODE, { remove: uninstall });
  if (!res.changed) return console.log(`  - MCP: ${uninstall ? 'no estaba' : 'ya estaba'} (${short(file)})`);
  writeFile(file, JSON.stringify(res.config, null, 2) + '\n', { dryRun });
  console.log(`  ✓ MCP ${uninstall ? 'quitado' : 'registrado'} (${short(file)})`);
}

function installCodexMcp({ dryRun, uninstall }) {
  const file = path.join(home, '.codex', 'config.toml');
  const res = withCodexMcp(readText(file), NODE, { remove: uninstall });
  if (!res.changed) return console.log(`  - MCP: ${uninstall ? 'no estaba' : 'ya estaba'} (${short(file)})`);
  writeFile(file, res.text, { dryRun });
  console.log(`  ✓ MCP ${uninstall ? 'quitado' : 'registrado'} (${short(file)})`);
}

// ~/.claude.json es grande y Claude Code lo reescribe en vivo: mejor su propio CLI.
function installClaudeMcp({ dryRun, uninstall }) {
  const claude = (...a) => spawnSync('claude', a, { encoding: 'utf-8' });
  const probe = claude('mcp', 'get', MCP_NAME);
  if (probe.error) return console.log(`  ! MCP: no encontré el comando \`claude\`; regístralo con: claude mcp add --scope user ${MCP_NAME} -- node ${MCP_SERVER}`);
  for (const legacy of LEGACY_MCP_NAMES) {
    if (claude('mcp', 'get', legacy).status !== 0) continue;
    if (!dryRun) claude('mcp', 'remove', legacy, '-s', 'user');
    console.log(`  ✓ MCP con el nombre viejo quitado: ${legacy} (claude mcp)`);
  }
  const present = probe.status === 0;
  if (present !== uninstall) return console.log(`  - MCP: ${uninstall ? 'no estaba' : 'ya estaba'} (claude mcp)`);
  if (!dryRun) {
    const r = uninstall
      ? claude('mcp', 'remove', MCP_NAME, '-s', 'user')
      : claude('mcp', 'add', '--scope', 'user', MCP_NAME, '--', 'node', MCP_SERVER);
    if (r.status !== 0) return console.log(`  ! MCP: claude mcp falló: ${(r.stderr || r.stdout).trim()}`);
  }
  console.log(`  ✓ MCP ${uninstall ? 'quitado' : 'registrado'} (claude mcp, alcance user)`);
}

function run(args) {
  // Sin --client: Claude Code siempre, Codex y Cursor solo si están instalados.
  const targets = args.client ? [args.client] : CLIENTS.filter((c) => c === 'claude' || fs.existsSync(path.join(home, DIRS[c])));
  console.log(`Agents RAM · ${args.uninstall ? 'desinstalar' : 'instalar'}${args.dryRun ? ' (simulación, no se escribe nada)' : ''}`);
  for (const client of targets) {
    console.log(`\n${NAMES[client]}`);
    installHooks(client, args);
    ({ claude: installClaudeMcp, codex: installCodexMcp, cursor: installCursorMcp })[client](args);
  }
  const notes = [];
  if (targets.includes('codex') && !args.uninstall) notes.push('Codex: ejecuta /hooks una vez para aprobar los hooks nuevos.');
  notes.push('Reinicia los clientes para que carguen los cambios. `node bin/doctor.js` revisa que todo quedó bien.');
  console.log(`\n${notes.join('\n')}`);
}

try {
  run(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
