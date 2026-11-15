'use strict';

/**
 * Guest front ends.
 *
 * Two bundled front ends (Codex, cdesktop) are complete
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
  // Codex: the official desktop app from OpenAI's MSIX package. Its inference is
  // configured in %USERPROFILE%\.codex\config.toml — a provider block with an inline
  // bearer token, so no environment variable is needed when another process launches
  // it.
  codex: {
    label: 'Codex',
    kind: 'electron',
    exe: ['vendor', 'codex-official', 'ChatGPT.exe'],
    cwd: ['vendor', 'codex-official'],
    note: 'Codex 官方桌面端（OpenAI 原版）',
  },
  // Claude Code: the official Claude Desktop app, running in its third-party
  // deployment mode. That mode is the documented enterprise path: it never contacts
  // Anthropic for identity, so no sign-in is needed, and inference goes to the
  // gateway named in %LOCALAPPDATA%\Claude-3p\configLibrary\.
  claude: {
    label: 'Claude Code',
    kind: 'electron',
    exe: ['vendor', 'claude-official', 'claude.exe'],
    cwd: ['vendor', 'claude-official'],
    note: 'Claude Code 官方桌面端（3p 网关模式）',
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
    //
    // But not for these guests. Measured on both shapes that ship now — the
    // official Codex app (Electron/Chromium) and cdesktop (Tauri/WebView2) —
    // setting WS_EX_TOOLWINDOW makes the app re-hide its own window: ShowWindow
    // succeeds, and IsWindowVisible still reports false a second later. Removing
    // the bit and calling ShowWindow makes it visible immediately.
    //
    // A taskbar button is a smaller loss than an invisible panel.
    const ex = Number(w.GetWindowLongPtr(record.hwnd, GWL_EXSTYLE));
    w.SetWindowLongPtr(record.hwnd, GWL_EXSTYLE,
      (ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW);

    // On a top-level window this sets the *owner*, not the parent.
    w.SetWindowLongPtr(record.hwnd, GWLP_HWNDPARENT, Number(hostHwnd));

    w.SetWindowPos(record.hwnd, 0n, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

    // An owned window has no parent to query back, so the host handle is kept.
    record.ownerHwnd = hostHwnd;
    record.attached = true;
    return true;
  }

  /**
   * Show a window and confirm the window manager agrees.
   *
   * Calling ShowWindow once is not enough for these apps. Measured: Codex shows,
   * then hides itself again a moment later, so after the call the panel looked
   * empty even though the log said the window was reshown. Repeating the call
   * until IsWindowVisible actually reports true is what makes it stick.
   *
   * The retries are asynchronous on purpose. A synchronous wait here would block
   * the main process — the same process that owns the window being shown — so the
   * app could not finish whatever it was doing before being told to show itself.
   */
  async function showUntilVisible(record, attempts = 10) {
    const w = loadWin32();
    for (let i = 0; i < attempts; i++) {
      w.ShowWindow(record.hwnd, SW_SHOW);
      w.SetWindowPos(record.hwnd, HWND_TOP, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      if (w.IsWindowVisible(record.hwnd)) {
        record.visible = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    // The last real state wins: reporting success for a window nobody can see would
    // only hide the problem behind a green flag.
    record.visible = Boolean(w.IsWindowVisible(record.hwnd));
    return record.visible;
  }

  /** Give the guest back to the desktop, hidden, process kept alive. */
  function detach(record) {    const w = loadWin32();
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

    // A record can outlive its window: an app that closes its own window leaves
    // the process alive, and `IsWindow` then fails on the stored handle. Treating
    // that as "already running" would attach and show nothing while reporting
    // success, so the stale record is dropped and the app is launched again.
    if (record && record.hwnd && !loadWin32().IsWindow(record.hwnd)) {
      log('guest: window gone, relaunching', id, `hwnd=${record.hwnd}`);
      try { record.process.kill(); } catch { /* already dead */ }
      running.delete(id);
      record = null;
    }

    if (!record) {
      let args = [];
      const env = { ...process.env };

      let child;
      try {
        child = spawn(spec.exe, args, {
          cwd: spec.cwd,
          stdio: 'ignore',
          // Not windowsHide. That option starts the child with
          // STARTF_USESHOWWINDOW + SW_HIDE, and an Electron app then creates its
          // window hidden and never shows it — measured, an Electron guest stayed
          // at visible=false for 45 s that way and appeared within 1 s without it.
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

      record.hwnd = waitForWindow(child.pid, 45000);
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
    } else {
      attach(record, hostHwnd);
      place(record, rect);
    }

    await showUntilVisible(record);

    return {
      ok: record.visible,
      id,
      pid: record.pid,
      hwnd: record.hwnd.toString(),
      kind: spec.kind,
      plugin: record.plugin || null,
      error: record.visible ? '' : `${spec.label} 的窗口未能显示出来。`,
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

  /**
   * Move a guest over its slot, showing it again if it had been hidden.
   *
   * The earlier version returned early for a hidden window, which broke the most
   * ordinary thing a user does: click Claude, click Codex, click Claude again. The
   * second visit found the guest still running but hidden — switching panels hides
   * the guest that is no longer active — so the "already running" path did nothing
   * but reposition, and the panel stayed empty. Measured: `visible=false` after
   * every return visit while the process was alive.
   *
   * Showing a hidden guest is the whole point of bringing its panel forward, so
   * that happens here rather than only on first launch.
   */
  async function layoutGuest(id, rect, hostBuf) {
    const record = running.get(id);
    if (!record || !rect) return { ok: true, moved: false };
    if (!record.hwnd || !loadWin32().IsWindow(record.hwnd)) {
      return { ok: false, moved: false, error: 'guest window is gone' };
    }

    if (!record.visible) {
      // Re-establish ownership as well as visibility: hideGuest un-owned the window,
      // and showing it again without an owner would put it behind other windows
      // instead of over its panel. The host handle comes from the caller because an
      // owned window cannot report its owner back through GetParent.
      const owner = hostBuf && hostBuf.length
        ? (hostBuf.readBigUInt64LE ? hostBuf.readBigUInt64LE(0) : BigInt(hostBuf.readUInt32LE(0)))
        : record.ownerHwnd;
      if (owner) attach(record, owner);
      await showUntilVisible(record);
      log('guest: reshown', id, `hwnd=${record.hwnd}`, `owner=${owner}`,
        `visible=${record.visible}`);
    }

    place(record, rect);
    return { ok: true, moved: true, reshown: true };
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
    loadWin32,
  };
};
