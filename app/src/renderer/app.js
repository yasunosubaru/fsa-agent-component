'use strict';

/**
 * AgentDeck shell renderer.
 *
 * Responsibilities:
 *   • Mrite-style panel switching on the left rail (one active panel, pop-in
 *     animation, per-agent accent).
 *   • Keep the native OpenChamber view aligned with #chamberSlot, since it is a
 *     real WebContentsView painted over the page rather than an iframe.
 *   • Drive the Claude Code PTY through xterm.js, including resize and restart.
 *   • Host the four external front ends as real windows (see guests.js).
 *   • Reflect real component state on Home and in Settings.
 */

(() => {
  const deck = window.deck;

  const PANELS = [
    'home', 'openchamber', 'claude',
    'opcode', 'codex', 'emdash', 'claudian',
    'workspace', 'settings',
  ];
  const PANEL_LABELS = {
    home: 'AgentDeck',
    openchamber: 'OpenChamber',
    claude: 'Claude Code',
    opcode: 'opcode',
    codex: 'Codex',
    emdash: 'Emdash',
    claudian: 'Claudian',
    workspace: '工作目录',
    settings: '设置',
  };
  /** Panels whose content is a real foreign application window. */
  const GUEST_PANELS = ['opcode', 'codex', 'emdash', 'claudian'];

  /** @type {{claudeCwd: string, theme: string, lastView: string}} */
  let state = { claudeCwd: '', theme: 'system', lastView: 'home' };
  let env = null;
  let activePanel = 'home';

  // ── element handles ─────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const panelArea = $('panelArea');
  const navButtons = Array.from(document.querySelectorAll('.app-nav-btn'));

  // ── toast ───────────────────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;
  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'deck-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Theme
  // ══════════════════════════════════════════════════════════════════════
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /**
   * Resolve the active appearance. The stylesheet keys off `data-theme` on the
   * root element, so a system preference has to be translated into a concrete
   * light/dark rather than left as "system".
   */
  function applyTheme(theme) {
    const resolved = theme === 'system'
      ? (darkQuery.matches ? 'dark' : 'light')
      : (theme === 'dark' ? 'dark' : 'light');
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.setProperty('color-scheme', resolved);
  }

  darkQuery.addEventListener('change', () => {
    if ((state.theme || 'system') === 'system') applyTheme('system');
  });

  // ══════════════════════════════════════════════════════════════════════
  // Layout sync — the OpenChamber view is a native overlay, so its bounds must
  // follow the CSS box exactly.
  // ══════════════════════════════════════════════════════════════════════
  let boundsRaf = 0;
  function reportContentBounds() {
    if (boundsRaf) return;
    boundsRaf = requestAnimationFrame(() => {
      boundsRaf = 0;
      const slot = $('chamberSlot');
      if (!slot) return;
      const r = slot.getBoundingClientRect();
      if (!r.width || !r.height) return;
      deck.setContentBounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    });
  }

  window.addEventListener('resize', reportContentBounds);

  // ══════════════════════════════════════════════════════════════════════
  // Panel switching
  // ══════════════════════════════════════════════════════════════════════
  /**
   * Switching is synchronous in the DOM and asynchronous only afterwards. A
   * lock held across the follow-up work would silently swallow the next click,
   * because that work can wait on a server or a whole application launching.
   */
  function showPanel(name) {
    const target = PANELS.includes(name) ? name : 'home';
    activePanel = target;
    document.documentElement.dataset.panel = target;

    panelArea.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === target);
    });

    navButtons.forEach((btn) => {
      const on = btn.dataset.panel === target;
      if (on && !btn.classList.contains('active')) {
        btn.classList.add('nav-enter');
        setTimeout(() => btn.classList.remove('nav-enter'), 340);
      }
      btn.classList.toggle('active', on);
    });

    $('titlebarVendor').textContent = PANEL_LABELS[target] || 'AgentDeck';

    // Exactly one native surface may paint at a time: either the OpenChamber
    // WebContentsView, one guest window, or neither.
    deck.setView(target === 'openchamber' ? 'openchamber'
      : (GUEST_PANELS.includes(target) ? target : 'shell'));

    for (const id of GUEST_PANELS) {
      if (id !== target) deck.hideGuest(id);
    }

    state.lastView = target;
    deck.setState({ lastView: target });

    // Follow-up work runs after the frame is committed, never blocking input.
    if (target === 'openchamber') {
      requestAnimationFrame(() => {
        reportContentBounds();
        setTimeout(reportContentBounds, 60);
        ensureChamber();
      });
    } else if (GUEST_PANELS.includes(target)) {
      requestAnimationFrame(() => ensureGuest(target));
    } else if (target === 'claude') {
      requestAnimationFrame(async () => {
        await ensureClaudeTerminal();
        fitTerminal();
      });
    } else if (target === 'workspace' || target === 'settings') {
      requestAnimationFrame(() => {
        renderEnvironment();
        if (target === 'settings') refreshLogTail();
      });
    } else if (target === 'home') {
      requestAnimationFrame(renderDeck);
    }
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => showPanel(btn.dataset.panel));
  });

  // ══════════════════════════════════════════════════════════════════════
  // Home: six front ends, one shared card shape
  // ══════════════════════════════════════════════════════════════════════
  /**
   * One entry per front end. All six render through the same component so a
   * native panel and a hosted application look and measure identically; the
   * only differences are the icon, the accent and the live status.
   */
  const DECK_ITEMS = [
    {
      id: 'openchamber',
      name: 'OpenChamber',
      role: '图形化工作台',
      desc: '多会话聊天、文件浏览、差异审阅、终端与扩展面板。',
      icon: '<path d="M12 3 3 8v8l9 5 9-5V8z"/><path d="M12 3v18"/><path d="M3 8l9 5 9-5"/>',
      accent: 'chamber',
    },
    {
      id: 'claude',
      name: 'Claude Code',
      role: '终端智能体',
      desc: '完整 Ink 终端界面，工具调用与差异预览原样保留。',
      icon: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 10 2.5 2-2.5 2"/><path d="M12.5 14h5"/>',
      accent: 'claude',
    },
    {
      id: 'opcode',
      name: 'opcode',
      role: 'Claude Code 工具包',
      desc: '项目管理、自定义智能体、用量统计与会话检查点。',
      icon: '<path d="M12 2.5 21 7v10l-9 4.5L3 17V7z"/><circle cx="12" cy="12" r="3"/>',
      accent: 'opcode',
    },
    {
      id: 'codex',
      name: 'Codex',
      role: 'Codex 桌面端',
      desc: 'Codex CLI 的图形界面，会话、文件树与终端标签页。',
      icon: '<path d="M12 3.2 20.2 8v8L12 20.8 3.8 16V8z"/><path d="M12 8.4 16.1 11v3.2L12 16.8 7.9 14.2V11z"/>',
      accent: 'codex',
    },
    {
      id: 'emdash',
      name: 'Emdash',
      role: '并行多智能体',
      desc: '每个任务独立 Git worktree，同时跑多个智能体并审阅差异。',
      icon: '<rect x="3" y="4" width="8" height="7" rx="2"/><rect x="13" y="4" width="8" height="7" rx="2"/><rect x="3" y="13" width="8" height="7" rx="2"/><rect x="13" y="13" width="8" height="7" rx="2"/>',
      accent: 'emdash',
    },
    {
      id: 'claudian',
      name: 'Claudian',
      role: 'Obsidian 内运行',
      desc: '以 vault 为工作目录，支持内联编辑、项目与跨会话协作。',
      icon: '<path d="M5 4.5h9.5L19 9v10.5H5z"/><path d="M14.5 4.5V9H19"/><path d="M8.2 12.5h7.6M8.2 16h5"/>',
      accent: 'claudian',
    },
  ];

  let guestInfo = null;

  /** Live status for one card. */
  function deckItemStatus(item) {
    if (item.id === 'openchamber') {
      if (chamberError) return { tone: 'is-error', label: '异常' };
      if (chamberReady) return { tone: 'is-ready', label: '运行中' };
      return { tone: 'is-running', label: '启动中' };
    }
    if (item.id === 'claude') {
      if (termStarted) return { tone: 'is-ready', label: '运行中' };
      if (termStarting) return { tone: 'is-running', label: '启动中' };
      return { tone: '', label: '待启动' };
    }
    const info = guestInfo && guestInfo[item.id];
    if (!info || !info.installed) return { tone: 'is-missing', label: '未打包' };
    const st = guestState[item.id];
    if (st && st.ok) return { tone: 'is-ready', label: '运行中' };
    return { tone: '', label: '就绪' };
  }

  /** One or two real values per card; never a placeholder when data exists. */
  function deckItemMeta(item) {
    if (item.id === 'openchamber') {
      if (!env) return [];
      return [
        `v ${env.agents.openchamber.version || '—'}`,
        `opencode ${env.agents.opencode.version || '—'}`,
      ];
    }
    if (item.id === 'claude') {
      if (!env) return [];
      return [`v ${env.agents.claude.version || '—'}`];
    }
    const info = guestInfo && guestInfo[item.id];
    if (!info || !info.installed) return ['未随包提供'];
    return [info.kind === 'obsidian' ? 'Obsidian' : info.kind];
  }

  function renderDeck() {
    const grid = $('deckGrid');
    if (!grid) return;

    grid.innerHTML = DECK_ITEMS.map((item) => {
      const st = deckItemStatus(item);
      const missing = st.tone === 'is-missing';
      const chips = deckItemMeta(item)
        .map((m) => `<span class="deck-chip">${escapeHtml(m)}</span>`)
        .join('');
      return `<button class="deck-card" type="button" data-deck="${item.id}"
                ${missing ? 'disabled aria-disabled="true"' : ''}>
        <span class="deck-card-head">
          <span class="deck-mark is-${item.accent}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>
          </span>
          <span class="status-pill ${st.tone}"><i class="status-dot"></i><span>${escapeHtml(st.label)}</span></span>
        </span>
        <span class="deck-card-name">${escapeHtml(item.name)}</span>
        <span class="deck-card-role">${escapeHtml(item.role)}</span>
        <span class="deck-card-desc">${escapeHtml(item.desc)}</span>
        <span class="deck-card-meta">${chips}</span>
      </button>`;
    }).join('');

    grid.querySelectorAll('[data-deck]').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.disabled) return;
        showPanel(el.dataset.deck);
      });
    });
  }

  /** Status-only refresh, so the grid is not rebuilt on every poll. */
  function renderDeckStatus() {
    const grid = $('deckGrid');
    if (!grid) return;
    let changed = false;
    for (const item of DECK_ITEMS) {
      const card = grid.querySelector(`[data-deck="${item.id}"]`);
      if (!card) { changed = true; continue; }
      const st = deckItemStatus(item);
      const pill = card.querySelector('.status-pill');
      if (pill) {
        pill.className = `status-pill ${st.tone}`.trim();
        const label = pill.querySelector('span');
        if (label) label.textContent = st.label;
      }
    }
    if (changed) renderDeck();
  }

  function renderHomeStatus() {
    renderDeckStatus();
  }

  // ══════════════════════════════════════════════════════════════════════
  // OpenChamber view state
  // ══════════════════════════════════════════════════════════════════════
  let chamberReady = false;
  let chamberError = '';

  function setChamberPlaceholder(kind, title, note) {
    const ph = $('chamberPlaceholder');
    if (!ph) return;
    if (kind === 'hidden') {
      ph.hidden = true;
      return;
    }
    ph.hidden = false;
    $('chamberPhTitle').textContent = title || '';
    $('chamberPhNote').textContent = note || '';
    $('chamberPhRetry').hidden = kind !== 'error';
  }

  async function ensureChamber() {
    if (chamberReady) return;
    applyServerStatus(await deck.serverStatus());
  }

  function applyServerStatus(status) {
    chamberReady = Boolean(status && status.ready && !status.error);
    chamberError = (status && status.error) || '';
    if (chamberReady) {
      setChamberPlaceholder('hidden');
    } else if (chamberError) {
      setChamberPlaceholder('error', 'OpenChamber 无法启动', chamberError);
    } else {
      setChamberPlaceholder('loading', '正在启动 OpenChamber…', '首次启动需要准备运行环境，请稍候。');
    }
    renderHomeStatus();
  }

  $('chamberPhRetry').addEventListener('click', async () => {
    setChamberPlaceholder('loading', '正在重新启动 OpenChamber…', '正在重新准备运行环境。');
    applyServerStatus(await deck.restartAgent());
    if (chamberReady) reportContentBounds();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Claude Code terminal (xterm.js + PTY)
  // ══════════════════════════════════════════════════════════════════════
  let term = null;
  let fitAddon = null;
  let termStarted = false;
  let termStarting = false;

  /** Terminal colours, swapped with the appearance so text stays legible. */
  const TERM_THEMES = {
    dark: {
      background: '#151313',
      foreground: '#cfcdc7',
      cursor: '#edb449',
      cursorAccent: '#151313',
      selectionBackground: 'rgba(237,180,73,0.28)',
      black: '#1c1c1f', red: '#e26e6e', green: '#9dc76f', yellow: '#e6c07b',
      blue: '#7aa9e0', magenta: '#c78dd8', cyan: '#6fc3c0', white: '#cfcdc7',
      brightBlack: '#6f6d69', brightRed: '#f08a8a', brightGreen: '#b5d98a',
      brightYellow: '#f0cf94', brightBlue: '#96bdea', brightMagenta: '#d7a4e5',
      brightCyan: '#8ad4d1', brightWhite: '#eceae5',
    },
    light: {
      background: '#fffcf0',
      foreground: '#3f3f46',
      cursor: '#b45309',
      cursorAccent: '#fffcf0',
      selectionBackground: 'rgba(180,83,9,0.20)',
      black: '#27272a', red: '#b91c1c', green: '#3f6212', yellow: '#a16207',
      blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0f766e', white: '#52525b',
      brightBlack: '#71717a', brightRed: '#dc2626', brightGreen: '#4d7c0f',
      brightYellow: '#ca8a04', brightBlue: '#2563eb', brightMagenta: '#9333ea',
      brightCyan: '#0d9488', brightWhite: '#3f3f46',
    },
  };

  function terminalTheme() {
    return document.documentElement.dataset.theme === 'light'
      ? TERM_THEMES.light : TERM_THEMES.dark;
  }

  function createTerminal() {
    if (term) return term;
    if (typeof window.Terminal !== 'function') {
      toast('终端组件未能载入');
      return null;
    }

    term = new window.Terminal({
      theme: terminalTheme(),
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      convertEol: false,
      drawBoldTextInBrightColors: true,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      minimumContrastRatio: 1,
      smoothScrollDuration: 0,
    });

    if (window.FitAddon && window.FitAddon.FitAddon) {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
      try {
        term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => deck.openExternal(uri)));
      } catch { /* optional */ }
    }

    term.onData((data) => deck.writeClaude(data));
    term.onResize(({ cols, rows }) => deck.resizeClaude({ cols, rows }));

    const mount = $('termMount');
    mount.innerHTML = '';
    term.open(mount);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (mod && ev.shiftKey && ev.key.toLowerCase() === 'v') {
        navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
        return false;
      }
      return true;
    });

    return term;
  }

  function fitTerminal() {
    if (!term || !fitAddon) return;
    try { fitAddon.fit(); } catch { /* hidden during a panel switch */ }
  }

  function setClaudePlaceholder(kind, title, note) {
    const ph = $('claudePlaceholder');
    if (!ph) return;
    if (kind === 'hidden') { ph.hidden = true; return; }
    ph.hidden = false;
    $('claudePhTitle').textContent = title || '';
    $('claudePhNote').textContent = note || '';
    $('claudePhRetry').hidden = kind !== 'error';
  }

  async function ensureClaudeTerminal(force = false) {
    if (termStarted && !force) return;
    if (termStarting) return;
    termStarting = true;
    setClaudePlaceholder('loading', '正在启动 Claude Code…', '首次启动会进行终端初始化。');

    try {
      if (!createTerminal()) {
        setClaudePlaceholder('error', '终端组件缺失', '渲染层没有找到 xterm.js。');
        return;
      }
      fitTerminal();
      const res = await deck.startClaude({
        cwd: state.claudeCwd,
        cols: term.cols || 120,
        rows: term.rows || 34,
      });
      if (!res || !res.ok) {
        setClaudePlaceholder('error', 'Claude Code 启动失败', (res && res.error) || '未知错误');
        return;
      }
      termStarted = true;
      if (res.cwd) {
        state.claudeCwd = res.cwd;
        updateCwdLabels();
      }
      setTimeout(() => {
        setClaudePlaceholder('hidden');
        fitTerminal();
        if (term) term.focus();
        renderHomeStatus();
      }, 260);
    } finally {
      termStarting = false;
    }
  }

  async function restartClaude() {
    setClaudePlaceholder('loading', '正在重启 Claude Code…', '正在结束上一个终端会话。');
    termStarted = false;
    await deck.stopClaude();
    if (term) term.reset();
    await new Promise((r) => setTimeout(r, 220));
    await ensureClaudeTerminal(true);
  }

  $('claudePhRetry').addEventListener('click', () => restartClaude());
  $('btnTermRestart').addEventListener('click', () => restartClaude());
  $('btnTermCwd').addEventListener('click', pickCwd);

  deck.onClaudeData((data) => { if (term) term.write(data); });

  deck.onClaudeExit(({ exitCode }) => {
    termStarted = false;
    setClaudePlaceholder('error', 'Claude Code 已退出', `进程退出码 ${exitCode}。可以点击重启重新进入。`);
    renderHomeStatus();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Guest front ends
  // ══════════════════════════════════════════════════════════════════════
  /** id → { ok, error, pid } */
  const guestState = {};
  let guestPending = null;

  function guestRect(id) {
    const slot = document.getElementById(`${id}Slot`);
    if (!slot) return null;
    const r = slot.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  function setGuestPlaceholder(id, kind, title, note) {
    const box = document.getElementById(`${id}Placeholder`);
    if (!box) return;
    if (kind === 'hidden') { box.hidden = true; return; }
    box.hidden = false;
    document.getElementById(`${id}PhTitle`).textContent = title || '';
    document.getElementById(`${id}PhNote`).textContent = note || '';
    document.getElementById(`${id}PhRetry`).hidden = kind !== 'error';
  }

  /**
   * Show a guest panel. The guest paints over the page as a real window, so the
   * placeholder is hidden only after the host confirms the window exists —
   * otherwise a failure leaves an empty rectangle with no explanation.
   */
  async function ensureGuest(id, force = false) {
    const rect = guestRect(id);
    if (!rect) {
      requestAnimationFrame(() => ensureGuest(id, force));
      return;
    }

    if (guestState[id] && guestState[id].ok && !force) {
      deck.layoutGuest(id, rect);
      setGuestPlaceholder(id, 'hidden');
      settleGuest(id);
      return;
    }
    if (guestPending === id) return;
    guestPending = id;

    setGuestPlaceholder(id, 'loading', '正在启动…', '首次启动需要准备运行环境。');
    try {
      const res = await deck.showGuest(id, rect);
      guestState[id] = res;
      if (res && res.ok) {
        setGuestPlaceholder(id, 'hidden');
        settleGuest(id);
      } else {
        const missing = Boolean(res && res.missing);
        setGuestPlaceholder(id, 'error',
          missing ? '未随包提供' : '启动失败',
          (res && res.error) || '未知错误');
        if (missing) {
          const retry = document.getElementById(`${id}PhRetry`);
          if (retry) retry.hidden = true;
        }
      }
    } finally {
      if (guestPending === id) guestPending = null;
    }
    refreshGuestInfo();
  }

  /**
   * Re-fit the panel once the placeholder is gone.
   *
   * Hiding the placeholder changes the panel's own layout, so the rectangle
   * measured before it disappeared is not the one the guest has to cover.
   * Measured: the slot's top moved 6 CSS px (9 device px at 1.5x) the moment the
   * placeholder was removed, which left the guest visibly offset by that much.
   * The panel switch also animates, so the slot keeps moving for a few frames —
   * hence both an immediate and a settled pass.
   */
  function settleGuest(id) {
    const refit = () => {
      const next = guestRect(id);
      if (next) deck.layoutGuest(id, next);
    };
    requestAnimationFrame(refit);
    setTimeout(refit, 120);
    setTimeout(refit, 380);
  }

  async function restartGuest(id) {
    guestState[id] = null;
    await deck.stopGuest(id);
    setGuestPlaceholder(id, 'loading', '正在重启…', '');
    await ensureGuest(id, true);
  }

  for (const id of GUEST_PANELS) {
    const retry = document.getElementById(`${id}PhRetry`);
    if (retry) retry.addEventListener('click', () => restartGuest(id));
  }

  deck.onGuestExit(({ id }) => {
    if (!guestState[id]) return;
    guestState[id] = { ok: false, error: '进程已退出' };
    setGuestPlaceholder(id, 'error', '应用已退出', '进程结束。可以点击重启重新进入。');
    refreshGuestInfo();
  });

  /** Refresh the guest registry, then whatever displays it. */
  function refreshGuestInfo() {
    renderHomeStatus();
    if (activePanel === 'settings' || activePanel === 'workspace') renderEnvironment();
  }

  // A guest window is positioned in screen coordinates, so it must follow the
  // host's own resize.
  let guestResizeRaf = 0;
  window.addEventListener('resize', () => {
    if (guestResizeRaf) return;
    guestResizeRaf = requestAnimationFrame(() => {
      guestResizeRaf = 0;
      if (!GUEST_PANELS.includes(activePanel)) return;
      const rect = guestRect(activePanel);
      if (rect) deck.layoutGuest(activePanel, rect);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Working directory
  // ══════════════════════════════════════════════════════════════════════
  function shortenPath(p) {
    if (!p) return '—';
    const parts = p.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) return p;
    return `…${parts.slice(-2).join('/')}`;
  }

  function updateCwdLabels() {
    const cwd = state.claudeCwd || '—';
    $('cwdPath').textContent = cwd;
    $('termCwdLabel').textContent = shortenPath(state.claudeCwd);
    $('termCwdLabel').title = state.claudeCwd || '';
  }

  async function pickCwd() {
    const dir = await deck.pickDirectory();
    if (!dir) return;
    state.claudeCwd = dir;
    updateCwdLabels();
    toast('工作目录已更新，重启智能体后生效');
  }

  $('btnPickCwd').addEventListener('click', pickCwd);
  $('btnResetCwd').addEventListener('click', async () => {
    const next = await deck.setState({ claudeCwd: '' });
    state.claudeCwd = next.claudeCwd || '';
    updateCwdLabels();
    toast('已恢复默认目录');
  });

  // ══════════════════════════════════════════════════════════════════════
  // Settings / environment
  // ══════════════════════════════════════════════════════════════════════
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function envRow(name, detail, badge, tone) {
    return `<div class="env-row">
      <span class="env-name">${escapeHtml(name)}</span>
      <span class="env-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      <span class="env-badge ${tone}">${escapeHtml(badge)}</span>
    </div>`;
  }

  function renderEnvironment() {
    if (!env) return;

    const chamber = env.agents.openchamber;
    const claude = env.agents.claude;
    const opencode = env.agents.opencode;
    const rg = env.agents.ripgrep;

    $('envList').innerHTML = [
      envRow('OpenChamber 服务',
        chamber.error ? chamber.error : (chamber.url || (chamber.present ? '已就绪' : '未启动')),
        chamber.error ? '异常' : (chamber.present ? '正常' : '未启动'),
        chamber.error ? 'bad' : (chamber.present ? 'ok' : 'idle')),
      envRow('Claude Code',
        claude.present ? (claude.running ? `运行中 · ${claude.version}` : `就绪 · ${claude.version}`) : '缺少构建产物',
        claude.present ? (claude.running ? '运行中' : '就绪') : '缺失',
        claude.present ? (claude.running ? 'ok' : 'idle') : 'bad'),
      envRow('OpenCode 二进制',
        opencode.present ? `${opencode.version || '未知版本'}` : '缺少 vendor/opencode',
        opencode.present ? '正常' : '缺失',
        opencode.present ? 'ok' : 'bad'),
      envRow('ripgrep', rg.present ? rg.path : '未随包提供',
        rg.present ? '正常' : '缺失', rg.present ? 'ok' : 'bad'),
    ].join('');

    if (guestInfo) {
      $('guestList').innerHTML = GUEST_PANELS.map((id) => {
        const info = guestInfo[id] || { label: id, installed: false, path: '' };
        const st = guestState[id];
        const running = Boolean(st && st.ok);
        const detail = !info.installed
          ? `未随包提供 · ${info.path}`
          : running
            ? `运行中 · pid ${st.pid ?? '—'}`
            : `就绪 · ${info.path}`;
        return envRow(info.label, detail,
          !info.installed ? '缺失' : (running ? '运行中' : '就绪'),
          !info.installed ? 'bad' : (running ? 'ok' : 'idle'));
      }).join('');
    }

    $('aboutGrid').innerHTML = [
      envRow('应用版本', `AgentDeck ${env.app.version}`, '版本', 'idle'),
      envRow('Electron', `${env.app.electron} · Chrome ${env.app.chrome}`, '运行时', 'idle'),
      envRow('Node.js', env.app.node, '运行时', 'idle'),
      envRow('平台', env.app.platform, '架构', 'idle'),
      envRow('数据目录', env.app.userData, '路径', 'idle'),
      envRow('智能体数据', env.app.agentHome || '—', '路径', 'idle'),
    ].join('');

    $('userDataPath').textContent = env.app.userData;
    $('userDataPath').title = env.app.userData;
    $('agentHomePath').textContent = env.app.agentHome || '—';
    $('agentHomePath').title = env.app.agentHome || '';
  }

  async function refreshLogTail() {
    const el = $('logTail');
    if (!el) return;
    const res = await deck.recentLog();
    if (res && res.tail) el.textContent = `${res.path}\n\n${res.tail}`;
    else if (res && res.error) el.textContent = `无法读取日志：${res.error}`;
    else el.textContent = '（暂无日志）';
  }

  $('themeSelect').addEventListener('change', async (ev) => {
    const theme = ev.target.value;
    state.theme = theme;
    await deck.setState({ theme });
    applyTheme(theme);
    if (term) term.options.theme = terminalTheme();
  });

  $('btnReloadChamber').addEventListener('click', async (ev) => {
    ev.currentTarget.classList.add('is-spinning');
    await deck.reloadAgent();
    setTimeout(() => ev.currentTarget.classList.remove('is-spinning'), 900);
    toast('已重新载入 OpenChamber');
  });

  $('btnRestartChamber').addEventListener('click', async () => {
    toast('正在重启 OpenChamber 服务…');
    setChamberPlaceholder('loading', '正在重启 OpenChamber…', '正在重新准备运行环境。');
    applyServerStatus(await deck.restartAgent());
    if (chamberReady) reportContentBounds();
    toast(chamberReady ? 'OpenChamber 已重启' : 'OpenChamber 重启失败');
  });

  $('btnRestartClaude').addEventListener('click', () => restartClaude());

  $('btnOpenUserData').addEventListener('click', async () => {
    if (!env) return;
    await deck.openExternal(`file:///${env.app.userData.replace(/\\/g, '/')}`);
  });

  $('btnOpenLog').addEventListener('click', async () => {
    const ok = await deck.openLog();
    if (!ok) toast('无法打开日志文件');
  });

  $('btnReload').addEventListener('click', async (ev) => {
    ev.currentTarget.classList.add('is-spinning');
    if (activePanel === 'claude') await restartClaude();
    else if (GUEST_PANELS.includes(activePanel)) await restartGuest(activePanel);
    else await deck.reloadAgent();
    setTimeout(() => ev.currentTarget.classList.remove('is-spinning'), 900);
  });

  $('btnRestart').addEventListener('click', async (ev) => {
    ev.currentTarget.classList.add('is-spinning');
    if (activePanel === 'claude') await restartClaude();
    else if (GUEST_PANELS.includes(activePanel)) await restartGuest(activePanel);
    else {
      applyServerStatus(await deck.restartAgent());
      if (chamberReady) reportContentBounds();
    }
    setTimeout(() => ev.currentTarget.classList.remove('is-spinning'), 900);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Boot
  // ══════════════════════════════════════════════════════════════════════
  function runSplash() {
    const splash = $('splashScreen');
    const brand = $('splashBrand');
    const tag = $('splashTag');
    if (!splash || !brand || !tag) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        brand.style.transition = 'transform .5s cubic-bezier(0.34, 1.56, 0.64, 1), opacity .35s ease-out';
        brand.style.opacity = '1';
        brand.style.transform = 'scale(1)';
      });
    });

    setTimeout(() => {
      brand.style.transition = 'transform .4s cubic-bezier(0.22, 0.61, 0.36, 1)';
      brand.style.transform = 'scale(1) translateY(-10px)';
      tag.style.transition = 'opacity .35s ease-out, transform .4s cubic-bezier(0.22, 0.61, 0.36, 1)';
      tag.style.opacity = '1';
      tag.style.transform = 'translateY(8px)';
    }, 500);

    setTimeout(() => {
      splash.style.transition = 'opacity .25s ease-out';
      splash.style.opacity = '0';
      splash.style.pointerEvents = 'none';
    }, 1200);

    setTimeout(() => { splash.style.display = 'none'; }, 1500);
  }

  deck.onServerStatus(applyServerStatus);

  deck.onEnvironment((report) => {
    env = report;
    renderHomeStatus();
    if (activePanel === 'settings' || activePanel === 'workspace') renderEnvironment();
  });

  deck.onState((next) => {
    state = { ...state, ...next };
    updateCwdLabels();
    applyTheme(state.theme || 'system');
    renderHomeStatus();
  });

  window.addEventListener('DOMContentLoaded', async () => {
    runSplash();

    const [initialState, status, report] = await Promise.all([
      deck.getState(),
      deck.serverStatus(),
      deck.environment(),
    ]);

    state = { ...state, ...initialState };
    env = report;
    guestInfo = await deck.guestStatus().catch(() => null);

    applyTheme(state.theme || 'system');
    $('themeSelect').value = state.theme || 'system';
    updateCwdLabels();
    renderDeck();
    renderEnvironment();
    applyServerStatus(status);
    refreshLogTail();

    // Always open on Home. Restoring into a panel would start work the user did
    // not ask for: the terminal would spawn a PTY, OpenChamber may still be
    // booting (an empty black panel), and a guest would launch as its own window
    // for a moment before it is adopted — which is exactly the flash of a
    // separate window seen at startup.
    showPanel('home');
    reportContentBounds();
  });
})();
