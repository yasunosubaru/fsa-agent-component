'use strict';

/**
 * Remove the third-party analytics key from opcode's built bundle.
 *
 * opcode's compiled frontend hardcodes its author's PostHog project key:
 *   apiKey:"phc_…", apiHost:"https://us.i.posthog.com"
 * With that key present, anything the app records is sent to opcode's own
 * analytics project — not ours, and without the user's knowledge. The key is not
 * a secret (it ships in their public releases), but shipping it means our users'
 * usage data flows somewhere we do not control, so it is replaced with an empty
 * string.
 *
 * PostHog treats an empty apiKey as "not configured": no request is made, and the
 * surrounding code path exits early. The literal is replaced in place, leaving the
 * bundle otherwise identical.
 *
 * Usage: node strip-telemetry-key.js <dir-with-opcode-dist>
 */

const fs = require('node:fs');
const path = require('node:path');

const KEY_RE = /phc_[A-Za-z0-9]{20,}/g;

const root = process.argv[2];
if (!root) {
  console.error('usage: node strip-telemetry-key.js <vendor/opcode>');
  process.exit(2);
}

let touched = 0;
let keys = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(js|mjs|cjs|html)$/i.test(e.name)) continue;

    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }

    KEY_RE.lastIndex = 0;
    const found = text.match(KEY_RE);
    if (!found) continue;

    // Replace the key value only; the surrounding code is left untouched.
    const next = text.replace(KEY_RE, '');
    if (next === text) continue;

    // A backup beside the file: this edits a vendor binary bundle, so the
    // original must remain recoverable.
    const bak = `${p}.bak`;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, text, 'utf8');

    fs.writeFileSync(p, next, 'utf8');
    touched++;
    keys += found.length;
    console.log(`  ${path.relative(root, p)}: ${found.length} key(s) -> empty`);
  }
}

walk(root);
console.log(touched
  ? `stripped ${keys} analytics key(s) from ${touched} file(s)`
  : 'no analytics key found (already clean)');
