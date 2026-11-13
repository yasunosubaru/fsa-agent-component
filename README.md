# fsa-agent-component

Six Claude Code front ends in a single self-contained Windows desktop application.

One window hosts all of them. Switching is a rail on the left; the app itself is
the only thing shipped — no installer, no runtime to fetch, no external
dependency of any kind.

## What it bundles

| Front end | How it runs |
|---|---|
| **OpenChamber** | Its own web UI in an embedded `WebContentsView`, served by a bundled server against a bundled `opencode.exe` |
| **Claude Code** | The original Ink TUI in `xterm.js`, driven through `node-pty` by a bundled `node.exe` |
| **opcode** | The original Tauri application, in its own process |
| **Codex** | The original Tauri application, in its own process |
| **Emdash** | The original Electron application, in its own process |
| **Claudian** | The plugin running inside a bundled Obsidian, against a private vault |

Each front end keeps its own backend. Nothing is reimplemented and no UI is
mocked: the four external applications are the vendors' own binaries.

## How the panels work

Setting a child window with `SetParent` was the obvious approach and it failed.
Measured on the real windows, converting a guest to `WS_CHILD` left Emdash and
Obsidian painting nothing at all and made both Tauri apps lay their content out
at the wrong scale — Chromium's compositor does not take kindly to having its
window reclassified.

The panels are therefore **owned windows**: `GWLP_HWNDPARENT` is set to the host
window, the caption and resize frame are dropped, and the window is placed over
the slot the renderer reports. An owned window stays a top-level window, so the
guest renders exactly as it does when launched on its own, while Windows keeps it
above the owner, out of the taskbar, and hidden when the owner is minimised.

Two things had to be discovered the hard way:

- Guests must **not** be spawned with `windowsHide: true`. That starts the child
  with `STARTF_USESHOWWINDOW + SW_HIDE`, and an Electron app then creates its
  window hidden and never shows it — measured: Emdash stayed at `visible=false`
  for 45 seconds that way, and appeared within 1 second without it. Tauri apps
  call `ShowWindow` themselves during startup, which is why only two of the four
  worked.
- The wait must be for a **visible** window, not merely an existing one. A guest
  process owns several top-level windows — helper surfaces, a notify-icon host,
  an IME window — and Obsidian creates a hidden window before showing the real
  one. Binding to whatever existed first attaches the panel to a window that is
  never seen.

Placement is then checked rather than assumed: the window rect, the slot, and the
display scale are compared after every switch, and the log records
`posOK` / `sizeOK` / `visible`.

## Requirements

Windows 10 or 11, x64. Nothing else — there is no installer and no prerequisite.

## Building

```powershell
node app/scripts/make-icons.js      # regenerate the icon set
node scripts/package.js             # produce dist/AgentDeck/
```

`scripts/package.js` also stamps the executable's icon and version resource, and
runs the sanitisation steps described below. `node scripts/verify.js` checks 31
properties of the finished bundle.

## Sanitisation

A packaged app inherits whatever the build machine had. The build removes, in
order:

- the vendored front end's own analytics key, blanked to `""` so no event is sent
  to a third party;
- the same key inside Emdash's asar payload, patched at equal length so the
  archive's offsets stay valid;
- this machine's account name, which `rustc` bakes into the compiled Tauri
  binaries as absolute crate paths;
- debug logs and patch backups left beside the guest executables.

Each step is part of the build, not a manual cleanup, so a rebuild cannot
reintroduce them.

## Licences

The bundled applications keep their own licences; see `LICENSES.chromium.html`,
`LICENSE`, and each vendor directory under `resources/app/vendor`.
