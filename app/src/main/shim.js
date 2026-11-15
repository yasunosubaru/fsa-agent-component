'use strict';

/**
 * Anthropic-protocol shim.
 *
 * Claude Code only speaks the Anthropic Messages wire (`POST /v1/messages`), and
 * some providers refuse open models on their own Anthropic endpoint while serving
 * them on OpenAI's. commandcode is one: DeepSeek is rejected there with "use
 * /provider/v1/chat/completions".
 *
 * So requests are routed through a small translator: Claude Code posts Anthropic
 * JSON to 127.0.0.1, the shim rewrites it to OpenAI chat/completions for the
 * upstream, and translates the reply back. That is also why the CLI needs its
 * model pinned — it rewrites the model name to a Claude one, which the upstream
 * would not recognise.
 *
 * The translator is a single standard-library Python file, bundled with the app, so
 * this adds no dependency beyond a Python interpreter. When no interpreter is
 * available the shim is simply not started and Claude Code runs with the plain
 * Anthropic endpoint, exactly as before.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/**
 * Find a Python interpreter.
 *
 * `py` (the Windows launcher) is preferred because it resolves the installed
 * version even when `python.exe` is not on PATH; `python3` and `python` are tried
 * next. Each candidate is verified by asking for its version, so a broken shim of
 * one does not get picked.
 */
function findPython() {
  const candidates = [
    { exe: 'py', args: ['-3'] },
    { exe: 'python', args: [] },
    { exe: 'python3', args: [] },
  ];

  for (const c of candidates) {
    try {
      const r = spawnSync(c.exe, [...c.args, '--version'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      if (r.status === 0 && /Python 3\.\d+/.test(out)) {
        return { exe: c.exe, args: c.args, version: out.trim() };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Pick a free localhost port, so two instances do not collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * @param {object} deps
 * @param {string} deps.appRoot      absolute app tree path
 * @param {string} deps.userData     per-user state directory
 * @param {(…parts: any[]) => void} [deps.log]
 */
module.exports = function createShim(deps) {
  const log = deps.log || (() => {});
  const script = path.join(deps.appRoot, 'vendor', 'shim', 'anthropic_shim.py');

  /** @type {{proc: import('node:child_process').ChildProcess, port: number, python: object} | null} */
  let running = null;
  let starting = null;

  function available() {
    return fs.existsSync(script);
  }

  /** Readiness: the shim prints a ready line once it is listening. */
  function waitForReady(child, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let out = '';
      const done = (ok, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, detail });
      };

      const onData = (chunk) => {
        out += chunk.toString();
        if (out.includes('ANTHROPIC_SHIM_READY')) done(true, out.split('\n')[0]);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', (c) => { out += c.toString(); });
      child.once('exit', (code) => done(false, `shim exited (code=${code}): ${out.slice(0, 300)}`));

      const timer = setTimeout(() => done(false, `shim did not report ready: ${out.slice(0, 300)}`), timeoutMs);
    });
  }

  /**
   * Start the shim for one provider.
   *
   * @param {object} opts
   * @param {string} opts.upstream   provider root, e.g. https://host/provider/v1
   * @param {string} opts.apiKey     upstream key (passed by environment, never argv)
   * @param {string} [opts.model]    model to pin, e.g. deepseek/deepseek-v4.1-flash
   * @param {string} [opts.proxy]    optional HTTP proxy for the upstream call
   */
  async function start(opts) {
    if (running) return { ok: true, port: running.port, reused: true };
    if (starting) return starting;

    if (!available()) {
      return { ok: false, error: 'protocol translator is missing from the bundle' };
    }
    if (!opts || !opts.upstream || !opts.apiKey) {
      return { ok: false, error: 'upstream and apiKey are required' };
    }

    const python = findPython();
    if (!python) {
      return { ok: false, error: 'no Python 3 interpreter found for the protocol translator' };
    }

    starting = (async () => {
      const port = await freePort();
      const args = [
        ...python.args,
        script,
        '--upstream', opts.upstream,
        '--port', String(port),
        '--serve',
      ];

      const env = { ...process.env };
      // The key travels in the environment, never on the command line: the argv of
      // a running process is readable by other users on the machine.
      env.OPENAI_API_KEY = opts.apiKey;
      if (opts.proxy) {
        env.HTTP_PROXY = opts.proxy;
        env.HTTPS_PROXY = opts.proxy;
      }

      let child;
      try {
        child = spawn(python.exe, args, {
          cwd: path.dirname(script),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        return { ok: false, error: `could not start the protocol translator: ${e.message}` };
      }

      const ready = await waitForReady(child, 20000);
      if (!ready.ok) {
        try { child.kill(); } catch { /* already gone */ }
        return { ok: false, error: ready.detail };
      }

      child.on('exit', (code) => {
        log('shim: exited', `code=${code}`);
        if (running && running.proc === child) running = null;
      });

      running = { proc: child, port, python, model: opts.model || null };
      log('shim: ready', `port=${port}`, `upstream=${opts.upstream}`,
        `python=${python.version}`, `model=${opts.model || '(unpinned)'}`);
      return { ok: true, port };
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function stop() {
    if (!running) return;
    try { running.proc.kill(); } catch { /* already dead */ }
    running = null;
  }

  function status() {
    if (!running) return { running: false, available: available(), python: findPython() };
    return {
      running: true,
      available: true,
      port: running.port,
      model: running.model,
      python: running.python,
    };
  }

  return { available, findPython, start, stop, status };
};
