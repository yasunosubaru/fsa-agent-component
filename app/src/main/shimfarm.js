'use strict';

/**
 * See every command, by putting a recording shim in front of every binary.
 *
 * Wrapping only `sh` and `bash` was measured to catch just the shell invocation —
 * the individual binaries a script calls are exec'd directly and never pass through
 * a wrapper with that name. To catch them all, one script is installed and every
 * executable in the image gets a symlink to it. The script reads its own `$0` to
 * know which command it is standing in for, records the call, then execs the real
 * binary.
 *
 * Cost per command: one extra fork+exec of a small POSIX shell, which is on the
 * order of a couple of milliseconds. That is the price of seeing everything; it is
 * far below strace's per-syscall trap and it needs no kernel facilities.
 *
 * The shims are written as symlinks, not copies: a thousand copies of a script
 * would cost disk and inodes, and the script would then have no way to tell which
 * binary it replaces.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Where the shim script and its symlink farm live in the sandbox. */
const DIR = '/opt/agentdeck/shim';
const BIN = `${DIR}/bin`;
const SCRIPT = `${DIR}/record`;
const LOG_REL = '.agentdeck/exec.jsonl';

/**
 * Absolute paths for the few tools the recorder itself needs.
 *
 * These must not resolve through the farm: the recorder would then record its own
 * bookkeeping calls, and a first version produced 64 bogus entries that way.
 */
const HELPER = {
  DATE: '/bin/date',
  TR: '/usr/bin/tr',
  PWD: '/bin/pwd',
  CAT: '/bin/cat',
};

function toSandboxPath(winPath) {
  const s = String(winPath || '').replace(/\\/g, '/');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(s);
  if (!m) return s;
  return `/${m[1].toLowerCase()}${m[2] || ''}`;
}

/**
 * The recorder script.
 *
 * It resolves its own name via `$0`, which is the whole trick: every symlink points
 * here, so one script serves every binary. Real path lookup then skips this
 * directory so the exec cannot loop back into the shim.
 *
 * Two traps, both measured:
 *   • The recorder calls `date` and `tr`. If those resolve through the farm it
 *     records its own bookkeeping — a first version produced 64 entries of `tr -d \n`
 *     for a script that ran four commands. Every helper here is therefore an
 *     absolute path.
 *   • The farm must not shim the shell itself: `sh` calling `sh` recurses forever.
 *
 * Everything is guarded — a recorder that fails must never stop the command it
 * fronts, so the final `exec` always happens.
 */
function shimScript(logPath, realDir) {
  return `#!/bin/sh
# AgentDeck command recorder. Installed as a symlink farm over the real binaries.
AD_LOG='${logPath}'
AD_REAL='${realDir}'
name=\${0##*/}
{
  real="$AD_REAL/$name"
  [ -x "$real" ] || real=
  ts=$(${HELPER.DATE} +%s 2>/dev/null)
  cwd=$(${HELPER.PWD} 2>/dev/null)
  pppid=\${PPID:-0}
  pcomm=$(${HELPER.CAT} /proc/$pppid/comm 2>/dev/null | ${HELPER.TR} -d '\\n')
  args=''
  for a in "$@"; do
    args="$args	$(printf '%s' "$a" | ${HELPER.TR} '	\\n\\r' '   ')"
  done
  # The command's own name is not in $@ — it IS $0 — so it is written first.
  # Without it every record looks like its first argument: "-r" instead of "uname -r".
  printf '%s\t%s\t%s\t%s\t%s\t%s%s\\n' "$ts" "$$" "$pppid" "$pcomm" "$cwd" "$name" "$args" >> "$AD_LOG" 2>/dev/null
} 2>/dev/null
[ -n "$real" ] || real="$name"
exec "$real" "$@"
`;
}

module.exports = function createShimFarm(deps = {}) {
  const log = deps.log || (() => {});

  const logFileFor = (workspace) => path.join(workspace, LOG_REL);

  /**
   * Install the shim farm into a sandbox.
   *
   * The real binaries are symlinked into one directory, the shim script sits
   * alongside them under its own name, and then each real name is replaced by a
   * symlink to the script. Keeping the real ones together is what lets the script
   * find the binary it is standing in for without a PATH lookup that would come
   * straight back to itself.
   */
  async function install(sandboxApi, name, workspace) {
    const logPath = `${toSandboxPath(workspace)}/${LOG_REL}`;
    try {
      fs.mkdirSync(path.dirname(logFileFor(workspace)), { recursive: true });
    } catch (e) {
      return { ok: false, error: `could not create the log directory: ${e.message}` };
    }

    const b64 = Buffer.from(shimScript(logPath, `${DIR}/real`), 'utf8').toString('base64');

    // The command list is generated in the sandbox from the real PATH, so the farm
    // matches the image rather than a hard-coded guess.
    const script = [
      `set -e`,
      `mkdir -p ${DIR}/real ${BIN}`,
      `printf '%s' '${b64}' | base64 -d > ${SCRIPT}`,
      `chmod 0755 ${SCRIPT}`,
      // Symlink every real binary into real/, skipping anything already ours.
      `for d in /usr/local/bin /usr/bin /bin /usr/local/sbin /usr/sbin /sbin; do`,
      `  [ -d "$d" ] || continue`,
      `  for f in "$d"/*; do`,
      `    [ -f "$f" ] || continue`,
      `    [ -x "$f" ] || continue`,
      `    n=\${f##*/}`,
      `    [ -e "${DIR}/real/$n" ] && continue`,
      // A shim for the shell itself would recurse: skip sh/bash, they are handled
      // by being the thing that calls everything else.
      `    case "$n" in sh|bash|dash) continue;; esac`,
      `    ln -sf "$f" "${DIR}/real/$n" 2>/dev/null || true`,
      `  done`,
      `done`,
      // One symlink per name, all pointing at the recorder.
      `for f in ${DIR}/real/*; do`,
      `  n=\${f##*/}`,
      `  ln -sf ${SCRIPT} "${BIN}/$n" 2>/dev/null || true`,
      `done`,
      `printf 'installed' > ${DIR}/.installed`,
      `ls ${BIN} | wc -l`,
    ].join('\n');

    const r = await sandboxApi.execInSandbox(name, script, { user: 'root', timeoutMs: 180000 });
    if (!r.ok) return { ok: false, error: r.error || 'install failed' };
    const count = Number(String(r.stdout).trim().split('\n').pop()) || 0;
    log('shimfarm: installed', name, `${count} commands`);
    return { ok: true, name, dir: BIN, count, logPath };
  }

  async function isInstalled(sandboxApi, name) {
    const r = await sandboxApi.execInSandbox(
      name, `test -x ${SCRIPT} && test -d ${BIN} && ls ${BIN} | head -1`, { timeoutMs: 20000 },
    );
    return r.ok && Boolean(String(r.stdout).trim());
  }

  /** PATH prefix that puts the shim farm ahead of the real binaries. */
  const pathPrefix = () => `PATH=${BIN}:$PATH`;

  /** Read and parse the recorded lines from the host side. */
  function read(workspace, limit = 400) {
    const file = logFileFor(workspace);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: true, entries: [], file };
    }

    const entries = [];
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(-limit)) {
      const f = line.split('\t');
      if (f.length < 6) continue;
      const [ts, pid, ppid, pcomm, cwd, ...rest] = f;
      // Our own instrumented runs land here too; they already have a richer record.
      if (rest.join(' ').includes('__AGENTDECK_PROOF_BEGIN__')) continue;
      const argv = rest.filter((x) => x !== '');
      if (!argv.length) continue;
      entries.push({
        source: 'shim',
        at: Number(ts) ? new Date(Number(ts) * 1000) : new Date(),
        pid: Number(pid),
        ppid: Number(ppid),
        parent: pcomm || '',
        cwd: cwd || '',
        argv,
      });
    }
    return { ok: true, entries, file };
  }

  return { DIR, BIN, SCRIPT, LOG_REL, install, isInstalled, pathPrefix, read, logFileFor, toSandboxPath };
};
