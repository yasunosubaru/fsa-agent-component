'use strict';

/**
 * Docker Sandboxes (sbx) integration.
 *
 * The runtime is bundled: the binary, the microVM kernel, and two root filesystems,
 * 13 files in total. Measured, a copy runs from anywhere — it needs no installed
 * service, no driver, and does not use WSL; it starts its own hypervisor-isolated
 * microVM through Windows' built-in Hypervisor Platform.
 *
 * Two things it does *not* let us control, and both are hard limits rather than
 * configuration gaps:
 *
 *   1. **It requires a Docker account.** `sbx create` refuses with "not signed in
 *      to Docker" and there is no offline or trial mode. This is a server-side
 *      check on Docker's side, so it cannot be packaged around.
 *   2. **Its state directory is fixed** at `%LOCALAPPDATA%\DockerSandboxes` and its
 *      daemon listens on a fixed named pipe. Neither `SBX_STATE` nor any
 *      `DOCKER_SANDBOXES*` variable moves it (all measured).
 *
 * So this module does the honest thing: it detects the situation, starts the daemon
 * from the bundled copy, and reports exactly what is missing. It never pretends a
 * sandbox is available when the account step has not been done.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIPE = '\\\\.\\pipe\\docker_kaname_sandboxd';
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DockerSandboxes');

/**
 * @param {object} deps
 * @param {string} deps.appRoot  absolute app tree path
 * @param {(…parts: any[]) => void} [deps.log]
 */
module.exports = function createSandbox(deps) {
  const log = deps.log || (() => {});
  const bin = path.join(deps.appRoot, 'vendor', 'sbx', 'bin', 'sbx.exe');

  let daemonStarting = null;

  function available() {
    return fs.existsSync(bin);
  }

  /** Run sbx and capture its output. Short timeout: these are status calls. */
  function run(args, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
  }

  /** Whether the daemon's named pipe accepts a connection. */
  function pipeAlive() {
    // A named pipe is not a TCP socket, so an existence check is the practical
    // test from Node: fs.statSync on the pipe path succeeds only when it exists.
    try {
      fs.statSync(PIPE);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the daemon if it is not already running.
   *
   * The daemon is a separate process the CLI starts on demand; doing it explicitly
   * means the first status call does not pay that cost, and a failure is reported
   * with its real reason.
   */
  async function ensureDaemon() {
    if (!available()) return { ok: false, error: 'sbx runtime missing from the bundle' };
    if (pipeAlive()) return { ok: true, already: true };
    if (daemonStarting) return daemonStarting;

    daemonStarting = (async () => {
      const r = await run(['daemon', 'start'], 60000);
      const text = `${r.out}${r.err}`;
      // "already running" is success, not an error.
      if (r.code === 0 || /already running/i.test(text)) {
        log('sbx: daemon started');
        return { ok: true };
      }
      return { ok: false, error: text.trim().slice(0, 300) };
    })();

    try {
      return await daemonStarting;
    } finally {
      daemonStarting = null;
    }
  }

  /**
   * Full readiness report.
   *
   * `signedIn` and `virtualization` are the two facts a caller needs before offering
   * a sandbox, so they are reported separately instead of collapsed into a boolean.
   */
  async function status() {
    if (!available()) {
      return {
        installed: false,
        error: 'sbx runtime missing from the bundle',
      };
    }

    const virtual = hypervisorPresent();
    const daemon = await ensureDaemon();

    let signedIn = false;
    let sandboxes = [];
    let detail = '';

    if (daemon.ok) {
      const ls = await run(['ls'], 25000);
      const text = `${ls.out}${ls.err}`;
      if (ls.code === 0) {
        signedIn = true;
        // Parse into rows rather than keeping raw lines: the panel needs names and
        // states, and a caller cannot ask "is my sandbox there" of a text blob.
        sandboxes = ls.out.split(/\r?\n/)
          .filter((l) => l.trim())
          .slice(1)
          .map((line) => {
            const cols = line.trim().split(/\s{2,}/);
            return { name: cols[0] || '', agent: cols[1] || '', status: cols[2] || '' };
          })
          .filter((s) => s.name);
      } else if (/not signed in/i.test(text)) {
        signedIn = false;
        detail = 'not signed in to Docker';
      } else {
        detail = text.trim().slice(0, 200);
      }
    }

    return {
      installed: true,
      bundled: true,
      virtualization: virtual,
      daemon: daemon.ok,
      daemonError: daemon.ok ? '' : daemon.error,
      signedIn,
      sandboxes,
      detail,
      stateDir: STATE_DIR,
      // The two conditions a user must satisfy; spelled out so the panel can show
      // them rather than a single opaque "unavailable".
      blockers: [
        ...(virtual ? [] : ['this PC has not enabled Windows Hypervisor Platform']),
        ...(signedIn ? [] : ['a Docker account sign-in is required (sbx login)']),
        ...(daemon.ok ? [] : [`the sandbox daemon could not start: ${daemon.error}`]),
      ],
    };
  }

  /** Whether Windows reports a hypervisor to sbx's API. */
  function hypervisorPresent() {
    try {
      const r = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_ComputerSystem).HypervisorPresent',
      ], { encoding: 'utf8', timeout: 12000, windowsHide: true });
      return /true/i.test(`${r.stdout || ''}`);
    } catch {
      return false;
    }
  }

  // ── running things in a sandbox ────────────────────────────────────────
  //
  // Measured on the real binary: `sbx create` prints its plan and then waits on a
  // terminal prompt, so a plain non-interactive spawn looks like a hang and
  // creates nothing. `--no-input` is what makes it actually create — verified by
  // the "Created sandbox" line and by the sandbox then appearing in `sbx ls`.
  //
  // Every call below goes through the bundled binary, so nothing depends on a
  // host install of Docker or sbx.

  /** Sandbox names, parsed from `sbx ls`. */
  async function listSandboxes() {
    const r = await run(['ls'], 25000);
    if (r.code !== 0) {
      return { ok: false, error: `${r.out}${r.err}`.trim().slice(0, 300), sandboxes: [] };
    }
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
    // The first line is the header.
    const rows = lines.slice(1).map((line) => {
      const cols = line.trim().split(/\s{2,}/);
      return { name: cols[0] || '', agent: cols[1] || '', status: cols[2] || '' };
    }).filter((s) => s.name);
    return { ok: true, sandboxes: rows };
  }

  /** The name a sandbox gets when the caller does not choose one. */
  function defaultName(label) {
    const slug = String(label || 'agent')
      .toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 24);
    return `agentdeck-${slug || 'agent'}`.replace(/-+$/, '');
  }

  /**
   * The host directory a sandbox has mounted, asked of the guest itself.
   *
   * `sbx ls` prints the workspace but its columns are space-padded, so a path
   * containing spaces breaks naive parsing. The guest's own mount table has no such
   * ambiguity: the virtiofs mount is the workspace, and its target is the host path.
   *
   * Measured: the app read the recorder's log from its saved working directory while
   * the log actually sat in the sandbox's workspace, which made the board look empty
   * even though 27 records were on disk.
   */
  async function workspaceOf(name) {
    if (!name) return '';
    const r = await execInSandbox(
      name,
      `grep ' virtiofs ' /proc/mounts | awk '{print $2}' | grep '^/c/' | head -1`,
      { timeoutMs: 20000 },
    );
    const line = String(r.stdout || '').trim().split('\n')[0];
    const m = /^\/c(\/.*)$/.exec(line);
    if (!m) return '';
    return `C:${m[1].replace(/\//g, '\\')}`;
  }

  /**
   * Create a sandbox with a host directory mounted as its workspace.
   *
   * Success is decided by the sandbox really being in the list, not by the exit
   * code. `sbx create` writes a kit-resolution note to stderr and can exit
   * non-zero while the sandbox is perfectly usable, and a sandbox that already
   * exists is reported as an error too — while what the caller needs to know is
   * "can I run in it".
   */
  async function createSandbox(opts = {}) {
    if (!available()) return { ok: false, error: 'bundled sbx runtime is missing' };
    const name = opts.name || defaultName(opts.label);
    const workspace = opts.workspace;
    if (!workspace) return { ok: false, error: 'a workspace directory is required' };
    if (!fs.existsSync(workspace)) {
      return { ok: false, error: `workspace does not exist: ${workspace}` };
    }

    const args = ['create', '--name', name, '--no-input', '--pull', 'never'];
    if (opts.template) args.push('-t', opts.template);
    if (opts.cpus) args.push('--cpus', String(opts.cpus));
    if (opts.memory) args.push('--memory', String(opts.memory));
    args.push(opts.agent || 'shell', workspace);

    log('sbx: create', name, `workspace=${workspace}`);
    const r = await run(args, 300000);
    const text = `${r.out}${r.err}`;

    const after = await listSandboxes();
    const exists = after.sandboxes.some((s) => s.name === name);
    if (exists) {
      log('sbx: sandbox ready', name, `created=${r.code === 0}`);
      return { ok: true, name, created: r.code === 0, workspace, output: text.slice(-400) };
    }
    return { ok: false, name, error: text.trim().slice(-500) };
  }

  /**
   * Run a command inside a sandbox.
   *
   * A stopped sandbox is started by sbx itself, which is why nothing here calls
   * a start command. The real exit status is returned, so a failing agent
   * command stays distinguishable from a broken sandbox.
   */
  async function execInSandbox(name, command, opts = {}) {
    if (!available()) return { ok: false, error: 'bundled sbx runtime is missing' };
    if (!name) return { ok: false, error: 'a sandbox name is required' };
    const argv = ['exec'];
    if (opts.user) argv.push('-u', opts.user);
    if (opts.interactive) argv.push('-i');
    argv.push(name, 'bash', '-lc', command);

    const r = await run(argv, opts.timeoutMs || 180000);
    return {
      ok: r.code === 0,
      code: r.code,
      stdout: r.out,
      stderr: r.err,
      error: r.code === 0 ? '' : `${r.err || r.out}`.trim().slice(0, 500),
    };
  }

  async function removeSandbox(name) {
    if (!available()) return { ok: false, error: 'bundled sbx runtime is missing' };
    const r = await run(['rm', '--force', name], 120000);
    return { ok: r.code === 0, error: r.code === 0 ? '' : `${r.out}${r.err}`.trim().slice(0, 300) };
  }

  // ── deep status ────────────────────────────────────────────────────────
  /**
   * Everything worth knowing about one sandbox, asked of the sandbox itself.
   *
   * Every value comes from the kernel or from /proc inside the microVM, so the page
   * describes what is actually running rather than what the configuration asked
   * for. Values are printed as KEY=value by the probe and parsed here; a field the
   * probe could not read comes back as an empty string rather than a guess.
   */
  const PROBE = [
    'echo "KERNEL=$(uname -r)"',
    'echo "KERNEL_BUILD=$(uname -v)"',
    'echo "ARCH=$(uname -m)"',
    'echo "OS=$(. /etc/os-release; echo $PRETTY_NAME)"',
    'echo "CPUS=$(nproc)"',
    'echo "CPU_MODEL=$(awk -F: \'/model name/{gsub(/^ +/,"",$2); print $2; exit}\' /proc/cpuinfo)"',
    'echo "LOADAVG=$(cut -d" " -f1-3 /proc/loadavg)"',
    'echo "MEM_TOTAL_MB=$(awk \'/MemTotal/{printf "%d", $2/1024}\' /proc/meminfo)"',
    'echo "MEM_AVAIL_MB=$(awk \'/MemAvailable/{printf "%d", $2/1024}\' /proc/meminfo)"',
    'echo "DISK_ROOT=$(df -h / | awk \'NR==2{print $2"|"$4"|"$5}\')"',
    'echo "DISK_DOCKER=$(df -h /var/lib/docker 2>/dev/null | awk \'NR==2{print $2"|"$4}\')"',
    'echo "HOST_MNT_COUNT=$(ls /mnt 2>/dev/null | wc -l)"',
    'echo "WINDOWS_DRIVE=$(test -f /c/Windows/System32/cmd.exe && echo present || echo absent)"',
    'echo "MOUNT_COUNT=$(findmnt -rn | wc -l)"',
    'echo "SECCOMP=$(grep -c Seccomp /proc/self/status)"',
    'echo "CAPS_EFFECTIVE=$(awk \'/CapEff/{print $2}\' /proc/self/status)"',
    'echo "USER_ID=$(id -u)"',
    'echo "USER_NAME=$(id -un)"',
    'echo "PYTHON=$(python3 -V 2>&1 | sed \'s/Python //\')"',
    'echo "NODE=$(node -v 2>&1)"',
    'echo "GCC=$(gcc -dumpversion 2>&1)"',
    'echo "GO=$(go version 2>/dev/null | awk \'{print $3}\')"',
    'echo "RUST=$(rustc --version 2>/dev/null | awk \'{print $2}\')"',
    'echo "NET_IFACES=$(ls /sys/class/net 2>/dev/null | tr \'\\n\' \',\')"',
  ].join('; ');

  /** Parse KEY=value lines into an object, keeping empty values as ''. */
  function parseProbe(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
      out[key] = line.slice(at + 1).trim();
    }
    return out;
  }

  /**
   * A sandbox's real runtime status: kernel, resources, isolation, toolchain.
   *
   * The `sbx` CLI on its own only says "running" or "stopped". This asks the guest
   * kernel directly, which is the only way to report the kernel version, the CPU
   * and memory actually granted, and whether the host filesystem is reachable.
   */
  async function inspect(name) {
    if (!available()) return { ok: false, error: 'bundled sbx runtime is missing' };
    if (!name) return { ok: false, error: 'a sandbox name is required' };

    const started = Date.now();
    const exec = await execInSandbox(name, PROBE, { timeoutMs: 120000 });
    if (!exec.ok) {
      return { ok: false, error: exec.error || 'sandbox did not respond', name };
    }
    const raw = parseProbe(exec.stdout);
    const ms = Date.now() - started;

    const num = (v) => {
      const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    const diskRoot = String(raw.DISK_ROOT || '').split('|');

    return {
      ok: true,
      name,
      probeMs: ms,
      kernel: {
        release: raw.KERNEL || '',
        build: raw.KERNEL_BUILD || '',
        arch: raw.ARCH || '',
        os: raw.OS || '',
      },
      cpu: {
        cores: num(raw.CPUS),
        model: raw.CPU_MODEL || '',
        loadavg: raw.LOADAVG || '',
      },
      memory: {
        totalMb: num(raw.MEM_TOTAL_MB),
        availableMb: num(raw.MEM_AVAIL_MB),
      },
      disk: {
        rootTotal: diskRoot[0] || '',
        rootFree: diskRoot[1] || '',
        rootUsedPct: diskRoot[2] || '',
        dockerTotal: String(raw.DISK_DOCKER || '').split('|')[0] || '',
        dockerFree: String(raw.DISK_DOCKER || '').split('|')[1] || '',
      },
      // The isolation claims, stated as measured facts rather than assurances.
      isolation: {
        hostMounts: num(raw.HOST_MNT_COUNT),
        windowsDrive: raw.WINDOWS_DRIVE || 'unknown',
        mountCount: num(raw.MOUNT_COUNT),
        seccomp: num(raw.SECCOMP),
        // An empty CapEff string means the process holds no capabilities at all.
        capabilities: /^0*$/.test(String(raw.CAPS_EFFECTIVE || '').replace(/\s/g, ''))
          ? 'none'
          : String(raw.CAPS_EFFECTIVE || '').trim() || 'unknown',
        user: raw.USER_NAME || '',
        uid: num(raw.USER_ID),
        isRoot: num(raw.USER_ID) === 0,
      },
      toolchain: {
        python: raw.PYTHON || '',
        node: raw.NODE || '',
        gcc: raw.GCC || '',
        go: raw.GO || '',
        rust: raw.RUST || '',
      },
      network: {
        interfaces: String(raw.NET_IFACES || '').split(',').filter(Boolean),
      },
      raw,
    };
  }

  /**
   * Host-side health: the daemon, the hypervisor, and what `sbx diagnose` says.
   *
   * Sections are returned as text rather than a parsed structure: the diagnose
   * output is meant for a human, and rewriting it into tables would drop the
   * detail that makes it useful when something is wrong.
   */
  async function hostHealth() {
    if (!available()) return { ok: false, error: 'bundled sbx runtime is missing' };
    const diag = await run(['diagnose'], 90000);
    const text = `${diag.out}${diag.err}`;
    const sections = [];
    let current = { title: '', lines: [] };
    for (const line of text.split(/\r?\n/)) {
      if (/^[A-Z]{4,}\s*$/.test(line.trim())) {
        if (current.title) sections.push(current);
        current = { title: line.trim(), lines: [] };
      } else if (line.trim() && current.title) {
        current.lines.push(line.replace(/\s+$/, ''));
      }
    }
    if (current.title) sections.push(current);

    return {
      ok: diag.code === 0,
      // `sbx diagnose` exits non-zero when any check fails, which is a report worth
      // showing rather than an error to swallow.
      code: diag.code,
      sections,
      text: text.slice(0, 6000),
    };
  }

  /**
   * A snapshot of the processes running inside one sandbox.
   *
   * Parsed from /proc rather than by running `ps`: `ps` is not in every image, and
   * even where it is, its column format varies. /proc is the kernel's own view and
   * is present in all of them.
   *
   * The command line is truncated and whitespace-collapsed on purpose — a long
   * argument list would wreck the table, and the full text is available by
   * expanding the row.
   */
  async function processes(name) {
    if (!available()) return { ok: false, error: 'bundled sbx runtime is missing' };
    if (!name) return { ok: false, error: 'a sandbox name is required' };

    const script = [
      'for d in /proc/[0-9]*; do',
      '  pid=${d#/proc/}',
      '  [ -r "$d/stat" ] || continue',
      // cmdline is NUL-separated; tr turns it into spaces for display.
      // shell -c invocations repeat the whole string in the child process, so an
      // exact repeat is collapsed rather than shown twice.
      '  cmd=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null)',
      '  half=$(printf "%s" "$cmd" | awk \'{n=length($0); if (n%2==0 && substr($0,1,n/2)==substr($0,n/2+1)) print substr($0,1,n/2)}\')',
      '  [ -n "$half" ] && cmd="$half"',
      '  [ -z "$cmd" ] && cmd="[$(cat "$d/comm" 2>/dev/null)]"',
      // stat field 4 is the parent pid, 22 is starttime in clock ticks.
      '  stat=$(cat "$d/stat" 2>/dev/null)',
      '  ppid=$(echo "$stat" | awk \'{print $4}\')',
      '  state=$(echo "$stat" | awk \'{print $3}\')',
      '  rss=0',
      '  [ -r "$d/status" ] && rss=$(awk \'/VmRSS/{print $2}\' "$d/status" 2>/dev/null)',
      '  echo "PROC|$pid|$ppid|$state|${rss:-0}|$cmd"',
      'done',
    ].join('\n');

    const r = await execInSandbox(name, script, { timeoutMs: 30000 });
    if (!r.ok && !r.stdout) {
      return { ok: false, error: r.error || 'could not read the process table', name };
    }

    const rows = [];
    for (const line of String(r.stdout).split(/\r?\n/)) {
      if (!line.startsWith('PROC|')) continue;
      const [, pid, ppid, state, rssKb, ...rest] = line.split('|');
      const command = rest.join('|').replace(/\s+/g, ' ').trim();
      rows.push({
        pid: Number(pid),
        ppid: Number(ppid),
        state,
        rssMb: Math.round(Number(rssKb || 0) / 1024),
        command,
        // The short name is what a person scans for; the full line is the detail.
        name: (command.match(/^\[?([^\]\s/]+)/) || [, command])[1] || '',
      });
    }
    rows.sort((a, b) => a.pid - b.pid);

    return { ok: true, name, processes: rows, at: new Date().toISOString() };
  }

  return {
    available, status, ensureDaemon, run, hypervisorPresent,
    listSandboxes, createSandbox, execInSandbox, removeSandbox,
    inspect, hostHealth, processes, workspaceOf,
  };
};