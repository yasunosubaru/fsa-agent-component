'use strict';

/**
 * Split a large file into release-sized parts.
 *
 * GitHub caps a release asset at 2 GiB. This bundle is 2.28 GiB, so it is cut
 * into parts below the limit and shipped with a small reassembly note. The split
 * is byte-exact: concatenating the parts reproduces the original, which is what
 * the checksums prove.
 *
 * Usage: node split-release.js <file> <out-dir> [partSizeMiB]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const file = process.argv[2];
const outDir = process.argv[3];
const partMiB = Number(process.argv[4] || 1200);

if (!file || !outDir) {
  console.error('usage: node split-release.js <file> <out-dir> [partSizeMiB]');
  process.exit(2);
}

const size = fs.statSync(file).size;
const partSize = partMiB * 1024 * 1024;
const parts = Math.ceil(size / partSize);

fs.mkdirSync(outDir, { recursive: true });

const base = path.basename(file);
const src = fs.openSync(file, 'r');

const wholeHash = crypto.createHash('sha256');
const partHashes = [];

const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
let written = 0;

for (let i = 0; i < parts; i++) {
  const name = `${base}.part${String(i + 1).padStart(2, '0')}`;
  const dest = path.join(outDir, name);
  const fd = fs.openSync(dest, 'w');
  const hash = crypto.createHash('sha256');

  let remaining = Math.min(partSize, size - i * partSize);
  while (remaining > 0) {
    const want = Math.min(buf.length, remaining);
    const got = fs.readSync(src, buf, 0, want, null);
    if (got <= 0) throw new Error(`unexpected end of file at part ${i + 1}`);

    const slice = buf.subarray(0, got);
    fs.writeSync(fd, slice);
    hash.update(slice);
    wholeHash.update(slice);

    remaining -= got;
    written += got;
  }

  fs.closeSync(fd);

  const digest = hash.digest('hex');
  partHashes.push({ name, size: fs.statSync(dest).size, sha256: digest });
  console.log(`${name}  ${(fs.statSync(dest).size / (1024 * 1024)).toFixed(0)} MB  sha256=${digest.slice(0, 16)}…`);
}

fs.closeSync(src);

if (written !== size) {
  throw new Error(`split produced ${written} bytes, expected ${size}`);
}

const total = wholeHash.digest('hex');
console.log('');
console.log(`parts: ${parts}, total ${(size / (1024 * 1024)).toFixed(1)} MB`);
console.log(`sha256(original) = ${total}`);

// A manifest is what makes the parts verifiable after download and reassembly.
const manifest = {
  file: base,
  size,
  sha256: total,
  parts: partHashes,
  reassemble: `concatenate part01..partNN in order, then verify sha256 = ${total}`,
};
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`manifest: ${path.join(outDir, 'SHA256SUMS.json')}`);
