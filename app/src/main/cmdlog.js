'use strict';

/**
 * Every command the agents run, recorded with proof of *where* it ran.
 *
 * The user's requirement is specific: they want to see each command that
 * opencode, Claude Code and Codex execute, and to be sure it ran inside the
 * sandbox kernel rather than on Windows. That is not something to assert — it has
 * to be carried by each record.
 *
 * So every entry keeps the guest's own identity: the kernel release, the PID and
 * network namespace ids (which cannot match the host's), the root filesystem, and
 * the fact that C:\ is absent. A command that had somehow run on the host would
 * report a different kernel and a visible Windows drive, which makes the log
 * self-auditing rather than a claim.
 *
 * Execution goes exclusively through `sbx exec`, so there is no path by which a
 * recorded command could have bypassed the sandbox.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Marker echoed by the wrapper so the proof block can be split off the output. */
const PROOF_BEGIN = '__AGENTDECK_PROOF_BEGIN__';

/**
 * Wraps a command so the sandbox echoes its own identity after running it.
 *
 * The proof goes to stderr with a unique marker: a command may write anything to
 * stdout, including this marker by accident, so keeping it on the other stream
 * and after the command's own output makes it unambiguous to strip.
 */
function wrapWithProof(command) {
  return [
    command,
    // Shell builtins only: the proof must not depend on tools the image may lack.
    `printf '\\n%s\\n' '${PROOF_BEGIN}' >&2`,
    `printf 'kernel=%s\\n' "$(uname -r)" >&2`,
    `printf 'pidns=%s\\n' "$(readlink /proc/self/ns/pid)" >&2`,
    `printf 'netns=%s\\n' "$(readlink /proc/self/ns/net)" >&2`,
    `printf 'rootfs=%s\\n' "$(findmnt -no FSTYPE -T / 2>/dev/null)" >&2`,
    `printf 'windows=%s\\n' "$(test -f /c/Windows/System32/cmd.exe && echo present || echo absent)" >&2`,
    `printf 'uid=%s\\n' "$(id -u)" >&2`,
  ].join('\n');
}

/** Split a wrapped run's stderr into the command's own text and the proof. */
function splitProof(stderr) {
  const at = String(stderr || '').lastIndexOf(PROOF_BEGIN);
  if (at < 0) return { output: String(stderr || ''), proof: null };

  const output = stderr.slice(0, at).replace(/\n$/, '');
  const proof = {};
  for (const line of stderr.slice(at + PROOF_BEGIN.length).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) proof[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { output, proof };
}

/**
 * @param {object} deps
 * @param {string} deps.bin      absolute path to the bundled sbx.exe
 * @param {string} deps.logFile  where the durable record is appended
 * @param {(…parts: any[]) => void} [deps.log]
 */
module.exports = function createCommandLog(deps) {
  const log = deps.log || (() => {});
  const logFile = deps.logFile;
  const bin = deps.bin;

  /** Recent entries, newest last. Bounded because this feeds a live panel. */
  const MAX = 500;
  let seq = 0;

  const listeners = new Set();

  /** id → the latest state of that command, so one command is one row. */
  const byId = new Map();

  function emit(entry) {
    // Keyed by id: a command is emitted twice (started, then finished), and the
    // panel must show it once with its final state rather than as two rows.
    byId.set(entry.id, entry);
    trim();
    for (const fn of listeners) {
      try { fn(entry); } catch { /* a broken listener must not stop the log */ }
    }
  }

  /** Drop the oldest entries once the map grows past the cap. */
  function trim() {
    if (byId.size <= MAX) return;
    const excess = byId.size - MAX;
    const ids = [...byId.keys()].sort((a, b) => a - b).slice(0, excess);
    for (const id of ids) byId.set(id, undefined);
    // Rebuild without the holes left by keying to undefined.
    const kept = [...byId.entries()].filter(([, v]) => v);
    byId.clear();
    for (const [k, v] of kept) byId.set(k, v);
  }

  function audit(entry) {
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // One JSON object per line: readable by a person, parseable by a tool.
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* an unwritable audit file must not break execution */ }
  }

  function onEntry(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function recent(limit = 100) {
    const all = [...byId.values()].filter(Boolean).sort((a, b) => a.id - b.id);
    return all.slice(-limit);
  }

  /**
   * Run one command in the sandbox and record it.
   *
   * Resolves when the command finishes; the record is emitted *before* it runs so
   * a slow or hung command still shows up as started rather than being invisible
   * until it completes.
   */
  function run(sandbox, command, opts = {}) {
    const id = ++seq;
    const startedAt = new Date();
    const origin = opts.origin || 'AgentDeck';

    const record = {
      id,
      command,
      origin,
      sandbox,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationMs: null,
      code: null,
      stdout: '',
      stderr: '',
      proof: null,
      state: 'running',
    };
    emit({ ...record });
    log('cmd: start', `#${id}`, origin, command.slice(0, 120));

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, ['exec', sandbox, 'bash', '-lc', wrapWithProof(command)], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        const failed = {
          ...record,
          state: 'spawn-failed',
          endedAt: new Date().toISOString(),
          code: -1,
          stderr: String(e && e.message || e),
        };
        emit(failed);
        audit(failed);
        resolve(failed);
        return;
      }

      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });

      const timer = opts.timeoutMs
        ? setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, opts.timeoutMs)
        : null;

      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        const failed = {
          ...record,
          state: 'error',
          endedAt: new Date().toISOString(),
          code: -1,
          stderr: err || String(e && e.message || e),
        };
        emit(failed);
        audit(failed);
        resolve(failed);
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const { output, proof } = splitProof(err);
        const endedAt = new Date();
        const done = {
          ...record,
          state: code === 0 ? 'ok' : 'failed',
          code,
          endedAt: endedAt.toISOString(),
          durationMs: endedAt - startedAt,
          stdout: out,
          stderr: output,
          proof,
        };
        emit(done);
        audit(done);
        log('cmd: done', `#${id}`, `code=${code}`, `${done.durationMs}ms`);
        resolve(done);
      });
    });
  }

  /**
   * Was this record executed inside a sandbox?
   *
   * Decided from the record's own evidence: a Linux kernel string is not something
   * Windows would report, a PID namespace only exists on Linux, and the Windows
   * drive being absent is what proves the host filesystem is not reachable.
   */
  function verdict(entry) {
    const p = entry && entry.proof;
    if (!p) return { sandboxed: null, reason: '没有取到执行凭证' };
    const checks = [
      [Boolean(p.kernel), `内核 ${p.kernel || '?'}`],
      [/^pid:\[/.test(p.pidns || ''), `PID 命名空间 ${p.pidns || '?'}`],
      [/^net:\[/.test(p.netns || ''), `网络命名空间 ${p.netns || '?'}`],
      [p.windows === 'absent', 'Windows 盘不可见'],
      [p.uid !== undefined && String(p.uid) !== '0', `非 root（uid ${p.uid}）`],
    ];
    const failedChecks = checks.filter(([ok]) => !ok);
    return {
      sandboxed: failedChecks.length === 0,
      reason: failedChecks.length === 0
        ? '全部凭证通过'
        : `凭证不符：${failedChecks.map(([, label]) => label).join('；')}`,
      checks: checks.map(([ok, label]) => ({ ok, label })),
    };
  }

  return { run, onEntry, recent, verdict, PROOF_BEGIN };
};
