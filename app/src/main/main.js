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

ipcMain.handle('claude:start', (event, opts = {}) => startClaudePty(event, opts));

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
 */function startClaudePty(event, opts = {}) {
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

ipcMain.on('guest:layout', (_e, payload = {}) => {
  const id = String(payload.id || '');
  if (payload.rect) guests.layoutGuest(id, payload.rect);
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
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.app-nav-btn[data-panel="home"]').click(); true`,
  );
  await wait(900);
  await shot(mainWindow.webContents, '01-home-dark');
  await setTheme('light');
  await shot(mainWindow.webContents, '01-home-light');
  await setTheme('dark');

  for (const panel of ['claude', 'workspace', 'settings', 'opcode', 'codex', 'emdash', 'claudian', 'openchamber']) {
    await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.app-nav-btn[data-panel="${panel}"]').click(); true`,
    );
    // Guest panels launch a whole application; give each one time to appear.
    const guestWait = ['opcode', 'codex', 'emdash', 'claudian'].includes(panel);
    await wait(guestWait ? 15000 : (panel === 'claude' ? 6000 : 1500));
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
      const said = await new Promise((resolve) => {
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
      logLine('capture: panel on screen', panel, said, outFile);

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
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.app-nav-btn[data-panel="home"]').click(); true`,
  );
  await wait(900);
  const visibility = {
    afterHome: openChamberView ? openChamberView.getVisible() : null,
  };
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.app-nav-btn[data-panel="openchamber"]').click(); true`,
  );
  await wait(900);
  visibility.afterChamber = openChamberView ? openChamberView.getVisible() : null;
  logLine('view visibility (true = painting over the page):', JSON.stringify(visibility));
  await shot(mainWindow.webContents, '03-back-to-chamber');

  // Restart path: a broken restart only shows up as a dead terminal later.
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.app-nav-btn[data-panel="claude"]').click(); true`,
  );
  await wait(6000);
  const beforeRestart = await mainWindow.webContents.executeJavaScript(
    `(document.querySelector('.xterm-rows')?.textContent || '').trim().length`);
  await mainWindow.webContents.executeJavaScript(`document.getElementById('btnTermRestart').click(); true`);
  await wait(9000);
  const afterRestart = await mainWindow.webContents.executeJavaScript(`(() => {
    const rows = document.querySelector('.xterm-rows')?.textContent || '';
    const ph = document.getElementById('claudePlaceholder');
    return {
      length: rows.trim().length,
      sample: rows.replace(/\\s+/g, ' ').trim().slice(0, 100),
      placeholderHidden: ph ? ph.hidden : null,
      phTitle: document.getElementById('claudePhTitle')?.textContent ?? null,
    };
  })()`);
  logLine('restart: before len=', beforeRestart, 'after=', JSON.stringify(afterRestart));
  await shot(mainWindow.webContents, '04-claude-after-restart');

  const probe = await mainWindow.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    return {
      active: q('.panel.active')?.dataset.panel ?? null,
      nav: q('.app-nav-btn.active')?.dataset.panel ?? null,
      envRows: document.querySelectorAll('#envList .env-row').length,
      aboutRows: document.querySelectorAll('#aboutGrid .env-row').length,
      pills: Array.from(document.querySelectorAll('.status-pill')).map(p => p.textContent.trim()),
      termHasContent: (q('.xterm-rows')?.textContent || '').trim().length > 0,
      termSample: (q('.xterm-rows')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
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
