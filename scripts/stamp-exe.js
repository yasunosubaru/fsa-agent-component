'use strict';

/**
 * Stamp the packaged executable with the app's identity.
 *
 * Electron's binary ships with Electron's own icon and version resource. Renaming
 * it to AgentDeck.exe changes the filename but not what Windows shows in the task
 * bar, the Start menu, Add/Remove Programs or the file's Properties dialog — all of
 * those read the PE resources inside the file. So after the runtime is copied, the
 * resources are replaced here:
 *
 *   • an icon group holding every size the shell asks for, so 16px in the taskbar
 *     and 256px in Explorer both come from artwork drawn at that size;
 *   • a version resource naming the product, so Properties reads
 *     "AgentDeck" instead of "Electron".
 *
 * `resedit` is a build-only dependency (see ../_tools); nothing here is shipped.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXE = path.join(ROOT, 'dist', 'AgentDeck', 'AgentDeck.exe');

const PRODUCT = 'AgentDeck';
const DESCRIPTION = 'OpenChamber, Claude Code and four desktop front ends in one window';
const VERSION = '1.0.0';
const COMPANY = 'AgentDeck';

const RESEDIT = path.join(ROOT, '_tools', 'node_modules', 'resedit', 'cjs.cjs');

async function main() {
  const exePath = process.argv[2] || DEFAULT_EXE;

  if (!fs.existsSync(exePath)) {
    throw new Error(`packaged executable not found: ${exePath}`);
  }
  if (!fs.existsSync(RESEDIT)) {
    throw new Error(
      `resedit is missing (${RESEDIT}).\n`
      + 'It is a build-time tool: run `npm install` inside _tools once.',
    );
  }

  const resedit = await require(RESEDIT).load();
  const { NtExecutable, NtExecutableResource, Resource, Data } = resedit;

  // A PNG per size, assembled into an icon group. Windows picks the entry closest
  // to the size it needs instead of rescaling one bitmap, which is the difference
  // between a crisp 16px taskbar icon and a grey smudge.
  const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const iconPng = path.join(ROOT, 'app', 'assets', 'icon.png');
  const icoPath = path.join(ROOT, 'app', 'assets', 'icon.ico');

  if (!fs.existsSync(icoPath)) {
    throw new Error(
      `icon.ico is missing (${icoPath}).\n`
      + 'Run `node app/scripts/make-icons.js` to generate it.',
    );
  }

  // The .ico already holds every size as its own PNG stream, so it is parsed
  // rather than re-drawn: the directory lists each entry's offset and length.
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  const icons = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    const width = ico[base] === 0 ? 256 : ico[base];
    const height = ico[base + 1] === 0 ? 256 : ico[base + 1];
    const length = ico.readUInt32LE(base + 8);
    const offset = ico.readUInt32LE(base + 12);
    const png = ico.subarray(offset, offset + length);
    // RawIconItem carries a PNG verbatim; the width/height labels are what the
    // icon directory reports to the shell.
    icons.push(Data.RawIconItem.from(png, width, height, 32));
  }

  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  // ── icon ────────────────────────────────────────────────────────────────
  // Group 1 is the application icon (group 3 is a document icon, 4 a folder).
  const GROUP_ID = 1;
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, GROUP_ID, 1033, icons,
  );

  // ── version info ────────────────────────────────────────────────────────
  const fixed = {
    fileVersionMS: (1 << 16) | 0,
    fileVersionLS: 0,
    productVersionMS: (1 << 16) | 0,
    productVersionLS: 0,
    fileFlagsMask: 0x3f,
    fileFlags: 0,
    fileOS: 0x00040004, // VOS_NT_WINDOWS32
    fileType: 1, // VFT_APP
    fileSubtype: 0,
  };

  const strings = [{
    lang: 1033,
    codepage: 1200,
    values: {
      CompanyName: COMPANY,
      FileDescription: DESCRIPTION,
      FileVersion: `${VERSION}.0`,
      InternalName: PRODUCT,
      LegalCopyright: `Copyright (c) ${new Date().getFullYear()} ${COMPANY}`,
      OriginalFilename: `${PRODUCT}.exe`,
      ProductName: PRODUCT,
      ProductVersion: `${VERSION}.0`,
    },
  }];

  const versionInfo = Resource.VersionInfo.create(1033, fixed, strings);
  versionInfo.lang = 1033;
  versionInfo.outputToResourceEntries(res.entries);

  res.outputResource(exe);

  // Write beside the target first, then swap: an interrupted write then leaves a
  // valid executable rather than a truncated one.
  const staging = `${exePath}.stamped`;
  fs.writeFileSync(staging, Buffer.from(exe.generate()));
  fs.renameSync(staging, exePath);

  const size = fs.statSync(exePath).size;
  console.log(`[stamp] icon: ${icons.length} sizes (${SIZES.join('/')}) -> group ${GROUP_ID}`);
  console.log(`[stamp] version: ${PRODUCT} ${VERSION} — "${DESCRIPTION}"`);
  console.log(`[stamp] ${exePath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error('[stamp] failed:', e.message);
  process.exit(1);
});
