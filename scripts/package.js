'use strict';

/**
 * Package AgentDeck into a single self-contained folder and a one-file
 * installer-free layout:
 *
 *   dist/AgentDeck/
 *     AgentDeck.exe        ← renamed electron.exe
 *     *.dll, *.pak, ...    ← Electron runtime
 *     resources/app/       ← this whole app tree (JS, node_modules, vendor)
 *
 * No installer, no network: the folder is the app. `AgentDeck.exe` is the
 * Electron binary with the app path supplied through the adjacent `app`
 * folder, which is how Electron finds a packaged app.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'AgentDeck');

const APP_DIR = path.join(ROOT, 'app');
const ELECTRON_DIR = ROOT; // electron.exe and its DLLs live at the root

const args = process.argv.slice(2);
const skipCopy = args.includes('--skip-copy');

const log = (...a) => console.log('[package]', ...a);

async function rmrfQuiet(target) {
  // Deleting prior build output is the one destructive step. It is confined to
  // the project's own dist folder and uses Node's fs.rm, which is what a build
  // pipeline needs; the guard below keeps it from ever leaving dist.
  const resolved = path.resolve(target);
  if (!resolved.startsWith(DIST + path.sep) && resolved !== DIST) {
    throw new Error(`refusing to remove outside dist: ${resolved}`);
  }
  // Windows reports ENOTEMPTY on a directory whose child could not be removed —
  // an antivirus scan or a file indexer holding it open for a moment is enough.
  // Retrying is the difference between a build that usually works and one that
  // does, since the handle is released within tens of milliseconds.
  await fsp.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

async function copyDir(src, dest, filter) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (filter && !filter(from, entry)) continue;
    if (entry.isDirectory()) {
      await copyDir(from, to, filter);
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(from);
      await fsp.symlink(link, to).catch(() => {});
    } else {
      await fsp.copyFile(from, to);
    }
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

async function main() {
  log('root =', ROOT);
  await fsp.mkdir(DIST, { recursive: true });

  if (!skipCopy) {
    log('clearing previous output…');
    await rmrfQuiet(OUT);
    await fsp.mkdir(OUT, { recursive: true });

    // 1. Electron runtime files.
    //
    // The root is also the development workspace, so it holds things that must
    // never ship: the app tree (copied into resources/app instead), this script's
    // own output, screenshots, and the build-time tool directory. The rule is a
    // whitelist by pattern rather than a list of names, because directories like
    // capture-dpi7 were appearing in the bundle one at a time.
    log('copying Electron runtime…');
    const skipExact = new Set([
      'app', 'dist', 'node_modules', 'scripts', '_tools',
      // Build outputs kept beside the workspace: release parts, and the staging
      // clone used to publish the repository. Neither belongs in the app.
      'release', 'release-verify', 'repo', 'dl-check',
      'out.txt', 'err.txt', 'package-lock.json', 'package.json',
      // electron.exe is copied under its product name in step 3.
      'electron.exe',
    ]);
    // Development scratch space: screenshots, probe logs, one-off test builds.
    const skipPattern = /^(capture|probe|shot|test|tmp|_)/i;
    // Build logs and notes written next to the runtime while working on it.
    const skipFilePattern = /^(pkg-|FINDINGS|new-claudian-block)/i;

    for (const entry of fs.readdirSync(ELECTRON_DIR, { withFileTypes: true })) {
      if (skipExact.has(entry.name)) continue;
      if (skipPattern.test(entry.name)) continue;
      if (!entry.isDirectory() && skipFilePattern.test(entry.name)) continue;
      const from = path.join(ELECTRON_DIR, entry.name);
      const to = path.join(OUT, entry.name);
      if (entry.isDirectory()) {
        await copyDir(from, to);
      } else {
        await fsp.copyFile(from, to);
      }
    }

    // 2. The app itself under resources/app.
    log('copying app tree…');
    const appDest = path.join(OUT, 'resources', 'app');
    // Front ends that are no longer part of the product. Their sources stay in the
    // working tree (removing files is not this script's job) but they must not
    // travel in the bundle: together they are ~1.8 GB of dead weight.
    const retiredVendor = new Set(['opcode', 'emdash', 'obsidian', 'claudian', 'codex', 'cdesktop']);
    await copyDir(APP_DIR, appDest, (from, entry) => {
      // Skip test/map noise that ships inside dependencies.
      if (entry.isDirectory() && entry.name === '.bin') return false;
      // Retired front ends, matched by their position under vendor/.
      if (entry.isDirectory()
        && path.basename(path.dirname(from)) === 'vendor'
        && retiredVendor.has(entry.name)) return false;
      // Backups next to a vendor bundle: strip-telemetry-key.js keeps the
      // original beside the patched file, and that original still contains the
      // analytics key, so it must never travel with the app.
      if (!entry.isDirectory() && entry.name.endsWith('.bak')) return false;
      // The asar backup taken before patching: it holds the original key.
      if (!entry.isDirectory() && /\.bak-asar$/.test(entry.name)) return false;
      return true;
    });

    // 3. Main executable.
    //
    // A copied electron.exe keeps Electron's own icon and version resource, so
    // this is only the copy: the resources are replaced in step 6, once the whole
    // tree is in place.
    const exeSrc = path.join(ELECTRON_DIR, 'electron.exe');
    const exeDest = path.join(OUT, 'AgentDeck.exe');
    await fsp.copyFile(exeSrc, exeDest);
    log('renamed electron.exe → AgentDeck.exe');

    // 4. Remove Electron's default app so ours is the only one.
    const defaultApp = path.join(OUT, 'resources', 'default_app.asar');
    if (fs.existsSync(defaultApp)) {
      fs.unlinkSync(defaultApp);
      log('dropped default_app.asar');
    }

    // 4a. Strip the vendored front end's own analytics key.
    //
    // opcode's compiled bundle hardcodes its author's PostHog project key. Left in
    // place, whatever opcode records is sent to their analytics project rather
    // than staying on this machine. The key is blanked to "", which PostHog reads
    // as "not configured" and skips the request entirely.
    const telemetryScript = path.join(ROOT, 'scripts', 'strip-telemetry-key.js');
    if (fs.existsSync(telemetryScript)) {
      try {
        const out = spawnSync(process.execPath,
          [telemetryScript, path.join(OUT, 'resources', 'app', 'vendor', 'opcode')],
          { encoding: 'utf8' });
        for (const line of String(out.stdout || '').trim().split(/\r?\n/)) {
          if (line) log('  ' + line);
        }
        if (out.status !== 0) log('  telemetry strip reported failure:', String(out.stderr || '').slice(0, 200));
      } catch (e) {
        log('  telemetry strip failed:', e.message);
      }
    }

    // 4c. Emdash's payload is an asar, which needs its own approach: the key is
    //     inside a JS string, so the file is patched byte-for-byte at equal length
    //     rather than being repacked.
    const asarPatcher = path.join(ROOT, 'scripts', 'blank-asar-key.js');
    const emdashAsar = path.join(OUT, 'resources', 'app', 'vendor', 'emdash', 'resources', 'app.asar');
    if (fs.existsSync(asarPatcher) && fs.existsSync(emdashAsar)) {
      try {
        const out = spawnSync(process.execPath, [asarPatcher, emdashAsar], { encoding: 'utf8' });
        for (const line of String(out.stdout || '').trim().split(/\r?\n/)) {
          if (line) log('  ' + line);
        }
        if (out.status !== 0) log('  asar patch failed:', String(out.stderr || '').slice(0, 300));
      } catch (e) {
        log('  asar patch failed:', e.message);
      }
    }

    // 4d. Remove this machine's account name from the compiled front ends.
    //
    // rustc writes each crate's absolute source path into the binary for panic
    // messages, so these two executables contain `C:\Users\<name>\.cargo\…`.
    // That is the build machine's username and must not be published. Rebuilding
    // with --remap-path-prefix would be the proper fix, but these are third-party
    // binaries, so the bytes are replaced in place at identical length — which
    // keeps every offset in the file valid.
    const binSanitizer = path.join(ROOT, 'scripts', 'sanitize-binary-user.js');
    if (fs.existsSync(binSanitizer)) {
      const exes = [
        path.join(OUT, 'resources', 'app', 'vendor', 'opcode', 'opcode.exe'),
        path.join(OUT, 'resources', 'app', 'vendor', 'codex', 'codex-desktop.exe'),
      ];
      for (const exe of exes) {
        if (!fs.existsSync(exe)) continue;
        try {
          const out = spawnSync(process.execPath, [binSanitizer, exe], { encoding: 'utf8' });
          const said = String(out.stdout || '').trim();
          if (said) log('  ' + said.replace(/\n\s*/g, '\n  '));
          if (out.status !== 0) log('  binary sanitize failed:', String(out.stderr || '').slice(0, 200));
        } catch (e) {
          log('  binary sanitize failed:', e.message);
        }
      }
    }

    // 4b. Emdash's bundled runtime is a nested Electron app. Its own resources
    //     must stay untouched, so the generic trim below skips that subtree.
    const emdashRoot = path.join(OUT, 'resources', 'app', 'vendor', 'emdash');

    // 5. Trim what the bundled agents never load at runtime: source maps,
    //    TypeScript sources, docs and third-party test trees. This is purely a
    //    size measure, so the rules are deliberately narrow: nothing that a
    //    runtime could import by path is ever removed.
    log('trimming sources/maps/tests from node_modules…');
    let trimmed = 0;

    const removableFile = (name) => {
      // A file is only removable when its extension cannot be loaded as code.
      if (/\.(js|mjs|cjs|jsx|tsx|node|json|wasm|html|css|png|svg|woff2?|ttf|exe|dll)$/i.test(name)) return false;
      if (name.endsWith('.map')) return true;
      if (name.endsWith('.md') || name.endsWith('.markdown')) return true;
      // TypeScript sources are dead weight, but .d.ts files stay: some tools
      // resolve types from them at runtime.
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) return true;
      if (/^(README|CHANGELOG|HISTORY|CONTRIBUTING|AUTHORS|NOTICE)(\.|$)/i.test(name)) return true;
      return false;
    };

    const walkTrim = (dir) => {
      // A guest front end ships its own runtime under vendor/, including its own
      // node_modules trees. Those are the vendor's files, so the trimmer never
      // descends into vendor at all — deleting a directory that merely happens
      // to be named "stubs" or "test" there broke Emdash once.
      //
      // app/docs is excluded too: those files are shown inside the app itself, so
      // they are product content rather than build leftovers.
      const keepDocs = path.resolve(dir) === path.resolve(path.join(OUT, 'resources', 'app', 'docs'));
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'vendor') continue;
          if (keepDocs && entry.name === 'docs') continue;
          // Third-party test trees: never imported by the app itself.
          if (entry.name === '__tests__' || entry.name === 'test' || entry.name === 'tests') {
            try {
              trimmed += dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
            } catch { /* locked file: leave it */ }
            continue;
          }
          walkTrim(p);
        } else if (entry.isFile() && !keepDocs && removableFile(entry.name)) {
          try {
            trimmed += fs.statSync(p).size;
            fs.rmSync(p, { force: true });
          } catch { /* locked: leave it */ }
        }
      }
    };
    // Only our own dependency tree is trimmed; guest runtimes are untouched.
    walkTrim(path.join(OUT, 'resources', 'app', 'node_modules'));
    log(`trimmed ${(trimmed / (1024 * 1024)).toFixed(1)} MB of sources, maps and docs`);

    // 5b. Strip debug leftovers from the bundle.
    //
    // While developing, `o.txt` / `e.txt` / `debug.log` were written beside the
    // guest executables to capture their stdout. Those files carry this
    // machine's absolute paths and would ship with the app, so they are removed
    // by name here rather than relying on someone remembering.
    const strays = /^(o|e|out|err)\.txt$|^debug\.log$|^\.DS_Store$/i;
    let removedStrays = 0;
    const walkStrays = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          // Guest runtimes keep their own files, but a debug log is never theirs.
          walkStrays(p);
          continue;
        }
        if (!strays.test(e.name)) continue;
        // LICENSE.electron.txt is legitimate; the pattern above cannot match it.
        try {
          fs.rmSync(p, { force: true });
          removedStrays++;
        } catch { /* locked: leave it */ }
      }
    };
    walkStrays(path.join(OUT, 'resources', 'app', 'vendor'));
    if (removedStrays) log(`removed ${removedStrays} debug leftover file(s) from guest runtimes`);
  }

  // 5. Write a small launcher note + verify the required pieces exist.
  const required = [
    path.join(OUT, 'AgentDeck.exe'),
    path.join(OUT, 'resources', 'app', 'package.json'),
    path.join(OUT, 'resources', 'app', 'src', 'main', 'main.js'),
    path.join(OUT, 'resources', 'app', 'vendor', 'opencode', 'opencode.exe'),
    path.join(OUT, 'resources', 'app', 'vendor', 'node', 'node.exe'),
    path.join(OUT, 'resources', 'app', 'vendor', 'ripgrep', 'rg.exe'),
    path.join(OUT, 'resources', 'app', 'node_modules', 'claude-code-best', 'dist', 'cli-node.js'),
    path.join(OUT, 'resources', 'app', 'node_modules', '@openchamber', 'web', 'server', 'index.js'),
    path.join(OUT, 'resources', 'app', 'node_modules', '@openchamber', 'web', 'dist', 'index.html'),
    // guest front ends
    // The official Codex desktop app: an Electron build extracted from its MSIX
    // package. The extracted tree runs standalone (measured, no MSIX identity).
    path.join(OUT, 'resources', 'app', 'vendor', 'codex-official', 'ChatGPT.exe'),
    path.join(OUT, 'resources', 'app', 'vendor', 'codex-official', 'resources', 'app.asar'),
    // The official Claude Desktop, running in its third-party deployment mode.
    path.join(OUT, 'resources', 'app', 'vendor', 'claude-official', 'claude.exe'),
    path.join(OUT, 'resources', 'app', 'vendor', 'claude-official', 'resources', 'app.asar'),    // The Anthropic-protocol translator: Claude Code needs it to reach providers
    // that serve open models only on the OpenAI wire.
    path.join(OUT, 'resources', 'app', 'vendor', 'shim', 'anthropic_shim.py'),
    // Docker Sandboxes, bundled with its kernel and root filesystems so no system
    // install is required.
    path.join(OUT, 'resources', 'app', 'vendor', 'sbx', 'bin', 'sbx.exe'),
    path.join(OUT, 'resources', 'app', 'vendor', 'sbx', 'libexec', 'nerdbox-kernel-x86_64'),
    path.join(OUT, 'resources', 'app', 'vendor', 'sbx', 'libexec', 'nerdbox-rootfs-x86_64.erofs'),
    path.join(OUT, 'resources', 'app', 'node_modules', 'koffi'),
  ];

  let missing = 0;
  for (const p of required) {
    const ok = fs.existsSync(p);
    if (!ok) missing++;
    log(ok ? 'ok   ' : 'MISS ', path.relative(OUT, p));
  }

  // 6. Stamp the executable with the app's own icon and version resource.
  //
  //    The file is Electron's binary under another name, so without this it shows
  //    Electron's icon in the taskbar and "Electron" in its Properties — Windows
  //    reads those from the PE resources, not from the filename. The stamp runs
  //    after the copy and before the check below, so a failure to write the
  //    resources is reported as a broken build rather than shipped silently.
  if (!skipCopy) {
    log('stamping icon and version resource onto AgentDeck.exe…');
    const stamp = path.join(ROOT, 'scripts', 'stamp-exe.js');
    if (!fs.existsSync(stamp)) {
      log('stamp-exe.js is missing — the exe would ship with Electron’s icon');
      process.exitCode = 1;
    } else {
      try {
        const { execFileSync } = require('node:child_process');
        const out = execFileSync(
          process.execPath,
          [stamp, path.join(OUT, 'AgentDeck.exe')],
          { encoding: 'utf8' },
        );
        for (const line of out.trim().split(/\r?\n/)) log(line.replace(/^\[stamp\]\s*/, '  '));
      } catch (e) {
        log('STAMP FAILED:', (e.stderr || e.message || '').toString().trim().slice(0, 400));
        process.exitCode = 1;
      }
    }
  }

  const mb = dirSize(OUT) / (1024 * 1024);
  log(`bundle size: ${mb.toFixed(1)} MB`);

  if (missing) {
    log(`${missing} required file(s) missing — bundle is INCOMPLETE`);
    process.exitCode = 1;
  } else {
    log('bundle complete');
  }
}

main().catch((e) => {
  console.error('[package] failed:', e);
  process.exitCode = 1;
});
