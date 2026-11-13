'use strict';

/**
 * Stamp the app icon and product metadata into the packaged executable.
 *
 * `AgentDeck.exe` is Electron's own `electron.exe` under another name, so without
 * this step Explorer shows Electron's generic icon and an empty Details tab:
 * no product name, no description, no version.
 *
 * Two resource blocks are written:
 *   • RT_GROUP_ICON / RT_ICON — the multi-size icon set, so the taskbar, the
 *     window title bar and the file list each get a properly drawn size instead
 *     of a scaled-down 256px image.
 *   • RT_VERSION — the strings Explorer's Details tab reads.
 *
 * The executable is read, patched and written whole. Electron's signature is
 * invalidated by any resource edit, but this build is unsigned to begin with, so
 * there is nothing to lose.
 *
 * Usage: node scripts/stamp-icon.js [path-to-exe]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Version metadata, kept in one place so a release only edits this. */
const PRODUCT = {
  name: 'AgentDeck',
  description: 'AgentDeck — OpenChamber, Claude Code and four desktop front ends in one window',
  version: '1.0.0',
  company: 'AgentDeck',
  copyright: 'MIT licensed',
  // 1033 = en-US, 1200 = Unicode codepage.
  lang: 1033,
  codepage: 1200,
};

/**
 * resedit is ESM-only, so it is loaded with a dynamic import from its resolved
 * location.
 *
 * It is a build-time dependency and deliberately not part of the shipped app, so
 * it lives in `_tools/node_modules` outside the app tree. Plain `import()` would
 * not look there, hence the explicit path.
 */
async function loadResedit() {
  const candidates = [
    path.join(ROOT, '_tools', 'node_modules', 'resedit', 'dist', 'index.js'),
    path.join(ROOT, 'node_modules', 'resedit', 'dist', 'index.js'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return import(pathToFileURL(file).href);
    }
  }
  throw new Error(
    'resedit is not installed. Run: cd _tools && npm install resedit',
  );
}

/**
 * Turn the .ico into the entries resedit wants.
 *
 * `IconFile.from` parses the container, and each parsed icon is handed over as a
 * raw graphic so its bytes are copied through unchanged — re-encoding them would
 * mean re-deriving the mask bitmaps, which is where icon tools usually go wrong.
 */
function readIcons(Data, icoBuffer) {
  const file = Data.IconFile.from(icoBuffer);
  return file.icons.map((item) => {
    const raw = item.data.bin;
    return Data.RawIconItem.from(
      raw,
      item.width ?? item.data.width,
      item.height ?? item.data.height,
      item.bitCount ?? 32,
    );
  });
}

function buildVersionInfo(Resource, iconEntries) {
  const existing = Resource.VersionInfo.fromEntries(iconEntries);
  const version = existing.length ? existing[0] : Resource.VersionInfo.createEmpty();

  version.setFileVersion(PRODUCT.version, PRODUCT.lang);
  version.setProductVersion(PRODUCT.version, PRODUCT.lang);

  const strings = {
    CompanyName: PRODUCT.company,
    FileDescription: PRODUCT.description,
    FileVersion: PRODUCT.version,
    InternalName: PRODUCT.name,
    LegalCopyright: PRODUCT.copyright,
    OriginalFilename: `${PRODUCT.name}.exe`,
    ProductName: PRODUCT.name,
    ProductVersion: PRODUCT.version,
  };

  // One language table is what Explorer reads; adding a second only makes the
  // Details tab show duplicate rows.
  version.setStringValues(
    { lang: PRODUCT.lang, codepage: PRODUCT.codepage },
    strings,
    true,
  );

  // A single fixed version, so the file properties do not report a mix.
  const fixed = version.fixedInfo;
  fixed.fileOS = 0x00040004; // VOS_NT_WINDOWS32
  fixed.fileType = 0x00000001; // VFT_APP
  fixed.fileSubtype = 0;

  return version;
}

async function main() {
  const target = path.resolve(
    process.argv[2] || path.join(ROOT, 'dist', 'AgentDeck', 'AgentDeck.exe'),
  );
  const icoPath = path.join(ROOT, 'app', 'assets', 'icon.ico');

  if (!fs.existsSync(target)) throw new Error(`executable not found: ${target}`);
  if (!fs.existsSync(icoPath)) {
    throw new Error(`icon not found: ${icoPath} — run app/scripts/make-icons.js first`);
  }

  const resedit = await loadResedit();
  const { NtExecutable, NtExecutableResource, Data, Resource } = resedit;

  const before = fs.statSync(target).size;
  const exe = NtExecutable.from(fs.readFileSync(target), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const entries = res.entries;

  // ── icon ────────────────────────────────────────────────────────────────
  const icons = readIcons(Data, fs.readFileSync(icoPath));

  // Electron's exe already carries an icon group; reuse its ID so the shell
  // keeps pointing at the group it knows about.
  const groups = Resource.IconGroupEntry.fromEntries(entries);
  const groupId = groups.length ? groups[0].id : 1;
  for (const g of groups) g.outputToResourceEntries(entries);
  Resource.IconGroupEntry.replaceIconsForResource(
    entries,
    groupId,
    PRODUCT.lang,
    icons,
  );

  // ── version metadata ────────────────────────────────────────────────────
  const version = buildVersionInfo(Resource, entries);
  version.outputToResourceEntries(entries);

  res.outputResource(exe);
  const out = Buffer.from(exe.generate());
  fs.writeFileSync(target, out);

  // Report what landed, so the caller does not have to trust the write.
  const check = NtExecutable.from(fs.readFileSync(target), { ignoreCert: true });
  const checkRes = NtExecutableResource.from(check);
  const checkGroups = Resource.IconGroupEntry.fromEntries(checkRes.entries);
  const iconCount = checkGroups.reduce((n, g) => n + g.icons.length, 0);
  const checkVersion = Resource.VersionInfo.fromEntries(checkRes.entries)[0];
  const langs = checkVersion ? checkVersion.getAllLanguagesForStringValues() : [];
  const values = checkVersion && langs.length
    ? checkVersion.getStringValues(langs[0])
    : {};

  console.log(`stamped ${path.basename(target)}`);
  console.log(`  size        ${(before / (1024 * 1024)).toFixed(1)} → ${(fs.statSync(target).size / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`  icon groups ${checkGroups.length}, images ${iconCount}`);
  console.log(`  ProductName ${values.ProductName || '(missing)'}`);
  console.log(`  FileVersion ${values.FileVersion || '(missing)'}`);
  console.log(`  FileDesc    ${(values.FileDescription || '(missing)').slice(0, 60)}…`);
}

main().catch((e) => {
  console.error('stamp failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
