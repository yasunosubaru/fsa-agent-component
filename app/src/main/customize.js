'use strict';

/**
 * The customisation surface: MCP servers, skills, and per-agent instruction files.
 *
 * The three official apps and OpenCode all extend through MCP, so that is the one
 * interface worth exposing. Rather than editing each app's own configuration by
 * hand — three different formats, three different locations, and one of them
 * (Claude) refuses to relocate its data — this module writes one definition and
 * projects it into whatever each app reads.
 *
 * Design rule: never guess. A field this module cannot place is reported as
 * unplaced rather than written somewhere plausible, because a silently misplaced
 * setting is worse than one the user knows to place themselves.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Where each app reads its extensions from. Paths measured on this machine. */
const TARGETS = {
  claude: {
    label: 'Claude Code',
    configPath: path.join(process.env.LOCALAPPDATA || '', 'Claude-3p', 'claude_desktop_config.json'),
    // Claude Desktop uses the mcpServers object form.
    shape: 'claude-json',
    note: '写进 Claude Desktop 的配置文件（3p 部署目录）',
  },
  codex: {
    label: 'Codex',
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    // Codex uses TOML tables: [mcp_servers.<name>].
    shape: 'codex-toml',
    note: '写进 Codex 的 config.toml（TOML 表）',
  },
  opencode: {
    label: 'OpenCode',
    // Measured: this machine's real OpenCode config is `opencode.jsonc`, not
    // `opencode.json`, and it carries hand-written comments.
    configPath: path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
    // Its shape nests servers one level deeper than Claude's.
    shape: 'opencode-json',
    note: '写进 OpenCode 的 opencode.jsonc（mcp.servers.<名字>）—— 只给出文本，由你放置',
  },
  sandbox: {
    label: '沙盒内 agents',
    // The sandbox mounts this directory read-only at the agents' skills folder, so
    // one file here is visible to every agent kit at once.
    configPath: path.join(process.env.LOCALAPPDATA || '', 'DockerSandboxes', 'sandboxes', 'state', 'agent-skills'),
    shape: 'skills-dir',
    note: '沙盒把此目录挂给每个 agent 的 skills 路径（只读）',
  },
};

/**
 * A starter definition of one MCP server.
 *
 * Deliberately a working example rather than an empty skeleton: an example that
 * actually runs is the fastest way to learn the shape, and it can be edited down.
 * The server chosen is `@modelcontextprotocol/server-filesystem`, which needs no
 * credentials and no network — a template that fails on first run teaches nothing.
 */
function templateServer(opts = {}) {
  return {
    name: opts.name || 'workspace-files',
    // stdio is the only transport that works the same way in all four targets.
    transport: 'stdio',
    command: opts.command || 'npx',
    args: opts.args || ['-y', '@modelcontextprotocol/server-filesystem', opts.directory || '${WORKSPACE}'],
    env: opts.env || {},
    description: opts.description
      || '把工作目录的文件读写暴露给 agent。把 ${WORKSPACE} 换成实际路径。',
  };
}

/** Expand the placeholders a definition may contain. */
function expand(value, ctx) {
  if (typeof value === 'string') {
    return value
      .replace(/\$\{WORKSPACE\}/g, ctx.workspace || '')
      .replace(/\$\{USER_HOME\}/g, os.homedir());
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expand(v, ctx);
    return out;
  }
  return value;
}

// ── projection: one definition → each app's native file ─────────────────

/** Claude Desktop: mcpServers.<name> = { command, args, env }. */
function projectClaude(server) {
  return {
    [server.name]: {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env || {}).length ? { env: server.env } : {}),
    },
  };
}

/** Codex: a TOML table per server. Emitted as text; no TOML writer needed. */
function projectCodexToml(server) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    `[mcp_servers.${server.name}]`,
    `command = "${esc(server.command)}"`,
    `args = [${server.args.map((a) => `"${esc(a)}"`).join(', ')}]`,
  ];
  if (Object.keys(server.env || {}).length) {
    lines.push(`[mcp_servers.${server.name}.env]`);
    for (const [k, v] of Object.entries(server.env)) lines.push(`${k} = "${esc(v)}"`);
  }
  return lines.join('\n');
}

/** OpenCode: mcp.servers.<name> = { type, command: [...], disabled }. */
function projectOpencode(server) {
  return {
    servers: {
      [server.name]: {
        type: 'local',
        command: [server.command, ...server.args],
        ...(Object.keys(server.env || {}).length ? { environment: server.env } : {}),
        // OpenCode spells "on" as `disabled: false`.
        disabled: false,
      },
    },
  };
}

/**
 * Render a definition for one target.
 *
 * Returns text plus the exact place it belongs, and says plainly when this module
 * cannot write it — an unplaced target is reported, never approximated.
 */
function render(target, server, ctx = {}) {
  const spec = TARGETS[target];
  if (!spec) return { ok: false, error: `未知目标：${target}` };
  const s = expand(server, ctx);

  if (target === 'claude') {
    return {
      ok: true,
      target,
      label: spec.label,
      file: spec.configPath,
      note: spec.note,
      // Merged under the existing mcpServers key by the caller; printed alone so a
      // person can see exactly what would be added.
      json: { mcpServers: projectClaude(s) },
    };
  }
  if (target === 'codex') {
    return {
      ok: true,
      target,
      label: spec.label,
      file: spec.configPath,
      note: spec.note,
      toml: projectCodexToml(s),
    };
  }
  if (target === 'opencode') {
    return {
      ok: true,
      target,
      label: spec.label,
      file: spec.configPath,
      note: spec.note,
      json: { mcp: projectOpencode(s) },
    };
  }
  return {
    ok: true,
    target,
    label: spec.label,
    file: spec.configPath,
    note: spec.note,
    // A skills directory is not a config file: the shape is one folder per skill
    // with a SKILL.md, which is shown as a snippet rather than a whole file.
    skill: {
      dir: path.join(spec.configPath, s.name),
      file: 'SKILL.md',
      snippet: [
        '---',
        `name: ${s.name}`,
        `description: ${s.description || ''}`,
        '---',
        '',
        '# ' + s.name,
        '',
        '在这里写这个技能要 agent 怎么做事：触发条件、步骤、约束。',
      ].join('\n'),
    },
  };
}

/** Every target rendered at once, for the template picker. */
function renderAll(server, ctx = {}) {
  return Object.keys(TARGETS).map((t) => render(t, server, ctx));
}

/** The catalogue, for the docs page and the UI. */
function catalogue() {
  return Object.entries(TARGETS).map(([id, spec]) => ({
    id,
    label: spec.label,
    file: spec.configPath,
    note: spec.note,
    shape: spec.shape,
  }));
}

/**
 * Write a definition into one target, backing up whatever was there.
 *
 * Only Claude's config is written automatically. The others are returned as text
 * for the person to place, for a measured reason in each case:
 *
 *   • Codex owns `config.toml`, and appending to a file another program rewrites
 *     risks corrupting it.
 *   • OpenCode's config is JSONC — hand-written comments included — and a
 *     JSON round-trip would silently delete them.
 *   • The skills directory is a folder structure, not a config file.
 *
 * Claude's config is plain JSON that this app is already responsible for (it
 * writes the 3p block), so it is the one safe automatic target.
 */
function applyTo(target, server, ctx = {}) {
  const spec = TARGETS[target];
  if (!spec) return { ok: false, error: `未知目标：${target}` };
  if (spec.shape !== 'claude-json') {
    return {
      ok: false,
      manual: true,
      error: '这个目标需要手动放置，避免破坏它自己的格式',
      rendered: render(target, server, ctx),
    };
  }

  const rendered = render(target, server, ctx);
  if (!rendered.ok) return rendered;

  const file = spec.configPath;
  let existing = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { ok: false, error: `${file} 不是合法 JSON，未改动：${e.message}` };
    }
    // Backup next to the original, timestamped: overwriting config that another
    // program maintains is exactly the kind of change that needs an undo.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(`${file}.bak-${stamp}`, JSON.stringify(existing, null, 2), 'utf8');
  }

  const merged = { ...existing };
  merged.mcpServers = { ...(existing.mcpServers || {}), ...rendered.json.mcpServers };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: `写入失败：${e.message}` };
  }
  return { ok: true, target, file, applied: rendered.json };
}

module.exports = {
  TARGETS,
  templateServer,
  render,
  renderAll,
  catalogue,
  applyTo,
  expand,
};
