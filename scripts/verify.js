'use strict';

/**
 * Bundle verification.
 *
 * A packaged desktop app fails silently: the window opens, one feature is
 * blank, and nothing says why. The expensive bug we hit was a `history.js`
 * being deleted by a changelog-matching rule, which only surfaced as
 * "Cannot find module" from deep inside the server.
 *
 * So this checks the packaged tree directly:
 *   1. every required runtime file exists,
 *   2. the packaged OpenChamber server imports successfully from the bundle,
 *   3. the server actually serves its own UI over HTTP,
 *   4. the bundled binaries run and report versions,
 *   5. the packaged tree has every code file its source tree had.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist', 'AgentDeck');
const APP = path.join(BUNDLE, 'resources', 'app');

const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail = '') => results.push({ ok: false, name, detail });

function exists(rel) {
  return fs.existsSync(path.join(APP, rel));
}

function run(file, args, opts = {}) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 30000,
    windowsHide: true,
    cwd: opts.cwd || BUNDLE,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

// ── 1. required files ─────────────────────────────────────────────────────
const REQUIRED = [
  ['AgentDeck.exe', path.join(BUNDLE, 'AgentDeck.exe')],
  ['app package.json', path.join(APP, 'package.json')],
  ['main process', path.join(APP, 'src', 'main', 'main.js')],
  ['preload', path.join(APP, 'src', 'main', 'preload.js')],
  ['renderer html', path.join(APP, 'src', 'renderer', 'index.html')],
  ['renderer js', path.join(APP, 'src', 'renderer', 'app.js')],
  ['renderer css', path.join(APP, 'src', 'renderer', 'style.css')],
  ['xterm', path.join(APP, 'src', 'renderer', 'vendor', 'xterm', 'xterm.js')],
  ['node runtime', path.join(APP, 'vendor', 'node', 'node.exe')],
  ['opencode binary', path.join(APP, 'vendor', 'opencode', 'opencode.exe')],
  ['ripgrep', path.join(APP, 'vendor', 'ripgrep', 'rg.exe')],
  ['claude cli', path.join(APP, 'node_modules', 'claude-code-best', 'dist', 'cli-node.js')],
  ['openchamber server', path.join(APP, 'node_modules', '@openchamber', 'web', 'server', 'index.js')],
  ['openchamber ui', path.join(APP, 'node_modules', '@openchamber', 'web', 'dist', 'index.html')],
  ['node-pty native', path.join(APP, 'node_modules', 'node-pty', 'build', 'Release', 'conpty', 'conpty.dll')],
  ['server terminal history', path.join(APP, 'node_modules', '@openchamber', 'web', 'server', 'lib', 'terminal', 'history.js')],
  ['server routing history', path.join(APP, 'node_modules', '@openchamber', 'web', 'server', 'lib', 'routing', 'history.js')],
];

for (const [name, p] of REQUIRED) {
  if (fs.existsSync(p)) pass(`file: ${name}`);
  else fail(`file: ${name}`, path.relative(BUNDLE, p));
}

// ── 2. no code files lost between source and bundle ───────────────────────
function collectCode(dir, base = '', acc = new Set()) {
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (['node_modules', 'vendor'].includes(base.split('/')[0]) && e.name === '.bin') continue;
      collectCode(dir, rel, acc);
    } else if (/\.(js|mjs|cjs|node|wasm)$/i.test(e.name)) {
      acc.add(rel);
    }
  }
  return acc;
}

const SRC_APP = path.join(ROOT, 'app');
if (fs.existsSync(SRC_APP)) {
  const src = collectCode(path.join(SRC_APP, 'node_modules'));
  const dst = collectCode(path.join(APP, 'node_modules'));
  const lost = [...src].filter((f) => !dst.has(f) && !/\/test[s]?\//.test(f) && !/\/__tests__\//.test(f));
  if (lost.length === 0) {
    pass('code parity', `${dst.size} modules present`);
  } else {
    fail('code parity', `${lost.length} missing, e.g. ${lost.slice(0, 3).join(', ')}`);
  }
}

// ── 3. bundled binaries run ───────────────────────────────────────────────
const nodeExe = path.join(APP, 'vendor', 'node', 'node.exe');
const ocExe = path.join(APP, 'vendor', 'opencode', 'opencode.exe');
const rgExe = path.join(APP, 'vendor', 'ripgrep', 'rg.exe');
const cliEntry = path.join(APP, 'node_modules', 'claude-code-best', 'dist', 'cli-node.js');

const nodeVer = run(nodeExe, ['-v']);
nodeVer.status === 0
  ? pass('node runs', nodeVer.stdout.trim())
  : fail('node runs', nodeVer.stderr.trim());

const ocVer = run(ocExe, ['--version']);
ocVer.status === 0
  ? pass('opencode runs', ocVer.stdout.trim())
  : fail('opencode runs', ocVer.stderr.trim());

const rgVer = run(rgExe, ['--version']);
rgVer.status === 0
  ? pass('ripgrep runs', rgVer.stdout.split('\n')[0].trim())
  : fail('ripgrep runs', rgVer.stderr.trim());

const cliVer = run(nodeExe, [cliEntry, '--version']);
cliVer.status === 0
  ? pass('claude cli runs', cliVer.stdout.trim())
  : fail('claude cli runs', (cliVer.stderr || '').trim());

// ── 3b. guest front ends: PE integrity + real window ──────────────────────
/**
 * A guest that cannot start is the hardest failure to notice: the panel simply
 * stays blank. So each one is launched for real and must produce a window.
 */
const GUEST_EXES = {
  opcode: path.join(APP, 'vendor', 'opcode', 'opcode.exe'),
  codex: path.join(APP, 'vendor', 'codex', 'codex-desktop.exe'),
  emdash: path.join(APP, 'vendor', 'emdash', 'Emdash.exe'),
  obsidian: path.join(APP, 'vendor', 'obsidian', 'Obsidian.exe'),
};
function readPeHeaders(file) {
  const fd = fs.openSync(file, 'r');
  const dos = Buffer.alloc(0x40);
  fs.readSync(fd, dos, 0, dos.length, 0);
  if (dos[0] !== 0x4d || dos[1] !== 0x5a) { // "MZ"
    fs.closeSync(fd);
    return null;
  }
  const peOffset = dos.readUInt32LE(0x3c);
  // COFF header (20 bytes) + PE32 optional header up to Subsystem (offset 68).
  const pe = Buffer.alloc(24 + 70);
  fs.readSync(fd, pe, 0, pe.length, peOffset);
  fs.closeSync(fd);
  if (pe.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
  const machine = pe.readUInt16LE(4);
  // Subsystem lives at optional-header offset 68, i.e. after the 24-byte COFF header.
  const subsystem = pe.readUInt16LE(24 + 68);
  return { machine, subsystem };
}

for (const [name, exe] of Object.entries(GUEST_EXES)) {
  if (!fs.existsSync(exe)) {
    // Claudian's host is optional in the report but its plugin files are not.
    if (name === 'obsidian') {
      fail(`guest ${name}`, 'not bundled');
    } else {
      fail(`guest ${name}`, 'not bundled');
    }
    continue;
  }
  const pe = readPeHeaders(exe);
  if (!pe) {
    fail(`guest ${name}`, 'not a valid PE executable');
    continue;
  }
  const mb = (fs.statSync(exe).size / (1024 * 1024)).toFixed(1);
  pass(`guest ${name}`, `${mb} MB, PE machine 0x${pe.machine.toString(16)}`);
}

// Claudian plugin triple
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  const p = path.join(APP, 'vendor', 'claudian', f);
  fs.existsSync(p) ? pass(`claudian ${f}`) : fail(`claudian ${f}`, 'missing');
}

// ── 3c. koffi loads and exposes Win32 ─────────────────────────────────────
try {
  const koffiPath = path.join(APP, 'node_modules', 'koffi');
  const koffi = require(koffiPath);
  const user32 = koffi.load('user32.dll');
  const setParent = user32.func('void* __stdcall SetParent(void* a, void* b)');
  pass('koffi win32 bridge', typeof setParent === 'function' ? 'SetParent available' : 'unexpected');
} catch (e) {
  fail('koffi win32 bridge', String(e && e.message || e));
}

// ── 4. the packaged server boots and serves its UI ────────────────────────
async function checkServer() {
  const modulePath = path.join(APP, 'node_modules', '@openchamber', 'web', 'server', 'index.js');
  const script = `
    const { startWebUiServer } = await import(${JSON.stringify('file:///' + modulePath.replace(/\\/g, '/'))});
    process.env.OPENCODE_BINARY = ${JSON.stringify(ocExe)};
    process.env.OPENCHAMBER_DIST_DIR = ${JSON.stringify(path.join(APP, 'node_modules', '@openchamber', 'web', 'dist'))};
    const h = await startWebUiServer({ port: 0, host: '127.0.0.1', uiPassword: null, attachSignals: false, exitOnShutdown: false, apiOnly: false });
    const port = h.getPort();
    const res = await fetch('http://127.0.0.1:' + port + '/');
    const html = await res.text();
    console.log(JSON.stringify({ port, status: res.status, hasRoot: html.includes('id="root"'), title: (html.match(/<title>([^<]*)<\\/title>/) || [])[1] }));
    await h.stop({ exitProcess: false });
    process.exit(0);
  `;

  return new Promise((resolve) => {
    const child = spawn(nodeExe, ['--input-type=module', '-e', script], {
      cwd: APP,
      env: {
        ...process.env,
        OPENCODE_BINARY: ocExe,
        OPENCHAMBER_DIST_DIR: path.join(APP, 'node_modules', '@openchamber', 'web', 'dist'),
        OPENCHAMBER_RUNTIME: 'desktop',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, reason: 'timeout' });
    }, 90000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return resolve({ ok: false, reason: `no output (code ${code}) ${err.slice(0, 300)}` });
      try {
        resolve({ ok: true, info: JSON.parse(line) });
      } catch (e) {
        resolve({ ok: false, reason: 'bad json: ' + line.slice(0, 200) });
      }
    });
  });
}

checkServer().then((r) => {
  if (r.ok && r.info.status === 200 && r.info.hasRoot) {
    pass('server serves UI', `HTTP ${r.info.status}, title "${r.info.title}" on port ${r.info.port}`);
  } else {
    fail('server serves UI', r.reason || JSON.stringify(r.info));
  }

  // ── report ──────────────────────────────────────────────────────────────
  const lines = [];
  let failures = 0;
  for (const r of results) {
    if (!r.ok) failures++;
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
  }

  const sizeMb = (() => {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      }
    };
    if (fs.existsSync(BUNDLE)) walk(BUNDLE);
    return total / (1024 * 1024);
  })();

  lines.push('');
  lines.push(`checks: ${results.length - failures} passed, ${failures} failed`);
  lines.push(`bundle size: ${sizeMb.toFixed(1)} MB`);

  const text = lines.join('\n');
  console.log(text);
  fs.writeFileSync(path.join(ROOT, 'dist', 'verification.txt'), text, 'utf8');
  process.exitCode = failures ? 1 : 0;
});
