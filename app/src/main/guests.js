'use strict';

/**
 * Guest front ends.
 *
 * Four bundled front ends (opcode, Codex, Emdash, Claudian) are complete
 * applications with their own backend. They cannot be hosted like OpenChamber,
 * whose web UI we can load in a WebContentsView: these render into a window of
 * their own and talk to their own process over a private channel.
 *
 * So each runs as a real child process and its real window is *owned* by our
 * window. An owned window stays an ordinary top-level window — the guest renders
 * exactly as it does when launched alone — while Windows keeps it above the
 * owner, out of the taskbar, and hides it when the owner is minimised.
 *
 * SetParent was tried first and rejected: making the guest a WS_CHILD disturbed
 * how Chromium-based guests set up their drawing surface. Measured on the real
 * windows, Electron (Emdash) and Obsidian (Claudian) then painted nothing at all,
 * and the two Tauri apps laid their content out at the wrong scale. Owning the
 * window leaves all of that untouched.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWindows = process.platform === 'win32';

// ── Win32 constants ───────────────────────────────────────────────────────
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TOOLWINDOW = 0x00000080;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
/** Insert after HWND_TOP: an owned panel must not be covered by its owner. */
const HWND_TOP = 0n;

// ── Win32 bindings, loaded once ───────────────────────────────────────────
let win32 = null;

function loadWin32() {
  if (win32) return win32;
  let koffi;
  try {
    koffi = require('koffi');
  } catch (e) {
    throw new Error(`koffi (the Win32 bridge) is missing from the bundle: ${e.message}`);
  }
  const user32 = koffi.load('user32.dll');
  win32 = {
    koffi,
    GetWindowLongPtr: user32.func('intptr_t __stdcall GetWindowLongPtrW(void* hwnd, int index)'),
    SetWindowLongPtr: user32.func('intptr_t __stdcall SetWindowLongPtrW(void* hwnd, int index, intptr_t value)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(void* hwnd, void* after, int x, int y, int cx, int cy, uint flags)'),
    MoveWindow: user32.func('bool __stdcall MoveWindow(void* hwnd, int x, int y, int width, int height, bool repaint)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(void* hwnd, int cmd)'),
    IsWindow: user32.func('bool __stdcall IsWindow(void* hwnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ int* rect)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(void* hwnd, _Out_ int* rect)'),
    ClientToScreen: user32.func('bool __stdcall ClientToScreen(void* hwnd, _Inout_ int* point)'),
    GetDpiForWindow: user32.func('uint __stdcall GetDpiForWindow(void* hwnd)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(void* cb, intptr_t param)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint32* pid)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void* hwnd)'),
    GetParent: user32.func('void* __stdcall GetParent(void* hwnd)'),
    GetWindow: user32.func('void* __stdcall GetWindow(void* hwnd, uint cmd)'),
  };
  // koffi registers prototypes by name, so this is created once and reused.
  win32.enumProcProto = koffi.proto('bool __stdcall EnumProc(void* hwnd, intptr_t param)');
  return win32;
}

/**
 * Find the process's real window — the one the user would see.
 *
 * A guest process owns several top-level windows: helper surfaces, a notify-icon
 * host, an IME window, and finally the visible UI. Taking "the first window that
 * exists" attaches the panel to a helper, so the rule here is stricter: an
 * unowned, at-least-320×240 window, preferring the visible one and then the
 * largest.
 *
 * `visibleOnly` matters for the wait below. Obsidian creates its window hidden,
 * reloads it, and only then shows the real one; binding to whatever existed
 * first left the panel attached to a window that never appeared.
 */
function findTopLevelWindow(pid, visibleOnly = false) {
  const w = loadWin32();
  const found = [];
  let cb = null;
  try {
    cb = w.koffi.register((hwnd) => {
      const out = [0];
      try {
        w.GetWindowThreadProcessId(hwnd, out);
      } catch {
        return true;
      }
      if (Number(out[0]) !== pid) return true;

      // A child window belongs to another window; the panel must be the root.
      let parent = 0n;
      try { parent = BigInt(w.GetParent(hwnd) || 0); } catch { /* keep 0 */ }
      if (parent !== 0n) return true;

      const visible = Boolean(w.IsWindowVisible(hwnd));
      if (visibleOnly && !visible) return true;

      const rect = [0, 0, 0, 0];
      try { w.GetWindowRect(hwnd, rect); } catch { return true; }
      const width = rect[2] - rect[0];
      const height = rect[3] - rect[1];
      // Helper windows are 0×0 or a few pixels square.
      if (width < 320 || height < 240) return true;

      found.push({ hwnd, visible, area: width * height });
      return true;
    }, w.koffi.pointer(w.enumProcProto));
    w.EnumWindows(cb, 0);
  } catch {
    return 0n;
  } finally {
    if (cb !== null) {
      try { w.koffi.unregister(cb); } catch { /* older koffi */ }
    }
  }
  if (!found.length) return 0n;

  // Prefer a visible window, then the largest: the UI is both.
  found.sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return b.area - a.area;
  });
  return BigInt(found[0].hwnd);
}

/**
 * Wait for the guest to show its real window.
 *
 * The wait is for a *visible* window, not merely an existing one. Electron and
 * Obsidian create a hidden window first and show it seconds later, so accepting
 * the first window found would bind the panel to one that never appears. If
 * nothing becomes visible in time, the largest window is used so the panel still
 * opens and reports something, rather than failing outright.
 */
function waitForWindow(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = findTopLevelWindow(pid, true);
    if (visible > 0n) return visible;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  }
  return findTopLevelWindow(pid, false);
}

// ── front-end definitions ────────────────────────────────────────────────
/** Every path is relative to the app root, so the bundle can be moved. */
const GUESTS = {
  opcode: {
    label: 'opcode',
    kind: 'tauri',
    exe: ['vendor', 'opcode', 'opcode.exe'],
    cwd: ['vendor', 'opcode'],
    note: 'Claude Code 图形化工具包（原版 Tauri 应用）',
  },
  codex: {
    label: 'Codex',
    kind: 'tauri',
    exe: ['vendor', 'codex', 'codex-desktop.exe'],
    cwd: ['vendor', 'codex'],
    note: 'Codex 桌面端（原版 Tauri 应用）',
  },
  emdash: {
    label: 'Emdash',
    kind: 'electron',
    exe: ['vendor', 'emdash', 'Emdash.exe'],
    cwd: ['vendor', 'emdash'],
    note: '并行多智能体工作台（原版 Electron 应用）',
  },
  claudian: {
    label: 'Claudian',
    kind: 'obsidian',
    exe: ['vendor', 'obsidian', 'Obsidian.exe'],
    cwd: ['vendor', 'obsidian'],
    note: 'Claudian 插件（运行于随包 Obsidian 中）',
  },
};

/**
 * @param {object} deps
 * @param {string} deps.appRoot   absolute path of the app tree
 * @param {string} deps.userData  absolute path for per-user state
 * @param {(…parts: any[]) => void} [deps.log]
 * @param {() => import('electron').BrowserWindow | null} [deps.getMainWindow]
 */
module.exports = function createGuests(deps) {
  const appRoot = deps.appRoot;
  const userData = deps.userData;
  const log = deps.log || (() => {});

  /** id → { process, pid, hwnd, ownerHwnd, visible, attached, spec } */
  const running = new Map();

  const claudianState = { vaultId: 'agentdeckvault0001', pluginId: 'realclaudian' };

  function resolveGuest(id) {
    const spec = GUESTS[id];
    if (!spec) return null;
    return {
      ...spec,
      id,
      exe: path.join(appRoot, ...spec.exe),
      cwd: path.join(appRoot, ...spec.cwd),
    };
  }

  /** The display scale of a window: 96 dpi = 1.0, 144 dpi = 1.5. */
  function scaleFor(hwnd) {
    try {
      const dpi = Number(loadWin32().GetDpiForWindow(hwnd));
      return Number.isFinite(dpi) && dpi > 0 ? dpi / 96 : 1;
    } catch {
      return 1;
    }
  }

  // ── ownership ──────────────────────────────────────────────────────────
  /**
   * Make the guest's window an owned window of ours, with no title bar.
   *
   * Not SetParent: measured on the real windows, converting a guest to WS_CHILD
   * left Electron and Obsidian painting nothing and made both Tauri apps lay out
   * at the wrong scale. The style bits below do not touch the drawing path.
   */
  function attach(record, hostHwnd) {
    const w = loadWin32();
    if (!record.hwnd || !w.IsWindow(record.hwnd)) return false;

    // The panel is the app's whole surface, so the caption goes. Changing these
    // bits alone is harmless; converting the window class is not.
    const style = Number(w.GetWindowLongPtr(record.hwnd, GWL_STYLE));
    w.SetWindowLongPtr(record.hwnd, GWL_STYLE, style & ~WS_CAPTION & ~WS_THICKFRAME);

    // A tool window gets no taskbar button and never takes focus on show.
    const ex = Number(w.GetWindowLongPtr(record.hwnd, GWL_EXSTYLE));
    w.SetWindowLongPtr(record.hwnd, GWL_EXSTYLE,
      (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW);

    // On a top-level window this sets the *owner*, not the parent.
    w.SetWindowLongPtr(record.hwnd, GWLP_HWNDPARENT, Number(hostHwnd));

    w.SetWindowPos(record.hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

    // An owned window has no parent to query back, so the host handle is kept.
    record.ownerHwnd = hostHwnd;
    record.attached = true;
    return true;
  }

  /** Give the guest back to the desktop, hidden, process kept alive. */
  function detach(record) {
    const w = loadWin32();
    if (!record.hwnd || !w.IsWindow(record.hwnd)) return;
    w.SetWindowLongPtr(record.hwnd, GWLP_HWNDPARENT, 0);
    record.attached = false;
    w.ShowWindow(record.hwnd, SW_HIDE);
  }

  /**
   * Fit the guest over the slot the renderer reported.
   *
   * Measured, not assumed:
   *   • An owned window is positioned in *screen* pixels, while
   *     getBoundingClientRect reports the slot relative to the host's client
   *     area, so the host's client origin is added.
   *   • Both are physical: the slot is CSS and the display is 1.5x, so position
   *     and size are multiplied by the scale. Verified end to end — asking for
   *     (502,262) at 1650x1050 put the window exactly there.
   */
  function place(record, rect) {
    const w = loadWin32();
    if (!record.hwnd || !w.IsWindow(record.hwnd)) return;

    const scale = scaleFor(record.hwnd);
    let baseX = 0;
    let baseY = 0;
    if (record.ownerHwnd) {
      const origin = [0, 0];
      if (w.ClientToScreen(record.ownerHwnd, origin)) {
        baseX = origin[0];
        baseY = origin[1];
      }
    }

    w.MoveWindow(
      record.hwnd,
      baseX + Math.round(rect.x * scale),
      baseY + Math.round(rect.y * scale),
      Math.max(1, Math.round(rect.width * scale)),
      Math.max(1, Math.round(rect.height * scale)),
      true,
    );

    // An owned window sits above its owner, but anything else the user brings up
    // can cover it. Raising it again on every placement keeps the panel visible
    // after a panel switch, a resize, or the host regaining focus.
    if (record.visible) {
      w.SetWindowPos(record.hwnd, HWND_TOP, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
  }

  // ── Claudian: the Obsidian vault and plugin ────────────────────────────
  /**
   * Claudian is an Obsidian plugin, not an application: it has no window of its
   * own and only runs inside Obsidian, loaded from a vault's plugin folder.
   *
   * Three gates must open before Obsidian loads it, and each fails silently:
   *   1. the folder name must equal the manifest's `id` (here `realclaudian`);
   *   2. that id must appear in community-plugins.json;
   *   3. community plugins as a whole must be enabled, which Obsidian keeps in
   *      the renderer's localStorage — not in any JSON file.
   *
   * This prepares 1 and 2 plus a private profile, so Obsidian opens our vault
   * instead of the user's own. Gate 3 needs the running app.
   */
  function ensureClaudianProfile() {
    const vault = path.join(userData, 'vault');
    const profile = path.join(userData, 'obsidian-profile');
    const bundled = path.join(appRoot, 'vendor', 'claudian');

    try {
      let pluginId = 'realclaudian';
      try {
        pluginId = JSON.parse(fs.readFileSync(path.join(bundled, 'manifest.json'), 'utf8')).id || pluginId;
      } catch {
        /* keep the known id */
      }

      const pluginDir = path.join(vault, '.obsidian', 'plugins', pluginId);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.mkdirSync(profile, { recursive: true });

      for (const name of ['main.js', 'manifest.json', 'styles.css']) {
        const from = path.join(bundled, name);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(pluginDir, name));
      }

      // The published bundle externalizes its editor dependencies; inside
      // Obsidian they resolve from the plugin's own node_modules.
      const deps_ = path.join(bundled, 'node_modules');
      if (fs.existsSync(deps_)) {
        const copyTree = (from, to) => {
          fs.mkdirSync(to, { recursive: true });
          for (const e of fs.readdirSync(from, { withFileTypes: true })) {
            const a = path.join(from, e.name);
            const b = path.join(to, e.name);
            if (e.isDirectory()) copyTree(a, b);
            else if (e.isFile()) fs.copyFileSync(a, b);
          }
        };
        copyTree(deps_, path.join(pluginDir, 'node_modules'));
      }

      // Gate 2
      fs.writeFileSync(
        path.join(vault, '.obsidian', 'community-plugins.json'),
        JSON.stringify([pluginId], null, 2),
        'utf8',
      );

      const core = path.join(vault, '.obsidian', 'core-plugins.json');
      if (!fs.existsSync(core)) {
        fs.writeFileSync(core,
          JSON.stringify(['file-explorer', 'global-search', 'switcher', 'page-preview'], null, 2), 'utf8');
      }

      const readme = path.join(vault, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
          '# AgentDeck vault\n\n'
          + 'This vault hosts the Claudian plugin. It is also a working directory:\n'
          + 'the agent may read, write and run commands here.\n', 'utf8');
      }

      // Obsidian only opens a vault it has registered.
      const registryPath = path.join(profile, 'obsidian.json');
      let registry = { vaults: {} };
      if (fs.existsSync(registryPath)) {
        try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { registry = { vaults: {} }; }
      }
      if (!registry.vaults || typeof registry.vaults !== 'object') registry.vaults = {};
      for (const key of Object.keys(registry.vaults)) {
        if (key !== claudianState.vaultId) delete registry.vaults[key];
      }
      registry.vaults[claudianState.vaultId] = { path: vault, ts: Date.now(), open: true };
      fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

      claudianState.pluginId = pluginId;
    } catch (e) {
      log('vault: setup failed —', e.message);
      return null;
    }
    return profile;
  }

  /**
   * Open gate 3 inside a running Obsidian.
   *
   * The community-plugin switch lives in the renderer's localStorage, so only the
   * app itself can set it. Obsidian is Electron, so its debugging port exposes
   * that switch, and toggling it through the app's own API is what the settings
   * checkbox does. Best-effort: on failure the panel still opens, without the
   * plugin.
   */
  async function enableClaudian(debugPort) {
    const http = require('node:http');
    const getJson = (url) => new Promise((resolve) => {
      const req = http.get(url, { timeout: 1500 }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    let page = null;
    for (let i = 0; i < 40; i++) {
      const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      const pages = Array.isArray(list) ? list.filter((t) => t.type === 'page') : [];
      page = pages.find((p) => String(p.url).startsWith('app://')) || pages[0] || null;
      if (page) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) return { ok: false, error: 'Obsidian 调试端口未就绪' };

    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch (e) {
      return { ok: false, error: `缺少 ws 模块：${e.message}` };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already closed */ }
        resolve(v);
      };

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const pending = new Map();
      let nextId = 0;
      const send = (method, params) => new Promise((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

      ws.on('open', async () => {
        try {
          await send('Runtime.enable');
          const expr = `(async () => {
            try {
              const p = window.app && window.app.plugins;
              if (!p) return { ok: false, error: 'app.plugins 不可用' };
              if (!p.isEnabled()) await p.setEnable(true);
              const id = ${JSON.stringify(claudianState.pluginId)};
              if (!p.isEnabled(id)) {
                const inst = await p.loadPlugin(id);
                if (inst && !p.plugins[id]) p.plugins[id] = inst;
              }
              return { ok: Boolean(p.isEnabled(id)), communityOn: p.isEnabled(),
                loaded: Object.keys(p.plugins || {}) };
            } catch (e) {
              return { ok: false, error: String((e && e.stack) || e) };
            }
          })()`;
          const r = await send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true,
          });
          if (r && r.exceptionDetails) {
            const ex = r.exceptionDetails.exception;
            finish({ ok: false, error: (ex && ex.description) || r.exceptionDetails.text });
          } else {
            finish((r && r.result && r.result.value) || { ok: false, error: '空响应' });
          }
        } catch (e) {
          finish({ ok: false, error: String((e && e.message) || e) });
        }
      });

      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
      });
      ws.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
      setTimeout(() => finish({ ok: false, error: '启用插件超时' }), 20000);
    });
  }

  // ── public surface ─────────────────────────────────────────────────────
  function guestStatus() {
    const out = {};
    for (const id of Object.keys(GUESTS)) {
      const g = resolveGuest(id);
      const rec = running.get(id);
      out[id] = {
        label: GUESTS[id].label,
        kind: GUESTS[id].kind,
        note: GUESTS[id].note,
        installed: Boolean(g && fs.existsSync(g.exe)),
        running: Boolean(rec),
        visible: Boolean(rec && rec.visible),
        pid: rec ? rec.pid : null,
        path: g ? path.relative(appRoot, g.exe) : '',
      };
    }
    return out;
  }

  /** Live records, for diagnostics. */
  function guestRecords() {
    const out = {};
    for (const [id, rec] of running) {
      out[id] = { pid: rec.pid, hwnd: rec.hwnd.toString(), visible: rec.visible };
    }
    return out;
  }

  async function showGuest(id, hostBuf, rect) {
    if (!isWindows) {
      return { ok: false, error: 'Guest windows are attached with Win32 APIs, so this needs Windows.' };
    }
    const spec = resolveGuest(id);
    if (!spec) return { ok: false, error: `Unknown front end: ${id}` };
    if (!fs.existsSync(spec.exe)) {
      return {
        ok: false,
        missing: true,
        error: `${spec.label} 没有随包提供（缺少 ${path.relative(appRoot, spec.exe)}）`,
      };
    }
    if (!hostBuf || !rect || !rect.width || !rect.height) {
      return { ok: false, error: 'panel geometry was not reported' };
    }

    const hostHwnd = hostBuf.readBigUInt64LE
      ? hostBuf.readBigUInt64LE(0)
      : BigInt(hostBuf.readUInt32LE(0));

    let record = running.get(id);

    if (!record) {
      let args = [];
      let obsidianDebugPort = 0;
      const env = { ...process.env };

      if (id === 'claudian') {
        const profile = ensureClaudianProfile();
        const vault = path.join(userData, 'vault');
        // Obsidian resolves its profile through Electron's userData path, so a
        // private profile is a launch argument. The debugging port is how the
        // plugin switch gets turned on once it is running.
        obsidianDebugPort = 9420 + Math.floor(Math.random() * 40);
        args = [
          `--user-data-dir=${profile || path.join(userData, 'obsidian-profile')}`,
          `--remote-debugging-port=${obsidianDebugPort}`,
          vault,
        ];
      }

      let child;
      try {
        child = spawn(spec.exe, args, {
          cwd: spec.cwd,
          stdio: 'ignore',
          // Not windowsHide. That option starts the child with
          // STARTF_USESHOWWINDOW + SW_HIDE, and an Electron app then creates its
          // window hidden and never shows it: measured, Emdash stayed at
          // visible=false for 45 s that way and appeared within 1 s without it.
          // Tauri apps call ShowWindow themselves during startup, which is why
          // only opcode and Codex survived this. The brief flash before the
          // window is placed is handled below instead.
          windowsHide: false,
          env,
        });
      } catch (e) {
        return { ok: false, error: `无法启动 ${spec.label}：${e.message}` };
      }

      record = {
        id, spec, process: child, pid: child.pid,
        hwnd: 0n, ownerHwnd: 0n, attached: false, visible: false,
      };
      running.set(id, record);

      child.on('exit', (code, signal) => {
        if (running.get(id) === record) running.delete(id);
        log('guest: exited', id, `code=${code}`, `signal=${signal}`);
        const win = deps.getMainWindow?.();
        if (win && !win.isDestroyed()) win.webContents.send('guest:exit', { id, code, signal });
      });

      record.hwnd = waitForWindow(child.pid, spec.kind === 'obsidian' ? 60000 : 45000);
      if (!record.hwnd) {
        try { child.kill(); } catch { /* already gone */ }
        running.delete(id);
        return { ok: false, error: `${spec.label} 已启动但没有出现窗口。` };
      }
      log('guest: window found', id, `pid=${child.pid}`, `hwnd=${record.hwnd}`,
        `scale=${scaleFor(record.hwnd)}`);

      // Take it over the moment the window exists. An earlier version hid it for
      // a second first, to avoid a visible flash, but Electron and Obsidian then
      // finished initialising while hidden and never resumed painting.
      attach(record, hostHwnd);
      place(record, rect);

      if (id === 'claudian' && obsidianDebugPort) {
        record.plugin = await enableClaudian(obsidianDebugPort);
        log('claudian: activation', JSON.stringify(record.plugin));
        // Loading the plugin rearranged Obsidian's layout; fit it again.
        place(record, rect);
      }
    } else {
      attach(record, hostHwnd);
      place(record, rect);
    }

    loadWin32().ShowWindow(record.hwnd, SW_SHOW);
    record.visible = true;

    return {
      ok: true,
      id,
      pid: record.pid,
      hwnd: record.hwnd.toString(),
      kind: spec.kind,
      plugin: record.plugin || null,
    };
  }

  /** Hide a guest: back to the desktop, hidden, process kept alive. */
  function hideGuest(id) {
    const record = running.get(id);
    if (!record) return { ok: true, launched: false };
    if (isWindows) detach(record);
    record.visible = false;
    return { ok: true, launched: true };
  }

  function layoutGuest(id, rect) {
    const record = running.get(id);
    if (!record || !record.visible || !rect) return { ok: true, moved: false };
    place(record, rect);
    return { ok: true, moved: true };
  }

  function stopGuest(id) {
    const record = running.get(id);
    if (!record) return { ok: true };
    if (isWindows) detach(record);
    try { record.process.kill(); } catch { /* already dead */ }
    running.delete(id);
    return { ok: true };
  }

  function stopAllGuests() {
    for (const id of [...running.keys()]) stopGuest(id);
  }

  return {
    GUESTS,
    isWindows,
    resolveGuest,
    guestStatus,
    guestRecords,
    showGuest,
    hideGuest,
    layoutGuest,
    stopGuest,
    stopAllGuests,
    ensureClaudianProfile,
    loadWin32,
  };
};
