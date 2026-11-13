'use strict';

/**
 * Blank a third-party analytics key inside an asar archive.
 *
 * Emdash's bundled payload has its author's PostHog key inlined as
 * `VITE_POSTHOG_KEY: "phc_…"`. Left in place, everything Emdash records goes to
 * their analytics project rather than staying on this machine.
 *
 * An asar is a small JSON index followed by the concatenated file bodies, so it is
 * *not* a compressed archive — a byte-for-byte substitution works. Replacing the
 * key with an equally long run of slashes keeps the file size identical, which
 * matters because the index records each file's offset: changing a length would
 * shift every following file and corrupt the archive.
 *
 * Usage: node blank-asar-key.js <app.asar> [--dry-run]
 */

const fs = require('node:fs');

const KEY_RE = /phc_[A-Za-z0-9]{20,}/g;

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  return { jsonLen, json: JSON.parse(jsonBuf.toString('utf8')) };
}

function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!file) {
    console.error('usage: node blank-asar-key.js <app.asar> [--dry-run]');
    process.exit(2);
  }

  const fd = fs.openSync(file, 'r');
  let header;
  try {
    header = readHeader(fd);
  } finally {
    fs.closeSync(fd);
  }
  // The payload starts right after the header block, which is 8 bytes of pickle
  // framing plus the JSON index.
  const payloadStart = 16 + header.jsonLen;
  console.log(`archive: ${(fs.statSync(file).size / (1024 * 1024)).toFixed(0)} MB, index ${(header.jsonLen / 1024).toFixed(0)} KB, payload from byte ${payloadStart}`);

  const buf = fs.readFileSync(file);
  const payload = buf.subarray(payloadStart);
  let text = payload.toString('latin1');

  const found = text.match(KEY_RE);
  if (!found) {
    console.log('no analytics key in payload (already clean)');
    return;
  }

  // Same-length substitution: the index stores offsets and sizes, so the total
  // must not change by a single byte.
  const out = Buffer.from(buf);
  let count = 0;
  for (const key of found) {
    const repl = '/'.repeat(key.length);
    const idx = text.indexOf(key);
    if (idx < 0) continue;
    Buffer.from(repl, 'latin1').copy(out, payloadStart + idx);
    // Blank it in the working copy of the text so a duplicate key later in the
    // payload is not matched at the same offset again.
    text = text.slice(0, idx) + repl + text.slice(idx + key.length);
    count++;
  }

  if (out.length !== buf.length) {
    throw new Error(`size changed ${buf.length} -> ${out.length}; refusing to write`);
  }

  if (dryRun) {
    console.log(`dry run: would blank ${count} key(s)`);
    return;
  }

  fs.writeFileSync(file, out);
  console.log(`blanked ${count} analytics key(s); size unchanged (${out.length} bytes)`);
}

main();
