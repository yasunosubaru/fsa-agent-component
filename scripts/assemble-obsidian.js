'use strict';
/**
 * Assemble a working x64 Obsidian from two parts:
 *
 *   • the Electron x64 runtime (official Electron release), and
 *   • Obsidian's own app.asar + obsidian.asar, taken from the vendor package.
 *
 * The vendor .exe available to this machine resolves to the ARM64 build, which
 * cannot execute here at all ("not a valid Win32 application"). Obsidian is a
 * plain Electron app, so the x64 runtime plus its own asar is the same program.
 *
 * Usage: node scripts/assemble-obsidian.js <obsidianExtractDir> <electronRuntimeDir> <outDir>
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const [,, OBS_DIR, EL_DIR, OUT_DIR] = process.argv;

if (!OBS_DIR || !EL_DIR || !OUT_DIR) {
  console.error('usage: assemble-obsidian.js <obsidianExtractDir> <electronRuntimeDir> <outDir>');
  process.exit(2);
}

const log = (...a) => console.log('[obsidian]', ...a);

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(from, to);
    else if (e.isFile()) await fsp.copyFile(from, to);
  }
}

async function main() {
  // 1. Electron x64 runtime, renamed to Obsidian.exe.
  log('copying x64 Electron runtime…');
  await fsp.mkdir(OUT_DIR, { recursive: true });
  for (const e of await fsp.readdir(EL_DIR, { withFileTypes: true })) {
    if (e.name === 'electron.exe') continue; // renamed below
    const from = path.join(EL_DIR, e.name);
    const to = path.join(OUT_DIR, e.name);
    if (e.isDirectory()) await copyDir(from, to);
    else await fsp.copyFile(from, to);
  }
  await fsp.copyFile(path.join(EL_DIR, 'electron.exe'), path.join(OUT_DIR, 'Obsidian.exe'));

  // 2. Obsidian's own application payload.
  log('copying Obsidian app payload…');
  const resOut = path.join(OUT_DIR, 'resources');
  await fsp.mkdir(resOut, { recursive: true });
  for (const name of ['app.asar', 'obsidian.asar']) {
    const from = path.join(OBS_DIR, 'resources', name);
    if (!fs.existsSync(from)) throw new Error(`missing ${from}`);
    await fsp.copyFile(from, path.join(resOut, name));
  }

  // app.asar.unpacked ships native modules Obsidian loads at runtime.
  const unpackedSrc = path.join(OBS_DIR, 'resources', 'app.asar.unpacked');
  if (fs.existsSync(unpackedSrc)) {
    await copyDir(unpackedSrc, path.join(resOut, 'app.asar.unpacked'));
    log('copied app.asar.unpacked');
  }

  // 3. Drop Electron's default app: Obsidian's asar must be the one loaded.
  const defaultApp = path.join(resOut, 'default_app.asar');
  if (fs.existsSync(defaultApp)) {
    fs.unlinkSync(defaultApp);
    log('dropped default_app.asar');
  }

  // 4. Report.
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) bytes += fs.statSync(p).size;
    }
  };
  walk(OUT_DIR);
  log(`assembled ${(bytes / 1024 / 1024).toFixed(1)} MB at ${OUT_DIR}`);
}

main().catch((e) => {
  console.error('[obsidian] failed:', e.message);
  process.exit(1);
});
