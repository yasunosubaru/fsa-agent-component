'use strict';

/**
 * AgentDeck — main process.
 *
 * Two agents in one window:
 *   • OpenChamber  — the real @openchamber/web server runs in-process and its
 *                    own built UI is shown in a WebContentsView, byte for byte
 *                    the shipped front end.
 *   • Claude Code  — the real claude-code-best CLI runs in a ConPTY and its
 *                    Ink TUI is painted by xterm.js, so the terminal UI is the
 *                    genuine one.
 *
 * Everything is bundled: the OpenCode binary, the Claude Code build and
 * ripgrep all live under vendor/. No npm install, no PATH lookup at runtime.
 */

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(APP_ROOT, 'vendor');
/** `pkgRoot('@openchamber/web')` or `pkgRoot('node-pty')`. */
const pkgRoot = (...segments) => path.join(APP_ROOT, 'node_modules', ...segments.flatMap((s) => s.split('/')));

// guest front ends resolve their paths against the app root; the module reads
// this instead of recomputing it from __dirname.
globalThis.__AGENTDECK_ROOT__ = APP_ROOT;

// ── product identity ──────────────────────────────────────────────────────
app.setName('AgentDeck');
const APP_ID = 'dev.agentdeck.desktop';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const isDev = process.argv.includes('--dev');

// Keep every byte of state inside the app's own userData folder.
const USER_DATA = app.getPath('userData');
const STATE_FILE = path.join(USER_DATA, 'agentdeck-state.json');
const LOG_FILE = path.join(USER_DATA, 'agentdeck.log');

/**
 * A tiny rolling log. Startup problems in a packaged desktop app are otherwise
 * invisible: no console, no stderr anyone reads. Every failure path writes here
 * and Settings shows the tail.
 */
function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    /* logging must never break the app */
  }
  if (isDev) process.stdout.write(line);
}

// ── tiny persisted settings ───────────────────────────────────────────────
const DEFAULT_STATE = {
  claudeCwd: os.homedir(),
  claudeModel: '',
  theme: 'system',
  lastView: 'openchamber',
  // A provider Claude Code reaches through the protocol translator. Null means it
  // talks to its normal Anthropic endpoint, exactly as before.
  claudeProvider: null,
  // The sandbox the agent runs in, once one has been prepared. Empty means none
  // has been created yet.
  sandboxName: '',
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(patch) {
  try {
    const next = { ...readState(), ...patch };
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return readState();
  }
}

// ── vendor binary resolution ──────────────────────────────────────────────
/**
 * Every bundled executable is looked up relative to the app, never on PATH.
 * A missing piece is reported by name instead of failing somewhere deep in a
 * child process.
 */
function resolveOpenCodeBinary() {
  const candidates = [
    path.join(VENDOR, 'opencode', 'opencode.exe'),
    path.join(VENDOR, 'opencode', 'opencode'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
function resolveClaudeEntry() {
  const local = path.join(pkgRoot('claude-code-best'), 'dist', 'cli-node.js');
  if (fs.existsSync(local)) return local;
  return null;
}

function resolveRipgrep() {
  const win = path.join(VENDOR, 'ripgrep', 'rg.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(VENDOR, 'ripgrep', 'rg');
  if (fs.existsSync(nix)) return nix;
  return null;
}

/**
 * The interpreter for the Claude Code CLI.
 *
 * electron.exe can be told to run as Node, but under a ConPTY it attaches to
 * the pseudo-console wrongly: the child produces zero bytes and exits, so the
 * Ink UI never paints. A real node.exe writes to the pty correctly. The
 * bundled runtime is therefore a plain Node binary, not the app's own exe.
 */
function resolveNodeRuntime() {
  const win = path.join(VENDOR, 'node', 'node.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(VENDOR, 'node', 'bin', 'node');
  if (fs.existsSync(nix)) return nix;
  const plain = path.join(VENDOR, 'node', 'node');
  if (fs.existsSync(plain)) return plain;
  // Last resort only: the app's own executable in Node mode. Kept for
  // completeness, but the pty path above is the one that works.
  return process.execPath;
}

/**
 * Claude Code looks for a vendored ripgrep inside its own dist tree. When the
 * published tarball ships one for the wrong platform (or none), drop our
 * bundled copy where it expects it before the first spawn.
 */
function ensureClaudeRipgrep() {
  const rg = resolveRipgrep();
  const claudeRoot = path.join(pkgRoot('claude-code-best'), 'dist');
  if (!rg || !fs.existsSync(claudeRoot)) return;
  const dirName = process.arch === 'x64' ? 'x64-win32' : `${process.arch}-win32`;
  const targetDir = path.join(claudeRoot, 'vendor', 'ripgrep', dirName);
  const target = path.join(targetDir, 'rg.exe');
  try {
    if (fs.existsSync(target)) return;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(rg, target);
  } catch {
    // A read-only bundle still works: Claude Code falls back to a system rg.
  }
}

/**
 * Turn off OpenChamber's OpenCode update prompt before the server reads it.
 *
 * The bundle pins one OpenCode build; following that prompt would try to swap
 * the bundled binary for a downloaded one.
 *
 * The setting lives in `preferences.json`, whose format is versioned:
 *   { version: 1, fields: { <key>: { value, updatedAt } } }
 * A flat `{ key: value }` document fails the parser and is silently dropped, so
 * this writes the real shape. An existing entry is left alone.
 */
function seedAgentPreferences(chamberData) {
  const file = path.join(chamberData, 'preferences.json');
  const KEY = 'showOpenCodeUpdateNotifications';
  try {
    fs.mkdirSync(chamberData, { recursive: true });
    let doc = { version: 1, fields: {} };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.version === 1 && parsed.fields && typeof parsed.fields === 'object') {
          doc = parsed;
        }
      } catch {
        // A corrupt file is replaced: its only content here is one boolean.
      }
    }
    const current = doc.fields[KEY];
    if (current && current.value === false) return;
    doc.fields[KEY] = { value: false, updatedAt: Date.now() };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    logLine('prefs: update prompt disabled in', file);
  } catch (e) {
    logLine('prefs: could not seed', file, e.message);
  }
}

// ── windows / views ───────────────────────────────────────────────────────
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {WebContentsView | null} */
let openChamberView = null;
let serverHandle = null;
let serverUrl = '';
let serverError = '';

const guests = require('./guests.js')({
  appRoot: APP_ROOT,
  userData: USER_DATA,
  log: logLine,
  getMainWindow: () => mainWindow,
});

// Protocol translator for providers that refuse open models on their Anthropic
// endpoint. Only started when a provider is configured for it; see shim.js.
const shim = require('./shim.js')({
  appRoot: APP_ROOT,
  userData: USER_DATA,
  log: logLine,
});

// Docker Sandboxes, bundled. Reports readiness (virtualization, daemon, account)
// rather than promising isolation it cannot deliver; see sandbox.js.
const sandbox = require('./sandbox.js')({
  appRoot: APP_ROOT,
  log: logLine,
});

/**
 * The image every agent sandbox is built from.
 *
 * `fsa-toolchain:v6` is the kit prepared for this app: gcc/clang, Go, Rust, Java,
 * Node, Python with the scientific stack, TeX Live, and Chromium, all offline.
 * Naming it explicitly keeps a first run from trying to pull anything.
 */
const SANDBOX_TEMPLATE = 'docker.io/library/fsa-toolchain:v6';

/**
 * The record of every command the agents run, with proof of where it ran.
 *
 * Wired here rather than inside sandbox.js because the log spans more than the
 * sandbox module: it is the audit trail for all three agents.
 */
const commandLog = require('./cmdlog.js')({
  bin: path.join(APP_ROOT, 'vendor', 'sbx', 'bin', 'sbx.exe'),
  logFile: path.join(USER_DATA, 'sandbox-commands.jsonl'),
  log: logLine,
});

/** The customisation surface: MCP definitions projected into each app's format. */
const customize = require('./customize.js');

/**
 * The command recorder installed inside a sandbox.
 *
 * The command log only knows what AgentDeck asks for; an agent spawning its own
 * commands is invisible to it. This closes that gap by putting a recording shim in
 * front of every binary in the image, which costs one extra exec per command —
 * measured at about 3.5 ms, against strace's per-syscall trap.
 */
const shimfarm = require('./shimfarm.js')({ log: logLine });

const NAV_WIDTH = 74;
const TITLEBAR_HEIGHT = 31;

// Live bounds of the content area, reported by the renderer so the native view
// lines up with the CSS grid at any zoom or DPI.
let contentBounds = { x: NAV_WIDTH, y: TITLEBAR_HEIGHT, width: 0, height: 0 };

function applyViewBounds() {
  if (!openChamberView || !mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  const b = {
    x: Math.round(contentBounds.x || NAV_WIDTH),
    y: Math.round(contentBounds.y || TITLEBAR_HEIGHT),
    width: Math.max(0, Math.round(contentBounds.width || width - NAV_WIDTH)),
    height: Math.max(0, Math.round(contentBounds.height || height - TITLEBAR_HEIGHT)),
  };
  openChamberView.setBounds(b);
}

function createMainWindow() {
  const state = readState();

  // Size the window to the screen instead of a fixed number.
  //
  // Electron's width/height are DIP, and workAreaSize is DIP too, so the two are
  // directly comparable. The earlier mistake was assuming they were physical
  // pixels: at 150% a "1280" window is 1920 physical on a 1707 physical screen,
  // so its right edge fell off the display and clipped the third card column.
  const display = screen.getPrimaryDisplay();
  const work = display.workAreaSize; // DIP, the same unit as width/height
  const margin = 24;
  const width = Math.max(880, Math.min(1280, work.width - margin));
  const height = Math.max(600, Math.min(840, work.height - margin));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(880, width),
    minHeight: Math.min(560, height),
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Same chrome treatment as the reference app: white strip, dark glyphs.
    titleBarOverlay: { color: '#ffffff', symbolColor: '#18181b', height: TITLEBAR_HEIGHT },
    backgroundColor: '#ffffff',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    title: 'AgentDeck',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('resize', applyViewBounds);
  mainWindow.on('maximize', () => setTimeout(applyViewBounds, 30));
  mainWindow.on('unmaximize', () => setTimeout(applyViewBounds, 30));
  mainWindow.on('enter-full-screen', () => setTimeout(applyViewBounds, 60));
  mainWindow.on('leave-full-screen', () => setTimeout(applyViewBounds, 60));

  mainWindow.on('closed', () => {
    mainWindow = null;
    openChamberView = null;
  });

  // The shell never navigates; links open in the user's browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('deck:state', readState());
    mainWindow.webContents.send('deck:server-status', serverStatusPayload());
    sendEnvironmentReport();
  });

  return mainWindow;
}

function createOpenChamberView() {
  if (!mainWindow || !serverUrl) return;
  if (openChamberView) return;

  openChamberView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A dedicated partition keeps the agent UI's storage separate from the
      // shell's, so theme and session data cannot collide.
      partition: 'persist:agentdeck-agent',
      // The agent UI animates continuously; keep painting off the main thread.
      backgroundThrottling: true,
    },
  });

  openChamberView.setBackgroundColor('#151313');
  mainWindow.contentView.addChildView(openChamberView);
  openChamberView.setVisible(false);
  applyViewBounds();

  openChamberView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  openChamberView.webContents.on('did-fail-load', (_e, code, desc) => {
    serverError = `load ${code} ${desc}`;
    logLine('view: did-fail-load', serverError);
    if (mainWindow) mainWindow.webContents.send('deck:server-status', serverStatusPayload());
  });

  openChamberView.webContents.on('did-finish-load', () => {
    logLine('view: did-finish-load url=', openChamberView.webContents.getURL(),
      'title=', openChamberView.webContents.getTitle());
  });

  openChamberView.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logLine('view console:', message);
  });

  openChamberView.webContents.loadURL(serverUrl).catch((e) => {
    serverError = String(e && e.message ? e.message : e);
    logLine('view: loadURL rejected', serverError);
    if (mainWindow) mainWindow.webContents.send('deck:server-status', serverStatusPayload());
  });
}

function setViewVisible(visible) {
  if (!openChamberView) return;
  openChamberView.setVisible(Boolean(visible));
  if (visible) applyViewBounds();
}

function serverStatusPayload() {
  return {
    ready: Boolean(serverUrl) && Boolean(serverHandle),
    url: serverUrl,
    error: serverError,
  };
}

// ── agent server ──────────────────────────────────────────────────────────
/**
 * Boot the real OpenChamber server inside this process. It spawns the bundled
 * OpenCode binary itself; we only tell it where that binary is.
 */
async function startAgentServer() {
  const opencodeBinary = resolveOpenCodeBinary();
  const distDir = path.join(pkgRoot('@openchamber', 'web'), 'dist');
  const serverEntry = path.join(pkgRoot('@openchamber', 'web'), 'server', 'index.js');

  logLine('server: resolving', `entry=${serverEntry}`, `exists=${fs.existsSync(serverEntry)}`,
    `opencode=${opencodeBinary || 'MISSING'}`, `dist=${distDir}`);

  if (!fs.existsSync(serverEntry)) {
    serverError = 'OpenChamber server files are missing from the bundle.';
    logLine('server: FAILED -', serverError);
    return;
  }
  if (!opencodeBinary) {
    serverError = 'Bundled OpenCode binary is missing from vendor/opencode.';
    logLine('server: FAILED -', serverError);
    return;
  }

  const state = readState();

  process.env.OPENCODE_BINARY = opencodeBinary;
  process.env.OPENCHAMBER_RUNTIME = 'desktop';
  process.env.OPENCHAMBER_DIST_DIR = distDir;
  process.env.OPENCHAMBER_OPENCODE_CWD = state.claudeCwd || os.homedir();
  process.env.OPENCHAMBER_SKIP_API_COMPRESSION = 'true';
  // This is a self-contained bundle: the agent runtime must never replace
  // itself from the network. OpenCode reads this flag before offering or
  // performing any self-update.
  process.env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1';
  process.env.no_proxy = process.env.no_proxy || 'localhost,127.0.0.1';

  // Keep OpenCode's state inside our own data folder.
  //
  // Two stores matter, and they are red by different variables:
  //   • OpenCode follows the XDG layout, so without redirection it reads (and
  //     writes) the user's real ~/.local/share/opencode.
  //   • OpenChamber keeps its own settings and project list under
  //     ~/.config/openchamber unless OPENCHAMBER_DATA_DIR says otherwise, and
  //     that is what made the panel show the host machine's projects.
  const agentHome = path.join(USER_DATA, 'agent-home');
  const xdg = {
    XDG_DATA_HOME: path.join(agentHome, 'data'),
    XDG_CONFIG_HOME: path.join(agentHome, 'config'),
    XDG_CACHE_HOME: path.join(agentHome, 'cache'),
    XDG_STATE_HOME: path.join(agentHome, 'state'),
  };
  for (const [key, dir] of Object.entries(xdg)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* a read-only userData still leaves the env set */ }
    process.env[key] = dir;
  }
  process.env.OPENCODE_CONFIG_DIR = path.join(xdg.XDG_CONFIG_HOME, 'opencode');
  // OpenChamber's own data root: settings, projects, chats, themes, secrets.
  const chamberData = path.join(USER_DATA, 'chamber');
  try {
    fs.mkdirSync(chamberData, { recursive: true });
  } catch { /* reported by the server below */ }
  process.env.OPENCHAMBER_DATA_DIR = chamberData;
  logLine('server: agent home', agentHome, '| chamber data', chamberData);

  // The bundle ships one fixed OpenCode build, so OpenChamber's "an update is
  // available" prompt is noise at best and misleading at worst: following it
  // would try to replace the bundled binary from the network. Its preference
  // defaults to on, so it is written off before the server first reads it.
  seedAgentPreferences(chamberData);

  try {
    logLine('server: importing module');
    const mod = await import(require('node:url').pathToFileURL(serverEntry).href);
    logLine('server: module loaded, exporting', Object.keys(mod).join(','));
    serverHandle = await mod.startWebUiServer({
      port: 0,
      host: '127.0.0.1',
      uiPassword: null,
      attachSignals: false,
      exitOnShutdown: false,
      apiOnly: false,
    });
    const port = serverHandle.getPort();
    serverUrl = `http://127.0.0.1:${port}`;
    logLine('server: listening on', serverUrl);
  } catch (e) {
    serverError = String(e && e.message ? e.message : e);
    logLine('server: CRASHED -', serverError);
    logLine('server: stack -', String(e && e.stack ? e.stack : '').split('\n').slice(0, 8).join(' | '));
    return;
  }

  createOpenChamberView();
  if (mainWindow) mainWindow.webContents.send('deck:server-status', serverStatusPayload());
}

// ── Claude Code terminal ──────────────────────────────────────────────────
let ptyProcess = null;

function claudePtys() {
  if (ptyProcess) return ptyProcess;
  return null;
}

/**
 * Start the protocol translator for the configured provider.
 *
 * Split out of the spawn path so the same rules apply to the IPC handler that
 * lets the settings panel test a provider before switching to it.
 *
 * The upstream is the provider's own root URL; the shim appends
 * `/chat/completions`. A model must be pinned: the CLI rewrites the model name to
 * a Claude one, which an upstream serving open models would reject.
 */
async function startShimForProvider(cfg) {
  return shim.start({
    upstream: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    proxy: cfg.proxy || '',
  });
}

ipcMain.handle('claude:start', async (event, opts = {}) => startClaudePty(event, opts));

ipcMain.on('claude:write', (_e, data) => {
  const p = claudePtys();
  if (p && typeof data === 'string') {
    try { p.write(data); } catch { /* session already gone */ }
  }
});

ipcMain.on('claude:resize', (_e, size = {}) => {
  const p = claudePtys();
  if (!p) return;
  const cols = Math.max(20, Math.round(Number(size.cols) || 120));
  const rows = Math.max(5, Math.round(Number(size.rows) || 34));
  try { p.resize(cols, rows); } catch { /* ignores sizes while exiting */ }
});

ipcMain.handle('claude:stop', () => {
  stopClaudePty();
  return { ok: true };
});

/**
 * All Claude spawn logic lives in one function so a restart reuses the exact
 * same startup path (interpreter, env, ripgrep placement) as the first launch.
 */async function startClaudePty(event, opts = {}) {
  const entry = resolveClaudeEntry();
  if (!entry) return { ok: false, error: 'Claude Code build is missing from the bundle.' };
  if (ptyProcess) return { ok: true, reused: true };

  ensureClaudeRipgrep();

  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    return { ok: false, error: `Terminal backend unavailable: ${e.message}` };
  }

  const state = readState();
  const cwd = opts.cwd || state.claudeCwd || os.homedir();
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    /* fall back to home below */
  }
  const effectiveCwd = fs.existsSync(cwd) ? cwd : os.homedir();

  const cols = Math.max(20, Number(opts.cols) || 120);
  const rows = Math.max(5, Number(opts.rows) || 34);
  logLine('claude: starting', `entry=${entry}`, `cwd=${effectiveCwd}`, `${cols}x${rows}`);

  const env = { ...process.env };
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.FORCE_COLOR = '3';
  // The CLI needs a plain Node interpreter and a clean Node environment: an
  // inherited ELECTRON_RUN_AS_NODE or NODE_OPTIONS would leak the host shell.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_CHANNEL_FD;
  env.USE_BUILTIN_RIPGREP = env.USE_BUILTIN_RIPGREP || '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';

  // A provider routed through the protocol translator.
  //
  // Claude Code only speaks the Anthropic wire. When the configured provider
  // refuses open models there (commandcode does: "must be called via
  // /provider/v1/messages"), the request has to go through the shim. The CLI also
  // rewrites the model name to a Claude one, so the model is pinned to the
  // upstream's own id — otherwise the upstream rejects the name it receives.
  const providerCfg = readState().claudeProvider;
  if (providerCfg && providerCfg.enabled && providerCfg.baseUrl && providerCfg.apiKey && providerCfg.model) {
    const started = await startShimForProvider(providerCfg);
    if (started.ok) {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${started.port}`;
      env.ANTHROPIC_AUTH_TOKEN = 'local-shim';
      env.ANTHROPIC_MODEL = providerCfg.model;
      // The CLI asks for one of these aliases depending on the task; all of them
      // must resolve to the pinned model.
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = providerCfg.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = providerCfg.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = providerCfg.model;
      logLine('claude: provider via shim', `port=${started.port}`, `model=${providerCfg.model}`);
    } else {
      logLine('claude: shim unavailable -', started.error);
    }
  }

  const nodeRuntime = resolveNodeRuntime();
  logLine('claude: interpreter', nodeRuntime);

  try {
    ptyProcess = pty.spawn(nodeRuntime, [entry], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: effectiveCwd,
      env,
      useConpty: true,
    });
  } catch (e) {
    logLine('claude: spawn failed -', e.message);
    return { ok: false, error: `Could not start Claude Code: ${e.message}` };
  }

  const wc = event.sender;

  ptyProcess.onData((data) => {
    if (!wc.isDestroyed()) wc.send('claude:data', data);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    logLine('claude: exited', `code=${exitCode}`, `signal=${signal}`);
    ptyProcess = null;
    if (!wc.isDestroyed()) wc.send('claude:exit', { exitCode, signal });
  });

  logLine('claude: spawned pid=', ptyProcess.pid);
  return { ok: true, cwd: effectiveCwd, pid: ptyProcess.pid };
}

function stopClaudePty() {
  const p = claudePtys();
  if (!p) return;
  try { p.kill(); } catch { /* already dead */ }
  ptyProcess = null;
}

ipcMain.on('claude:write', (_e, data) => {
  const p = claudePtys();
  if (p && typeof data === 'string') {
    try { p.write(data); } catch { /* session already gone */ }
  }
});

ipcMain.on('claude:resize', (_e, size = {}) => {
  const p = claudePtys();
  if (!p) return;
  const cols = Math.max(20, Math.round(Number(size.cols) || 120));
  const rows = Math.max(5, Math.round(Number(size.rows) || 34));
  try { p.resize(cols, rows); } catch { /* ignores sizes while exiting */ }
});

ipcMain.handle('claude:restart', async (event, opts = {}) => {
  stopClaudePty();
  await new Promise((r) => setTimeout(r, 250));
  return startClaudePty(event, opts);
});

// ── provider configuration ────────────────────────────────────────────────
/**
 * Read the provider configuration.
 *
 * The key is deliberately not returned: the settings panel only needs to know
 * whether one is stored, so the value never travels to the renderer where it could
 * end up in a screenshot or a devtools dump.
 */
ipcMain.handle('provider:get', () => {
  const cfg = readState().claudeProvider || null;
  if (!cfg) return { configured: false };
  return {
    configured: Boolean(cfg.enabled && cfg.baseUrl && cfg.apiKey && cfg.model),
    enabled: Boolean(cfg.enabled),
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    proxy: cfg.proxy || '',
    hasKey: Boolean(cfg.apiKey),
  };
});

ipcMain.handle('provider:set', (_e, patch = {}) => {
  const current = readState().claudeProvider || {};
  // An empty apiKey in the patch means "keep the stored one": the panel cannot
  // show the key, so it cannot send it back.
  const next = {
    ...current,
    ...patch,
    apiKey: patch.apiKey ? String(patch.apiKey) : (current.apiKey || ''),
  };
  writeState({ claudeProvider: next });
  shim.stop();
  return { ok: true, configured: Boolean(next.enabled && next.baseUrl && next.apiKey && next.model) };
});

ipcMain.handle('provider:clear', () => {
  const current = readState().claudeProvider || {};
  writeState({ claudeProvider: { ...current, enabled: false, apiKey: '' } });
  shim.stop();
  return { ok: true };
});

// ── sandbox (Docker Sandboxes, bundled) ───────────────────────────────────
/**
 * Readiness of the bundled sandbox runtime.
 *
 * Reported as separate facts — virtualization, daemon, account — because each has a
 * different remedy and collapsing them into one boolean tells the user nothing
 * actionable.
 */
ipcMain.handle('sandbox:status', async () => {
  try {
    const st = await sandbox.status();
    // Name the sandbox the app itself uses, so the panel can show which one will
    // run commands instead of only listing every sandbox on the machine.
    const own = readState().sandboxName
      || ((st.sandboxes || []).find((s) => /^agentdeck-/.test(s.name)) || {}).name
      || '';
    return { ...st, activeName: own };
  } catch (e) {
    return { installed: false, error: String((e && e.message) || e) };
  }
});

/**
 * Create or reuse the sandbox the agent runs in.
 *
 * The workspace is a host directory the user picked, mounted read-write, which is
 * the only part of the host the sandbox can see. The template is the bundled
 * toolchain, so no image has to be pulled — a pull would need the network and
 * would look like a hang on a first run.
 */
ipcMain.handle('sandbox:create', async (_e, opts = {}) => {
  try {
    const workspace = opts.workspace || readState().claudeCwd || os.homedir();
    const result = await sandbox.createSandbox({
      name: opts.name,
      label: opts.label,
      workspace,
      template: opts.template || SANDBOX_TEMPLATE,
      cpus: opts.cpus || 4,
      memory: opts.memory || '8g',
      agent: opts.agent || 'shell',
    });
    // Remember it, so the probe and any later run do not have to be told the name
    // again — and so a restart of the app still knows which sandbox is its own.
    if (result.ok && result.name) writeState({ sandboxName: result.name });
    return result;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** Run one command inside the agent sandbox and return its real output. */
ipcMain.handle('sandbox:exec', async (_e, payload = {}) => {
  try {
    const name = String(payload.name || '') || await resolveSandboxName();
    if (!name) return { ok: false, error: '还没有创建沙盒' };
    // Goes through the command log, not straight to the sandbox: every execution
    // is then recorded with its own proof of where it ran, which is the point of
    // this page.
    const entry = await commandLog.run(name, String(payload.command || ''), {
      origin: payload.origin || 'AgentDeck',
      timeoutMs: payload.timeoutMs,
    });
    return {
      ok: entry.state === 'ok',
      code: entry.code,
      stdout: entry.stdout,
      stderr: entry.stderr,
      error: entry.state === 'ok' ? '' : (entry.stderr || entry.state),
      entryId: entry.id,
      proof: entry.proof,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/**
 * The command log, plus the sandbox verdict for each entry.
 *
 * Served from memory rather than by re-reading the file: the panel is live, and
 * the verdict is computed from each record's own proof rather than stored, so a
 * record cannot claim to be sandboxed on the strength of having been written.
 *
 * The shim farm's records are merged in here. They are kept distinct by `source`,
 * because they are a different kind of evidence: a shim record says "this command
 * was started inside the sandbox", while a verified record also carries the kernel
 * proof and the exit code. Presenting them as the same thing would be dishonest.
 */
ipcMain.handle('sandbox:commands', async (_e, limit) => {
  const cap = Number(limit) || 120;
  const verified = commandLog.recent(cap).map((entry) => ({
    source: 'verified',
    id: entry.id,
    command: entry.command,
    origin: entry.origin,
    sandbox: entry.sandbox,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    code: entry.code,
    state: entry.state,
    stdout: entry.stdout,
    stderr: entry.stderr,
    proof: entry.proof,
    verdict: commandLog.verdict(entry),
  }));

  let observed = [];
  try {
    const name = await resolveSandboxName();
    if (name) {
      const workspace = await activeWorkspace();
      const read = shimfarm.read(workspace, cap);
      observed = (read.entries || []).map((e) => ({
        source: 'shim',
        command: e.argv.join(' '),
        origin: e.parent || 'sandbox',
        startedAt: e.at.toISOString(),
        code: null,
        state: 'observed',
        cwd: e.cwd,
        pid: e.pid,
        // No proof block: the shim cannot see the kernel's identity of the process
        // it fronted. Saying so is better than copying a proof from elsewhere.
        verdict: { sandboxed: null, reason: '沙盒内启动（shim 观测，无内核凭证）' },
      }));
    }
  } catch (e) {
    logLine('execwatch: read failed', String(e && e.message || e));
  }

  // Newest first overall: a person reading this wants the most recent action.
  const merged = [...verified, ...observed]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, cap);

  return {
    entries: merged,
    counts: { verified: verified.length, observed: observed.length },
  };
});

/**
 * The workspace of the app's own sandbox, asked of the guest's mount table.
 *
 * Not the saved working directory: measured, the recorder's log lived in the
 * sandbox's workspace while the app read from the saved directory and showed an
 * empty board.
 */
async function activeWorkspace() {
  const name = await resolveSandboxName();
  if (!name) return readState().claudeCwd || os.homedir();
  const ws = await sandbox.workspaceOf(name);
  return ws || readState().claudeCwd || os.homedir();
}

/** Install the recorder into the app's sandbox and report what it covers. */
ipcMain.handle('sandbox:install-watch', async () => {
  try {
    const name = await resolveSandboxName();
    if (!name) return { ok: false, error: '还没有创建沙盒' };
    const workspace = await activeWorkspace();
    const res = await shimfarm.install(sandbox, name, workspace);
    if (res.ok) logLine('execwatch: installed', name, `${res.count} commands`, workspace);
    return { ...res, workspace };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** Whether the recorder is present, so the panel can show it honestly. */
ipcMain.handle('sandbox:watch-status', async () => {
  try {
    const name = await resolveSandboxName();
    if (!name) return { ok: false, installed: false, sandbox: '' };
    const installed = await shimfarm.isInstalled(sandbox, name);
    return { ok: true, installed, sandbox: name, dir: shimfarm.BIN };
  } catch (e) {
    return { ok: false, installed: false, error: String((e && e.message) || e) };
  }
});

/** Where the durable audit file lives, so the panel can offer to open it. */
ipcMain.handle('sandbox:log-path', () => path.join(USER_DATA, 'sandbox-commands.jsonl'));

/**
 * Run one turn of an agent inside its sandbox.
 *
 * Every agent goes through the same path as any other command, so its turn is
 * recorded with the same proof. This is the difference between "the agent runs in
 * a sandbox by design" and "here is the kernel that ran this turn".
 */
/**
 * The customisation surface: read the built-in guide, render a template for each
 * target, and optionally write it into the app that can take it safely.
 */
ipcMain.handle('customize:catalogue', () => customize.catalogue());

ipcMain.handle('customize:template', (_e, payload = {}) => {
  try {
    const server = customize.templateServer({
      name: payload.name,
      directory: payload.directory,
      description: payload.description,
    });
    const ctx = {
      workspace: payload.workspace || readState().claudeCwd || os.homedir(),
    };
    return { ok: true, server, rendered: customize.renderAll(server, ctx) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('customize:apply', (_e, payload = {}) => {
  try {
    const server = customize.templateServer({
      name: payload.name,
      directory: payload.directory,
      description: payload.description,
    });
    const ctx = {
      workspace: payload.workspace || readState().claudeCwd || os.homedir(),
    };
    return customize.applyTo(String(payload.target || ''), server, ctx);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** The built-in guide, read from the packaged file so it ships with the app. */
ipcMain.handle('customize:guide', () => {
  try {
    const file = path.join(APP_ROOT, 'docs', 'CUSTOMIZE.md');
    return { ok: true, path: file, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('sandbox:run-agent', async (_e, payload = {}) => {  try {
    const agent = String(payload.agent || '').trim();
    const prompt = String(payload.prompt || '').trim();
    if (!['claude', 'codex', 'opencode'].includes(agent)) {
      return { ok: false, error: `不支持的内置 agent：${agent || '(空)'}` };
    }
    if (!prompt) return { ok: false, error: '需要一段提示词' };

    // Each CLI spells "run one turn non-interactively" differently, so the
    // invocation is built per agent rather than guessed at.
    const quoted = JSON.stringify(prompt);
    const invocation = agent === 'claude'
      ? `claude -p ${quoted} --output-format text`
      : agent === 'codex'
        // The workspace is a plain directory, not a git checkout, and codex refuses
        // to run in one without this flag.
        ? `codex exec --skip-git-repo-check ${quoted}`
        : `opencode run ${quoted}`;

    const name = await ensureAgentSandbox(agent);
    if (!name) return { ok: false, error: `${agent} 的沙盒没能创建` };

    const entry = await commandLog.run(name, invocation, {
      origin: agent,
      timeoutMs: 300000,
    });
    return {
      ok: entry.state === 'ok',
      agent,
      sandbox: name,
      command: entry.command,
      code: entry.code,
      stdout: entry.stdout,
      stderr: entry.stderr,
      proof: entry.proof,
      verdict: commandLog.verdict(entry),
      error: entry.state === 'ok' ? '' : (entry.stderr || entry.state),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/**
 * The sandbox an agent runs in, created on first use.
 *
 * One sandbox per agent rather than one shared: the images carry different
 * toolchains, and a crash in one agent should not take the others down with it.
 * A missing image is reported rather than silently pulled, because a pull on a
 * metered connection is the user's decision.
 */
async function ensureAgentSandbox(agent) {
  const name = `agent-${agent}`;
  const listed = await sandbox.listSandboxes();
  if (listed.ok && (listed.sandboxes || []).some((s) => s.name === name)) return name;

  const workspace = readState().claudeCwd || os.homedir();
  const made = await sandbox.createSandbox({
    name,
    workspace,
    agent,
    // Empty template: the agent kit supplies the image, and naming a toolchain
    // image here would override it.
    template: '',
    cpus: 4,
    memory: '4g',
  });
  if (!made.ok) {
    logLine('sandbox: agent create failed', agent, made.error);
    return '';
  }
  return name;
}
/** Open the command audit file in the user's editor of choice. */
ipcMain.handle('sandbox:open-log', async () => {
  try {
    const { shell } = require('electron');
    const file = path.join(USER_DATA, 'sandbox-commands.jsonl');
    if (!fs.existsSync(file)) return { ok: false, error: '审计文件还没有内容' };
    await shell.openPath(file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('sandbox:list', async () => {
  try {
    return await sandbox.listSandboxes();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), sandboxes: [] };
  }
});

/**
 * A live snapshot of the processes inside the sandbox.
 *
 * Polled by the panel rather than pushed, because the panel is only open while
 * someone is looking at it — a push would keep a shell running in the guest for a
 * page nobody has open.
 */
ipcMain.handle('sandbox:processes', async (_e, name) => {
  try {
    const target = String(name || '') || await resolveSandboxName();
    if (!target) return { ok: false, error: '还没有沙盒', processes: [] };
    return await sandbox.processes(target);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), processes: [] };
  }
});

/**
 * Deep status for one sandbox: kernel, CPU, memory, disk, isolation, toolchain.
 *
 * Asked of the guest kernel rather than of the configuration, because "how much
 * memory was requested" and "how much is there" are different facts, and only the
 * second one can be trusted when reporting health.
 */
ipcMain.handle('sandbox:inspect', async (_e, name) => {
  try {
    const target = String(name || '') || readState().sandboxName || await resolveSandboxName();
    if (!target) return { ok: false, error: '还没有沙盒可检查' };
    const info = await sandbox.inspect(target);
    if (info && info.ok) logLine('sandbox: inspected', target, `${info.probeMs}ms`);
    return info;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** Host-side health: daemon, hypervisor, and the raw `sbx diagnose` report. */
ipcMain.handle('sandbox:host-health', async () => {
  try {
    return await sandbox.hostHealth();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** The sandbox this app uses, falling back to the first one it created. */
async function resolveSandboxName() {
  const saved = readState().sandboxName;
  if (saved) return saved;
  const listed = await sandbox.listSandboxes();
  const mine = (listed.sandboxes || []).find((s) => /^agentdeck-/.test(s.name));
  if (mine) {
    writeState({ sandboxName: mine.name });
    return mine.name;
  }
  return '';
}

ipcMain.handle('sandbox:remove', async (_e, name) => {
  try {
    return await sandbox.removeSandbox(String(name || ''));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/**
 * Test a provider without switching to it.
 *
 * Sends one minimal request through a throwaway shim instance so the answer covers
 * the whole chain — translation, auth, model name — rather than only whether the
 * URL responds.
 */
ipcMain.handle('provider:test', async (_e, cfg = {}) => {
  const current = readState().claudeProvider || {};
  const merged = {
    baseUrl: cfg.baseUrl || current.baseUrl || '',
    apiKey: cfg.apiKey || current.apiKey || '',
    model: cfg.model || current.model || '',
    proxy: cfg.proxy ?? current.proxy ?? '',
  };
  if (!merged.baseUrl || !merged.apiKey || !merged.model) {
    return { ok: false, error: 'base URL, key and model are all required' };
  }

  // A separate instance on its own port, so a test never disturbs a live session.
  const probe = require('./shim.js')({ appRoot: APP_ROOT, userData: USER_DATA, log: logLine });
  const started = await probe.start({
    upstream: merged.baseUrl,
    apiKey: merged.apiKey,
    model: merged.model,
    proxy: merged.proxy,
  });
  if (!started.ok) return { ok: false, error: started.error };

  const answer = await new Promise((resolve) => {
    const http = require('node:http');
    const body = JSON.stringify({
      model: merged.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: started.port,
      path: '/v1/messages',
      method: 'POST',
      timeout: 45000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, error: `upstream returned ${res.statusCode}: ${d.slice(0, 300)}` });
          return;
        }
        try {
          const j = JSON.parse(d);
          const text = (j.content || []).map((b) => b.text || '').join('').trim();
          resolve({ ok: true, text: text.slice(0, 120), model: j.model });
        } catch {
          resolve({ ok: false, error: `unreadable reply: ${d.slice(0, 200)}` });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timed out' }); });
    req.write(body);
    req.end();
  });

  probe.stop();
  return answer;
});

// ── shell IPC ─────────────────────────────────────────────────────────────
ipcMain.on('deck:content-bounds', (_e, rect) => {
  if (!rect) return;
  contentBounds = {
    x: Number(rect.x) || 0,
    y: Number(rect.y) || 0,
    width: Number(rect.width) || 0,
    height: Number(rect.height) || 0,
  };
  applyViewBounds();
});

ipcMain.on('deck:set-view', (_e, view) => {
  setViewVisible(view === 'openchamber');
  // A guest window paints over the whole page, so every non-guest view hides
  // whatever guest is currently adopted.
  if (!guests.GUESTS[view]) {
    for (const id of Object.keys(guests.GUESTS)) guests.hideGuest(id);
  }
  writeState({ lastView: view });
});

// ── guest front ends (real apps in real windows) ─────────────────────────
ipcMain.handle('guest:status', () => guests.guestStatus());

ipcMain.handle('guest:show', async (event, payload = {}) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const id = String(payload.id || '');
  const rect = payload.rect;
  if (!rect || !rect.width || !rect.height) {
    return { ok: false, error: 'panel geometry was not reported' };
  }

  // Only one guest is visible at a time: they all reparent into the same
  // window, so two would fight over the same pixels.
  for (const other of Object.keys(guests.GUESTS)) {
    if (other !== id) guests.hideGuest(other);
  }

  const result = await guests.showGuest(id, mainWindow.getNativeWindowHandle(), rect);
  if (result.ok) {
    logLine('guest: shown', id, `pid=${result.pid}`, `hwnd=${result.hwnd}`);
  } else {
    logLine('guest: failed', id, result.error);
  }
  return result;
});

ipcMain.handle('guest:hide', (_e, id) => guests.hideGuest(String(id || '')));

ipcMain.handle('guest:layout', async (_e, payload = {}) => {
  const id = String(payload.id || '');
  if (!payload.rect) return { ok: false, moved: false, error: 'no rect' };
  if (!mainWindow) return { ok: false, moved: false, error: 'no window' };
  // The host handle is passed through so a guest coming back into view can be
  // re-owned; an owned window cannot report its owner back.
  const result = await guests.layoutGuest(id, payload.rect, mainWindow.getNativeWindowHandle());
  if (result && result.reshown) logLine('guest: reshown', id, `visible=${result.ok}`);
  return result;
});

ipcMain.handle('guest:stop', (_e, id) => guests.stopGuest(String(id || '')));

ipcMain.handle('guest:open-vault', async () => {
  const profile = guests.ensureClaudianProfile();
  return { ok: Boolean(profile), profile: profile || '', vault: path.join(USER_DATA, 'vault') };
});

ipcMain.handle('deck:get-state', () => readState());
ipcMain.handle('deck:set-state', (_e, patch) => writeState(patch || {}));
ipcMain.handle('deck:server-status', () => serverStatusPayload());

ipcMain.handle('deck:reload-agent', () => {
  if (openChamberView) openChamberView.webContents.reload();
  return true;
});

ipcMain.handle('deck:restart-agent', async () => {
  try {
    if (serverHandle) await serverHandle.stop({ exitProcess: false });
  } catch { /* nothing to stop */ }
  serverHandle = null;
  serverUrl = '';
  serverError = '';
  if (openChamberView && mainWindow) {
    try { mainWindow.contentView.removeChildView(openChamberView); } catch { /* already gone */ }
    try { openChamberView.webContents.close(); } catch { /* already closed */ }
    openChamberView = null;
  }
  await startAgentServer();
  return serverStatusPayload();
});

ipcMain.handle('deck:pick-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a working folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: readState().claudeCwd || os.homedir(),
  });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  writeState({ claudeCwd: dir });
  return dir;
});

ipcMain.handle('deck:open-external', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  return true;
});

// ── environment report (shown in Settings) ────────────────────────────────
function buildEnvironmentReport() {
  const opencode = resolveOpenCodeBinary();
  const claude = resolveClaudeEntry();
  const rg = resolveRipgrep();
  const nodeRuntime = resolveNodeRuntime();
  const asar = path.join(APP_ROOT, 'node_modules');

  return {
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      userData: USER_DATA,
      agentHome: path.join(USER_DATA, 'agent-home'),
    },
    agents: {
      openchamber: {
        present: Boolean(serverUrl) || Boolean(serverHandle),
        url: serverUrl,
        version: readPackageVersion('@openchamber/web'),
        error: serverError,
      },
      claude: {
        present: Boolean(claude),
        entry: claude || '',
        version: readPackageVersion('claude-code-best'),
        running: Boolean(ptyProcess),
      },
      opencode: {
        present: Boolean(opencode),
        path: opencode || '',
        version: opencode ? readBinaryVersion(opencode) : '',
      },
      ripgrep: { present: Boolean(rg), path: rg || '' },
      node: { present: Boolean(nodeRuntime), path: nodeRuntime || '', version: process.versions.node },
    },
    bundle: { root: APP_ROOT, dependencies: asar },
  };
}

function readPackageVersion(name) {
  try {
    const p = path.join(pkgRoot(name), 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || '';
  } catch {
    return '';
  }
}

function readBinaryVersion(bin) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = String(out).match(/\d+\.\d+\.\d+/);
    return m ? m[0] : String(out).trim().split('\n')[0];
  } catch {
    return '';
  }
}

function sendEnvironmentReport() {
  if (!mainWindow) return;
  mainWindow.webContents.send('deck:environment', buildEnvironmentReport());
}

/**
 * Verification helper used only with `--capture`. It drives the shell the way
 * a click does and stores true-colour PNGs so the UI can be inspected without
 * a human in the loop. A child WebContentsView is never part of the parent's
 * capturePage output, so the agent view is captured separately.
 */
async function runCaptureSequence() {
  const outDir = process.env.AGENTDECK_CAPTURE_DIR ||
    path.join(os.tmpdir(), 'agentdeck-capture');
  fs.mkdirSync(outDir, { recursive: true });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (wc, name) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const img = await wc.capturePage();
        const file = path.join(outDir, `${name}.png`);
        fs.writeFileSync(file, img.toPNG());
        logLine('capture:', file);
        return;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (attempt === 2) { logLine('capture skipped:', name, msg); return; }
        await wait(700);
      }
    }
  };

  /**
   * Wait until a guest panel really has its window on screen.
   *
   * Polling the live guest record is the honest signal: the app has been launched
   * *and* its window found *and* shown. A fixed sleep cannot tell those apart, so
   * a slow cold start was reported as a failure while a warm start burned the
   * whole delay.
   *
   * Window-visible is not the end of it. An Electron app creates its window long
   * before the UI finishes loading — Codex showed a plain splash mark for the
   * first seconds — so a settle delay follows, and `settleMs` is the caller's
   * statement of how much rendering time that app needs.
   */
  const waitForGuest = async (id, timeoutMs, settleMs = 0) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let ready = false;
    while (Date.now() < deadline) {
      const rec = guests.guestRecords()[id];
      if (rec && rec.visible) {
        logLine('capture: guest window up', id, `pid=${rec.pid}`, `hwnd=${rec.hwnd}`);
        ready = true;
        break;
      }
      last = rec || null;
      await wait(500);
    }
    if (!ready) {
      logLine('capture: guest not ready', id,
        last ? `pid=${last.pid} hwnd=${last.hwnd} visible=${last.visible}` : 'never launched');
      return false;
    }
    if (settleMs > 0) {
      await wait(settleMs);
    }
    return true;
  };

  /**
   * How many distinct colours a page produces.
   *
   * A splash screen is one flat mark on a flat background; a rendered app has
   * chrome, text and panels. Counting colours is a cheap way to tell "the window
   * exists" from "the UI is actually drawn", without a human looking at it.
   */
  const countColors = async (wc) => {
    try {
      const img = await wc.capturePage();
      const { width, height } = img.getSize();
      const buf = img.toBitmap();
      const seen = new Set();
      // Every 7th pixel is plenty for a colour census and keeps this fast.
      for (let i = 0; i + 3 < buf.length; i += 4 * 7) {
        seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
      }
      return { colors: seen.size, width, height };
    } catch (e) {
      return { colors: 0, error: String(e && e.message || e) };
    }
  };

  /** Switch the shell's own appearance, to capture both themes. */
  const setTheme = async (theme) => {
    await mainWindow.webContents.executeJavaScript(`(() => {
      const sel = document.getElementById('themeSelect');
      if (!sel) return { ok: false, reason: 'no select' };
      sel.value = ${JSON.stringify(theme)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, now: document.documentElement.dataset.theme };
    })()`).then((r) => logLine('theme →', theme, JSON.stringify(r)));
    await wait(900);
    const state = await mainWindow.webContents.executeJavaScript(`(() => ({
      dataTheme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    }))()`);
    logLine('theme state:', JSON.stringify(state));
    await wait(500);
  };

  await wait(2600);

  // Always start from Home so the capture set is deterministic, regardless of
  // the last view the app restored.
  await mainWindow.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.app-nav-btn[data-panel="home"]');
    if (b) b.click();
    return Boolean(b);
  })()`);
  await wait(900);
  await shot(mainWindow.webContents, '01-home-dark');
  await setTheme('light');
  await shot(mainWindow.webContents, '01-home-light');
  await setTheme('dark');

  for (const panel of ['claude', 'codex', 'workspace', 'settings', 'openchamber']) {
    // A missing nav button must not abort the whole sweep: the earlier version
    // threw here for `codex` and the run ended before the later panels were
    // visited at all, which looked like a slow guest rather than a missing button.
    const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.app-nav-btn[data-panel="${panel}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) {
      logLine('capture: no nav button for', panel);
      continue;
    }
    // Guest panels launch a whole application, so wait for the guest to report
    // itself visible rather than guessing a fixed delay. An Electron app can take
    // well over fifteen seconds on a cold start, and a fixed wait either gave up
    // early or wasted time on a warm one.
    const guestWait = ['claude', 'codex'].includes(panel);
    if (guestWait) {
      // A window appears well before its UI is drawn; Codex sat on a splash for
      // several seconds. Give each app the time it needs to paint, measured from
      // when its window first appeared.
      await waitForGuest(panel, 75000, panel === 'codex' ? 10000 : 6000);
    } else {
      await wait(1500);
    }
    await shot(mainWindow.webContents, `02-${panel}-shell`);
    if (guestWait) {
      // Guests are separate top-level windows, so they never appear in the
      // shell's capturePage output. They are also not proven by PrintWindow:
      // Electron and Obsidian create their window with WS_EX_NOREDIRECTIONBITMAP,
      // so there is no compositor bitmap to read and PrintWindow returns black
      // for a window that is plainly visible.
      //
      // The capture itself lives in scripts/shoot-window.ps1: it raises the host,
      // waits for the owned panel to come up with it, and photographs the host's
      // rect. A separate file avoids four levels of escaping and reports its own
      // failures.
      //
      // It must run *asynchronously*. spawnSync blocks this process's event loop,
      // and the host window cannot then respond to being raised — measured, that
      // deadlocked until the timeout fired with no file written. An async spawn
      // leaves the window responsive while PowerShell does its work.
      const outFile = path.join(outDir, `03-guest-${panel}.png`);
      const shooter = path.join(__dirname, '..', '..', 'scripts', 'shoot-window.ps1');
      const shoot = () => new Promise((resolve) => {
        const cp = require('node:child_process').spawn(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive',
            '-ExecutionPolicy', 'Bypass', '-File', shooter,
            '-Title', 'AgentDeck', '-OutFile', outFile],
          { windowsHide: true },
        );
        let out = '';
        let err = '';
        cp.stdout.on('data', (c) => { out += c; });
        cp.stderr.on('data', (c) => { err += c; });
        const timer = setTimeout(() => { try { cp.kill(); } catch { /* gone */ } }, 30000);
        cp.on('error', (e) => { clearTimeout(timer); resolve(`spawn failed: ${e.message}`); });
        cp.on('close', (code) => {
          clearTimeout(timer);
          const text = `${out}${err}`.trim().replace(/\s+/g, ' ');
          resolve(`status=${code} ${text.slice(0, 200)}`);
        });
      });

      // Photograph, then check that something was actually drawn.
      //
      // A splash screen is a single flat mark on a flat background, so its colour
      // count is tiny, while a finished UI has chrome, text and panels. Retrying
      // on a low count replaces a human having to look at the file and guess
      // whether the app had finished loading.
      let said = '';
      let census = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        said = await shoot();
        census = await countColors(mainWindow.webContents);
        if (census.colors >= 40) break;
        logLine('capture: guest looks unrendered', panel,
          `colors=${census.colors}`, `attempt=${attempt + 1}`);
        await wait(4000);
      }
      logLine('capture: panel on screen', panel, said,
        census ? `colors=${census.colors}` : '', outFile);
      // Measure instead of trusting the placement call.
      //
      // A guest is an *owned* window, not a child, so GetParent returns 0 for it
      // by design. The owner is what matters, and the slot is in CSS pixels while
      // the window is in physical ones, so both are converted before comparing.
      const geo = await mainWindow.webContents.executeJavaScript(`(() => {
        const slot = document.getElementById('${panel}Slot');
        const r = slot.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height,
          dpr: window.devicePixelRatio };
      })()`);
      logLine('guest geometry', panel, 'slot(css)=', JSON.stringify(geo));
      try {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');
        const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void* h, _Out_ int* r)');
        const GetWindow = user32.func('void* __stdcall GetWindow(void* h, uint cmd)');
        const GetDpiForWindow = user32.func('uint __stdcall GetDpiForWindow(void* h)');
        const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void* h, _Inout_ int* p)');
        const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* h)');

        const rec = guests.guestRecords();
        const info = rec[panel];
        if (info && info.hwnd) {
          const h = BigInt(info.hwnd);
          const rect = [0, 0, 0, 0];
          GetWindowRect(h, rect);
          const dpi = Number(GetDpiForWindow(h));
          const scale = dpi > 0 ? dpi / 96 : 1;
          const visible = Boolean(IsWindowVisible(h));

          // Owned windows have no parent, so the host's handle comes from the
          // window itself via GW_OWNER; that is what converts a slot to screen
          // coordinates.
          const owner = GetWindow(h, 4); // GW_OWNER
          const origin = [0, 0];
          const hasOrigin = Boolean(owner) && Boolean(ClientToScreen(owner, origin));

          const wantX = origin[0] + Math.round(geo.x * scale);
          const wantY = origin[1] + Math.round(geo.y * scale);
          const wantW = Math.round(geo.width * scale);
          const wantH = Math.round(geo.height * scale);
          const gotW = rect[2] - rect[0];
          const gotH = rect[3] - rect[1];
          const near = (a, b) => Math.abs(a - b) <= 4;

          logLine('guest geometry', panel,
            `hwnd=${h} owner=${owner} dpi=${dpi} scale=${scale.toFixed(2)} visible=${visible}`,
            `rect=(${rect[0]},${rect[1]},${gotW}x${gotH})`,
            `want=(${wantX},${wantY},${wantW}x${wantH})`,
            `posOK=${hasOrigin && near(rect[0], wantX) && near(rect[1], wantY)}`,
            `sizeOK=${near(gotW, wantW) && near(gotH, wantH)}`);
        }
      } catch (e) {
        logLine('guest geometry probe failed:', String(e && e.message || e));
      }
    }
    if (panel === 'openchamber' && openChamberView) {
      await wait(3000);
      await shot(openChamberView.webContents, '02-openchamber-app');
    }
  }

  // Back to Home: the native view must be hidden, or it would paint over the
  // shell page in the real window (capturePage cannot show this).
  await mainWindow.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.app-nav-btn[data-panel="home"]');
    if (b) b.click();
    return Boolean(b);
  })()`);
  await wait(900);
  const visibility = {
    afterHome: openChamberView ? openChamberView.getVisible() : null,
  };
  await mainWindow.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.app-nav-btn[data-panel="openchamber"]');
    if (b) b.click();
    return Boolean(b);
  })()`);
  await wait(900);
  visibility.afterChamber = openChamberView ? openChamberView.getVisible() : null;
  logLine('view visibility (true = painting over the page):', JSON.stringify(visibility));
  await shot(mainWindow.webContents, '03-back-to-chamber');

  // Restart path: a broken restart only shows up as a dead panel later.
  //
  // This used to drive the xterm terminal and click #btnTermRestart. That
  // terminal is gone — Claude Code is the official desktop app now — and the
  // stale click threw, which aborted the whole capture run. What is worth
  // proving today is that a guest panel survives a restart: the old process is
  // stopped, a new one starts, and its window is placed in the same slot.
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.app-nav-btn[data-panel="claude"]').click(); true`,
  );
  await waitForGuest('claude', 75000);
  const beforeRestart = guests.guestRecords().claude || null;

  // Go through the same code path the renderer's restart button uses, so the
  // check exercises production behaviour instead of a DOM click that only
  // exists on an error card.
  guests.stopGuest('claude');
  await wait(1500);
  const geoClaude = await mainWindow.webContents.executeJavaScript(`(() => {
    const slot = document.getElementById('claudeSlot');
    if (!slot) return null;
    const r = slot.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);
  const restartResult = geoClaude
    ? await guests.showGuest('claude', mainWindow.getNativeWindowHandle(), geoClaude)
    : { ok: false, error: 'no slot' };
  const restarted = await waitForGuest('claude', 75000);
  const afterRestart = guests.guestRecords().claude || null;

  logLine('restart:', `ok=${restartResult.ok}`, `ready=${restarted}`,
    'before=', JSON.stringify(beforeRestart), 'after=', JSON.stringify(afterRestart),
    `newProcess=${Boolean(beforeRestart && afterRestart && beforeRestart.pid !== afterRestart.pid)}`);
  await shot(mainWindow.webContents, '04-claude-after-restart');

  const probe = await mainWindow.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    const guests = (window.__deckGuestState || null);
    return {
      active: q('.panel.active')?.dataset.panel ?? null,
      nav: q('.app-nav-btn.active')?.dataset.panel ?? null,
      envRows: document.querySelectorAll('#envList .env-row').length,
      aboutRows: document.querySelectorAll('#aboutGrid .env-row').length,
      pills: Array.from(document.querySelectorAll('.status-pill')).map(p => p.textContent.trim()),
      cwd: q('#cwdPath')?.textContent ?? null,
    };
  })()`).catch((e) => ({ error: String(e && e.message || e) }));

  logLine('capture probe:', JSON.stringify(probe));
  logLine('capture: done');
}

ipcMain.handle('deck:open-log', async () => {
  try {
    const { shell } = require('electron');
    await shell.openPath(LOG_FILE);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('deck:recent-log', () => {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const tail = raw.split('\n').filter(Boolean).slice(-40).join('\n');
    return { path: LOG_FILE, tail };
  } catch (e) {
    return { path: LOG_FILE, tail: '', error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('deck:environment', () => buildEnvironmentReport());

// ── app lifecycle ─────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'View',
          submenu: [
            { role: 'reload', label: 'Reload shell' },
            { role: 'forceReload', label: 'Reload (force)' },
            { type: 'separator' },
            { role: 'toggleDevTools', label: 'Developer tools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
            { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
          ],
        },
      ]),
    );

    nativeTheme.themeSource = readState().theme || 'system';

    createMainWindow();
    await startAgentServer();
    sendEnvironmentReport();

    if (process.argv.includes('--capture')) {
      // Verification hook: walk every panel and write true-colour PNGs.
      // capturePage on the shell never includes a child WebContentsView, so the
      // agent view is captured on its own and stitched beside the shell shot.
      runCaptureSequence().catch((e) => logLine('capture failed:', String(e && e.message || e)));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const p = claudePtys();
    if (p) {
      try { p.kill(); } catch { /* already dead */ }
      ptyProcess = null;
    }
    if (serverHandle) {
      event.preventDefault();
      const done = () => app.quit();
      Promise.resolve()
        .then(() => serverHandle.stop({ exitProcess: false }))
        .catch(() => {})
        .finally(() => {
          serverHandle = null;
          done();
        });
    }
  });
}
