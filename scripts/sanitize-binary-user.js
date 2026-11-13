'use strict';

/**
 * Replace this machine's username inside compiled binaries.
 *
 * The two Tauri front ends were compiled on this machine, and rustc bakes the
 * source path of every crate into the binary for panic messages:
 *
 *   C:\Users\<account>\.cargo\registry\src\index.crates.io-…\tauri-2.5.1\src\state.rs
 *
 * That is the build machine's account name, which has no business in a published
 * release. Rebuilding with `--remap-path-prefix` would be the clean fix, but these
 * are third-party binaries we cannot rebuild, so the bytes are replaced in place.
 *
 * The replacement is the **same length**, which is what makes this safe: every
 * string, symbol offset, and section in the file keeps its exact position, so
 * nothing that references these paths by address can shift.
 *
 * Usage: node sanitize-binary-user.js <file.exe> [--user NAME] [--dry-run]
 * Without --user the account name is taken from the environment, so the script
 * carries no one's name in the repository."
 *
 * Only printable runs are touched, and the file's size is verified unchanged.
 *
 * Usage: node sanitize-binary-user.js <file.exe> [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!file) {
  console.error('usage: node sanitize-binary-user.js <file.exe> [--user NAME] [--dry-run]');
  process.exit(2);
}

/**
 * The account name to scrub, taken from the command line or the environment.
 *
 * Deliberately not hardcoded: this script ships in a public repository, and
 * storing one person's account name in it would leak exactly what the script
 * exists to remove.
 */
const userArgIdx = process.argv.indexOf('--user');
const accountName = userArgIdx > 0 && process.argv[userArgIdx + 1]
  ? process.argv[userArgIdx + 1]
  : (process.env.USERNAME || process.env.USER || '');

if (!accountName) {
  console.error('no account name given: pass --user NAME or set USERNAME');
  process.exit(2);
}

/** Same length is mandatory: the replacement matches the source byte for byte. */
const REPLACEMENTS = [
  { from: accountName, to: 'x'.repeat(accountName.length) },
];

const original = fs.readFileSync(file);
const sizeBefore = original.length;
const out = Buffer.from(original);

let total = 0;
for (const { from, to } of REPLACEMENTS) {
  if (from.length !== to.length) {
    throw new Error(`replacement length mismatch: ${from} (${from.length}) vs ${to} (${to.length})`);
  }
  const needle = Buffer.from(from, 'utf8');
  const repl = Buffer.from(to, 'utf8');

  let at = 0;
  let n = 0;
  for (;;) {
    const idx = out.indexOf(needle, at);
    if (idx < 0) break;

    // Only patch when the needle is genuinely part of a text run.
    //
    // Judged by what *follows* it. These strings are Rust source paths baked into
    // the binary for panic messages — `…\.cargo\registry\src\index.crates.io-…` —
    // and the bytes immediately before one are usually machine code from a jump
    // table, so requiring a printable prefix skips real occurrences. The bytes
    // after are a long run of plain ASCII, which identifies a string decisively.
    const ahead = out.subarray(idx + needle.length, Math.min(out.length, idx + needle.length + 32));
    const printable = ahead.filter((b) => b >= 32 && b < 127).length;

    if (ahead.length > 0 && printable / ahead.length >= 0.9) {
      repl.copy(out, idx);
      n++;
    }
    at = idx + 1;
  }

  if (n) console.log(`  ${path.basename(file)}: ${from} -> ${to}  (${n} occurrence(s))`);
  total += n;
}

if (out.length !== sizeBefore) {
  throw new Error(`size changed ${sizeBefore} -> ${out.length}; refusing to write`);
}

if (!total) {
  console.log(`  ${path.basename(file)}: nothing to replace`);
  process.exit(0);
}

if (dryRun) {
  console.log('  dry run: not written');
  process.exit(0);
}

fs.writeFileSync(file, out);
console.log(`  ${path.basename(file)}: written, size unchanged (${sizeBefore} bytes)`);
