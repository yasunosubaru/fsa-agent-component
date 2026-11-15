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
    'home', 'openchamber', 'claude', 'codex',
    'workspace', 'sandbox', 'settings',
  ];
  const PANEL_LABELS = {
    home: 'AgentDeck',
    openchamber: 'OpenChamber',
    claude: 'Claude Code',
    codex: 'Codex',
    workspace: '工作目录',
    sandbox: '沙盒环境',
    settings: '设置',
  };
  /** Panels whose content is a real foreign application window. */
  const GUEST_PANELS = ['claude', 'codex'];

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

    // Lets panel-local polling start and stop with the panel being visible, without
    // showPanel having to know which panels poll.
    window.dispatchEvent(new CustomEvent('panel-change', { detail: target }));

    // Follow-up work runs after the frame is committed, never blocking input.
    if (target === 'openchamber') {
      requestAnimationFrame(() => {
        reportContentBounds();
        setTimeout(reportContentBounds, 60);
        ensureChamber();
      });
    } else if (GUEST_PANELS.includes(target)) {
      // Claude Code and Codex are both real application windows now, so both go
      // through the guest path.
      requestAnimationFrame(() => ensureGuest(target));
    } else if (target === 'workspace' || target === 'settings') {
      requestAnimationFrame(() => {
        renderEnvironment();
        if (target === 'settings') refreshLogTail();
      });
    } else if (target === 'sandbox') {
      requestAnimationFrame(loadSandboxPanel);
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
      role: '桌面客户端',
      desc: '官方 Claude Code CLI 的图形外壳：会话侧栏、对话、终端与差异视图。',
      icon: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 10 2.5 2-2.5 2"/><path d="M12.5 14h5"/>',
      accent: 'claude',
    },
    {
      id: 'codex',
      name: 'Codex',
      role: '桌面客户端',
      desc: 'OpenAI 官方 Codex 桌面端，原版界面。',
      icon: '<path d="M12 3.2 19.5 7v9.6L12 20.8 4.5 16.6V7z"/><circle cx="12" cy="12" r="3"/>',
      accent: 'codex',
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

    // Claude Code and Codex are both guest windows now, so both report the same
    // way: from the registry, not from terminal state.
    const info = guestInfo && guestInfo[item.id];
    if (!info) return { tone: '', label: '就绪' };
    if (!info.installed) return { tone: 'is-error', label: '未随包提供' };

    const st = guestState[item.id];
    if (st && st.ok) return { tone: 'is-ready', label: '运行中' };
    if (guestPending === item.id) return { tone: 'is-running', label: '启动中' };
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
    const info = guestInfo && guestInfo[item.id];
    if (!info) return [];
    if (!info.installed) return ['未随包提供'];
    return [info.kind === 'electron' ? 'Electron' : 'Tauri'];
  }

  function renderDeck() {
    const grid = $('deckGrid');
    if (!grid) return;

    grid.innerHTML = DECK_ITEMS.map((item) => {
      const st = deckItemStatus(item);
      const missing = st.tone === 'is-error';
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
      // A cached success only means the guest was shown once. Coming back to the
      // panel after a visit to another one finds the window hidden, so the layout
      // call has to be able to bring it back — and if it reports the window is
      // gone, fall through to a real launch instead of leaving an empty panel.
      const laid = await deck.layoutGuest(id, rect);
      if (!laid || laid.ok !== false) {
        setGuestPlaceholder(id, 'hidden');
        settleGuest(id);
        return;
      }
      guestState[id] = null;
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
    const refit = async () => {
      const next = guestRect(id);
      if (!next) return;
      const r = await deck.layoutGuest(id, next);
      // The window can disappear between the click and this pass. Retrying the
      // launch is better than leaving a panel that looks broken.
      if (r && r.ok === false && activePanel === id) {
        guestState[id] = null;
        ensureGuest(id, true);
      }
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

  // ── provider for Claude Code ──────────────────────────────────────────
  /**
   * The settings fields for the model provider.
   *
   * The key is never read back from the main process: the panel only learns
   * whether one is stored. An empty field therefore means "keep the saved one",
   * which the main process understands.
   */
  const provFields = () => ({
    baseUrl: $('provBase').value.trim(),
    model: $('provModel').value.trim(),
    apiKey: $('provKey').value,
    proxy: $('provProxy').value.trim(),
  });

  function setProvStatus(text, tone = '') {
    const el = $('provStatus');
    el.textContent = text;
    el.dataset.tone = tone;
  }

  async function loadProvider() {
    const info = await deck.providerGet().catch(() => ({ configured: false }));
    $('provBase').value = info.baseUrl || '';
    $('provModel').value = info.model || '';
    $('provProxy').value = info.proxy || '';
    $('provKey').value = '';
    $('provKey').placeholder = info.hasKey ? '已保存，留空则不修改' : '请填写密钥';
    setProvStatus(info.configured ? '已启用' : '未配置', info.configured ? 'ok' : '');
  }

  $('btnProvTest').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    setProvStatus('正在测试…');
    try {
      const res = await deck.providerTest(provFields());
      if (res && res.ok) setProvStatus(`连通，模型回复：${res.text || '（空）'}`, 'ok');
      else setProvStatus(`失败：${(res && res.error) || '未知错误'}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnProvSave').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const f = provFields();
    if (!f.baseUrl || !f.model) {
      setProvStatus('接口地址和模型都必须填写', 'error');
      return;
    }
    btn.disabled = true;
    try {
      await deck.providerSet({ ...f, enabled: true });
      setProvStatus('已保存，正在重启 Claude Code…', 'ok');
      await loadProvider();
      await loadSandbox();
      await restartGuest('claude');
      toast('已切换到配置的模型提供方');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnProvClear').addEventListener('click', async () => {
    await deck.providerClear();
    await loadProvider();
    setProvStatus('已清除，将直连 Anthropic');
    toast('已清除模型提供方配置');
  });

  // ── sandbox readiness ─────────────────────────────────────────────────
  /**
   * Show the sandbox's real state.
   *
   * Each blocker is listed with its own remedy, because "unavailable" alone leaves
   * the user with nothing to do. The runtime is bundled, so "not installed" means
   * the bundle itself is damaged, not that something must be downloaded.
   */
  function renderSandbox(st) {
    const box = $('sandboxStatus');
    if (!box) return;

    if (!st || st.installed === false) {
      box.innerHTML = `<div class="env-row">
        <span class="env-k">运行时</span>
        <span class="env-v">随包缺失 — ${escapeHtml((st && st.error) || '未找到 sbx')}</span>
      </div>`;
      return;
    }

    const row = (k, v) => `<div class="env-row"><span class="env-k">${k}</span><span class="env-v">${v}</span></div>`;
    const yes = '<span style="color:var(--ok)">就绪</span>';
    const no = '<span style="color:var(--warn)">未就绪</span>';

    // A sandbox list is only useful with names: "2 sandboxes" does not tell anyone
    // which one the agent will run in, and after a rename it says nothing at all.
    const list = (st.sandboxes || []).filter((s) => s && s.name);
    const listRow = list.length
      ? row('已有沙盒', list.map((s) =>
        `${escapeHtml(s.name)} <span class="muted">${escapeHtml(s.status || '')}</span>`).join('<br>'))
      : '';

    box.innerHTML = [
      row('运行时', st.bundled ? '已随包附带' : '缺失'),
      row('Windows 虚拟化', st.virtualization ? yes : no),
      row('守护进程', st.daemon ? yes : no),
      row('Docker 账号', st.signedIn ? yes : no),
      // Which sandbox this app runs in, spelled out: a bare count never answers
      // "which one am I about to touch".
      row('本应用使用的沙盒', st.activeName
        ? `<span style="color:var(--ok)">${escapeHtml(st.activeName)}</span>`
        : '<span class="muted">尚未创建</span>'),
      listRow,
      st.blockers && st.blockers.length
        ? `<div class="env-row"><span class="env-k">待解决</span><span class="env-v">${st.blockers.map(escapeHtml).join('；')}</span></div>`
        : '',
    ].join('');
  }

  async function loadSandbox() {
    const st = await deck.sandboxStatus().catch((e) => ({ installed: false, error: String(e) }));
    renderSandbox(st);
    return st;
  }

  /** Show a sandbox command's real output, including a failure reason. */
  function showSandboxOutput(result, heading) {
    const out = $('sandboxOut');
    if (!out) return;
    const parts = [heading];
    if (result && result.name) parts.push(`沙盒: ${result.name}`);
    if (result && result.workspace) parts.push(`工作目录: ${result.workspace}`);
    if (result && result.stdout) parts.push(result.stdout.trim());
    if (result && result.error) parts.push(`错误: ${result.error}`);
    if (result && result.ok === false && !result.error) parts.push('失败（无输出）');
    out.hidden = false;
    out.textContent = parts.filter(Boolean).join('\n');
  }

  const btnSandboxCreate = $('btnSandboxCreate');
  if (btnSandboxCreate) {
    btnSandboxCreate.addEventListener('click', async () => {
      btnSandboxCreate.disabled = true;
      showSandboxOutput({ ok: null }, '正在准备沙盒（首次创建要导入镜像，可能需要一分钟）…');
      try {
        const res = await deck.sandboxCreate({ label: 'agent' });
        showSandboxOutput(res, res.ok ? '沙盒已就绪' : '沙盒创建失败');
        toast(res.ok ? `沙盒 ${res.name} 已就绪` : '沙盒创建失败');
      } catch (e) {
        showSandboxOutput({ ok: false, error: String(e) }, '沙盒创建失败');
      } finally {
        btnSandboxCreate.disabled = false;
        await loadSandbox();
      }
    });
  }

  const btnSandboxProbe = $('btnSandboxProbe');
  if (btnSandboxProbe) {
    btnSandboxProbe.addEventListener('click', async () => {
      btnSandboxProbe.disabled = true;
      showSandboxOutput({ ok: null }, '正在沙盒内自检…');
      try {
        // One command that proves the things a user would check by hand: which
        // OS it is, how much CPU and memory it got, that the toolchain exists,
        // and that the mounted workspace is writable.
        const cmd = [
          'echo "os: $(. /etc/os-release; echo $PRETTY_NAME)"',
          'echo "cpus: $(nproc)"',
          'echo "mem: $(awk \'/MemTotal/{printf "%.1fG", $2/1048576}\' /proc/meminfo)"',
          'echo "python: $(python3 -V 2>&1)"',
          'echo "node: $(node -v 2>&1)"',
          'echo "gcc: $(gcc -dumpversion 2>&1)"',
          'printf "workspace: writable\\n" > .agentdeck-probe',
          'cat .agentdeck-probe',
          'echo "host-fs: $(ls /mnt 2>/dev/null | tr "\\n" " ")"',
        ].join('; ');
        const res = await deck.sandboxExec({ command: cmd });
        showSandboxOutput(res, res.ok ? '沙盒自检结果' : '沙盒自检失败');
      } catch (e) {
        showSandboxOutput({ ok: false, error: String(e) }, '沙盒自检失败');
      } finally {
        btnSandboxProbe.disabled = false;
      }
    });
  }

  const btnSandboxRefresh = $('btnSandboxRefresh');
  if (btnSandboxRefresh) {
    btnSandboxRefresh.addEventListener('click', async () => {
      btnSandboxRefresh.disabled = true;
      await loadSandbox();
      btnSandboxRefresh.disabled = false;
    });
  }

  // ── sandbox panel: kernel, resources, isolation ────────────────────────
  /**
   * Build the sandbox status page.
   *
   * Every number comes from the guest kernel, so this is a report of what is
   * actually running. Facts are grouped the way someone would ask about them —
   * what it is, what it was given, what it can reach, what is installed — rather
   * than dumped as one flat list.
   */
  function renderSandboxPanel(info) {
    const body = $('sbxBody');
    if (!body) return;

    if (!info || info.ok === false) {
      body.innerHTML = `<div class="env-empty">${
        escapeHtml((info && info.error) || '没有可用的沙盒')}</div>`;
      return;
    }

    const card = (title, rows) => `
      <section class="sbx-card">
        <h3 class="sbx-card-title">${escapeHtml(title)}</h3>
        <div class="sbx-rows">
          ${rows.filter(Boolean).map(([k, v, tone]) => `
            <div class="sbx-row">
              <span class="sbx-k">${escapeHtml(k)}</span>
              <span class="sbx-v ${tone || ''}">${v}</span>
            </div>`).join('')}
        </div>
      </section>`;

    const ok = (v) => `<span class="sbx-good">${escapeHtml(String(v))}</span>`;
    const bad = (v) => `<span class="sbx-bad">${escapeHtml(String(v))}</span>`;
    const mono = (v) => `<code>${escapeHtml(String(v || '—'))}</code>`;

    const k = info.kernel || {};
    const cpu = info.cpu || {};
    const mem = info.memory || {};
    const disk = info.disk || {};
    const iso = info.isolation || {};
    const tc = info.toolchain || {};
    const net = info.network || {};

    const memPct = mem.totalMb ? Math.round((mem.availableMb / mem.totalMb) * 100) : 0;

    body.innerHTML = [
      card('内核与系统', [
        ['发行版', mono(k.os)],
        ['内核版本', mono(k.release)],
        ['内核构建', mono(k.build)],
        ['架构', mono(k.arch)],
      ]),
      card('资源', [
        ['CPU 核心', mono(`${cpu.cores} 核`)],
        ['CPU 型号', mono(cpu.model)],
        ['负载', mono(cpu.loadavg)],
        ['内存', `${mono(`${mem.availableMb} / ${mem.totalMb} MB`)} <span class="sbx-muted">可用 ${memPct}%</span>`],
        ['根分区', mono(`${disk.rootFree} 可用 / ${disk.rootTotal}（已用 ${disk.rootUsedPct}）`)],
        ['Docker 卷', mono(`${disk.dockerFree} 可用 / ${disk.dockerTotal}`)],
      ]),
      card('隔离（实测）', [
        ['宿主挂载点', iso.hostMounts === 0 ? ok('0 个（未挂载宿主）') : bad(`${iso.hostMounts} 个`)],
        ['Windows 盘可见', iso.windowsDrive === 'absent' ? ok('不可见') : bad(String(iso.windowsDrive))],
        ['挂载总数', mono(String(iso.mountCount))],
        ['Seccomp 过滤', iso.seccomp > 0 ? ok('已启用') : bad('未启用')],
        ['Linux 能力', iso.capabilities === 'none' ? ok('无（零特权）') : bad(String(iso.capabilities))],
        ['运行用户', iso.isRoot ? bad(`${iso.user}（root）`) : ok(`${iso.user}（非 root）`)],
      ]),
      card('工具链', [
        ['Python', mono(tc.python)],
        ['Node', mono(tc.node)],
        ['GCC', mono(tc.gcc)],
        ['Go', mono(tc.go)],
        ['Rust', mono(tc.rust)],
      ]),
      card('网络', [
        ['接口', mono((net.interfaces || []).join(', '))],
      ]),
    ].join('');
  }

  let sandboxPanelBusy = false;
  // Declared before the loader that uses them: `loadSandboxPanel` runs on a panel
  // switch, but keeping the order obvious avoids relying on that.
  let procTimer = 0;
  let procPaused = false;
  let procBusy = false;

  async function loadSandboxPanel() {
    if (sandboxPanelBusy) return;
    sandboxPanelBusy = true;
    const timeEl = $('sbxProbeTime');
    if (timeEl) timeEl.textContent = '读取中…';
    try {
      const info = await deck.sandboxInspect();
      renderSandboxPanel(info);
      if (timeEl) {
        timeEl.textContent = info && info.ok
          ? `内核实测耗时 ${info.probeMs} ms · 沙盒 ${info.name}`
          : '';
      }
    } catch (e) {
      renderSandboxPanel({ ok: false, error: String(e) });
      if (timeEl) timeEl.textContent = '';
    } finally {
      sandboxPanelBusy = false;
    }
    // The command list is part of this panel, so it is refreshed with it.
    await loadCommands();
    await refreshWatchStatus();
    // And it keeps refreshing while the panel is open.
    if (!cmdPaused) startCmdPolling();
    // And so is the live process table.
    if (!procPaused) startProcPolling();
  }

  // ── live process table ─────────────────────────────────────────────────
  /**
   * Poll the sandbox's process table while its panel is open.
   *
   * Polling stops when the panel is left and when the user pauses it: a shell
   * running in the guest every second for a page nobody is looking at wastes the
   * sandbox's CPU, and the point of this view is to see the guest's real load.
   */
  function renderProcesses(data) {    const body = $('sbxProcBody');
    if (!body) return;
    const rows = (data && data.processes) || [];

    if (!data || data.ok === false) {
      body.innerHTML = `<tr><td colspan="5" class="sbx-proc-empty">${
        escapeHtml((data && data.error) || '读取失败')}</td></tr>`;
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="sbx-proc-empty">沙盒内没有进程</td></tr>';
      return;
    }

    body.innerHTML = rows.map((p) => {
      const stateLabel = { R: '运行', S: '休眠', D: '等待IO', Z: '僵尸', T: '停止' }[p.state] || p.state;
      return `<tr>
        <td class="sbx-proc-num">${p.pid}</td>
        <td class="sbx-proc-num">${p.ppid}</td>
        <td class="sbx-proc-state">${escapeHtml(stateLabel)}</td>
        <td class="sbx-proc-num">${p.rssMb ? `${p.rssMb}M` : '—'}</td>
        <td class="sbx-proc-cmd" title="${escapeHtml(p.command)}">${escapeHtml(p.command)}</td>
      </tr>`;
    }).join('');

    const meta = $('sbxProcMeta');
    if (meta) meta.textContent = `${rows.length} 个进程`;
  }

  async function tickProcesses() {
    if (procPaused || procBusy || activePanel !== 'sandbox') return;
    procBusy = true;
    try {
      renderProcesses(await deck.sandboxProcesses());
    } catch (e) {
      renderProcesses({ ok: false, error: String(e) });
    } finally {
      procBusy = false;
    }
  }

  function startProcPolling() {
    stopProcPolling();
    tickProcesses();
    procTimer = setInterval(tickProcesses, 2500);
    const dot = $('sbxProcDot');
    if (dot) dot.dataset.on = '1';
  }

  function stopProcPolling() {
    if (procTimer) clearInterval(procTimer);
    procTimer = 0;
    const dot = $('sbxProcDot');
    if (dot) dot.dataset.on = '0';
  }

  $('btnSbxProcToggle')?.addEventListener('click', (ev) => {
    procPaused = !procPaused;
    ev.currentTarget.textContent = procPaused ? '继续' : '暂停';
    if (procPaused) stopProcPolling();
    else startProcPolling();
  });

  // The timer must not keep running while another panel is on screen.
  window.addEventListener('panel-change', (ev) => {
    if (ev.detail === 'sandbox') startProcPolling();
    else stopProcPolling();
  });

  $('btnSbxRefresh')?.addEventListener('click', loadSandboxPanel);

  // ── command log ────────────────────────────────────────────────────────
  /**
   * Render the command records, each with its own proof of where it ran.
   *
   * The proof is shown per row rather than summarised once: the question "did this
   * one really run in the sandbox" is asked per command, and a header claiming all
   * of them were sandboxed would be an assertion rather than evidence.
   *
   * The list is live, so two things matter more than layout:
   *   • If the reader has scrolled up to look at something, a refresh must not drag
   *     them back to the top. The scroll offset is preserved unless they were
   *     already at the top, where staying pinned to the newest is what they want.
   *   • Open rows stay open across refreshes; a record that collapses while being
   *     read is unusable for the job this panel does.
   */
  let cmdCache = [];
  let cmdOpen = new Set();
  let cmdScrollTop = 0;

  function matchesSearch(entry, terms, filter) {
    if (filter === 'verified' && entry.source !== 'verified') return false;
    if (filter === 'shim' && entry.source !== 'shim') return false;
    if (filter === 'failed' && entry.code !== null && entry.code !== undefined && entry.code === 0) return false;
    if (filter === 'failed' && (entry.code === null || entry.code === undefined)) return false;
    if (!terms.length) return true;
    // Every term must appear somewhere: a search for two words means both, which is
    // what people expect when they type more than one.
    const hay = [
      entry.command, entry.origin, entry.stdout, entry.stderr,
      entry.cwd, entry.proof && entry.proof.kernel, String(entry.pid || ''),
    ].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  }

  function renderCommands(data) {
    const list = $('sbxCmdList');
    if (!list) return;
    const entries = (data && data.entries) || [];
    cmdCache = entries;

    const count = $('sbxCmdCount');
    if (count) {
      const c = (data && data.counts) || {};
      count.textContent = entries.length
        ? `共 ${entries.length} 条（已验证 ${c.verified || 0} · 观测 ${c.observed || 0}）`
        : '';
    }

    const searchEl = $('sbxCmdSearch');
    const filterEl = $('sbxCmdFilter');
    const terms = String(searchEl && searchEl.value || '').toLowerCase().split(/\s+/).filter(Boolean);
    const filter = filterEl ? filterEl.value : 'all';
    const shown = entries.filter((e) => matchesSearch(e, terms, filter));

    const matchEl = $('sbxCmdMatches');
    if (matchEl) {
      matchEl.textContent = terms.length || filter !== 'all'
        ? `匹配 ${shown.length} / ${entries.length}`
        : '';
    }

    if (!entries.length) {
      list.innerHTML = `<div class="env-empty">还没有命令记录。上面的按钮或任何 agent 在沙盒中执行命令都会出现在这里。</div>`;
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<div class="env-empty">没有匹配的记录。换个关键词试试。</div>`;
      return;
    }

    const wasAtTop = cmdScrollTop <= 4;

    // Newest first: the thing just run is the thing being looked for.
    const rows = [...shown].reverse().map((e) => {
      const v = e.verdict || {};
      const sandboxed = v.sandboxed === true;
      const unknown = v.sandboxed === null;
      // Two kinds of record, labelled apart on purpose: a verified run carries the
      // kernel's own proof and an exit code, an observed one only says the command
      // was started inside the sandbox. Calling them the same thing would overstate
      // what the observed ones can prove.
      const badge = e.source === 'shim'
        ? '<span class="sbx-cmd-badge sbx-shiM">沙盒内观测</span>'
        : unknown
          ? '<span class="sbx-cmd-badge sbx-unknown">无凭证</span>'
          : sandboxed
            ? '<span class="sbx-cmd-badge sbx-good">已验证</span>'
            : '<span class="sbx-cmd-badge sbx-bad">凭证异常</span>';

      const p = e.proof || {};
      const proofLine = p.kernel
        ? `内核 ${escapeHtml(p.kernel)} · ${escapeHtml(p.pidns || '')} · ${escapeHtml(p.netns || '')} · Windows ${escapeHtml(p.windows || '?')} · uid ${escapeHtml(String(p.uid ?? '?'))}`
        : escapeHtml(v.reason || '');

      const out = String(e.stdout || '').trim();
      const err = String(e.stderr || '').trim();
      const when = e.startedAt ? new Date(e.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      const key = `${e.source}:${e.id ?? e.pid ?? ''}:${e.startedAt ?? ''}`;
      const open = cmdOpen.has(key) ? ' open' : '';

      return `
        <details class="sbx-cmd" data-key="${escapeHtml(key)}"${open}>
          <summary class="sbx-cmd-head">
            ${badge}
            <span class="sbx-cmd-when">${escapeHtml(when)}</span>
            <span class="sbx-cmd-origin">${escapeHtml(e.origin || '?')}</span>
            <code class="sbx-cmd-text">${escapeHtml(e.command)}</code>
            <span class="sbx-cmd-meta">${e.code === null || e.code === undefined ? '' : `exit ${e.code}`}${
              e.durationMs ? ` · ${e.durationMs}ms` : ''}</span>
          </summary>
          <div class="sbx-cmd-body">
            <div class="sbx-cmd-proof">${proofLine}</div>
            ${e.cwd ? `<div class="sbx-cmd-proof">目录 ${escapeHtml(e.cwd)}</div>` : ''}
            ${out ? `<pre class="sbx-cmd-out">${escapeHtml(out)}</pre>` : ''}
            ${err ? `<pre class="sbx-cmd-err">${escapeHtml(err)}</pre>` : ''}
          </div>
        </details>`;
    }).join('');

    list.innerHTML = rows;

    // Remember which rows the reader opened, so the next refresh keeps them that way.
    for (const d of list.querySelectorAll('.sbx-cmd')) {
      d.addEventListener('toggle', () => {
        const k = d.dataset.key;
        if (d.open) cmdOpen.add(k);
        else cmdOpen.delete(k);
      });
    }

    // Restore the reading position: only follow the newest when already at the top.
    list.scrollTop = wasAtTop ? 0 : cmdScrollTop;
    if (!wasAtTop) cmdScrollTop = list.scrollTop;
  }

  async function loadCommands() {
    try {
      renderCommands(await deck.sandboxCommands(200));
    } catch (e) {
      const list = $('sbxCmdList');
      if (list) list.innerHTML = `<div class="env-empty">读取失败：${escapeHtml(String(e))}</div>`;
    }
  }

  // ── live refresh ───────────────────────────────────────────────────────
  /**
   * Poll while the panel is open.
   *
   * Three seconds rather than one: each poll shells into the sandbox to read /proc
   * for the process view, and a tighter interval would cost more than the freshness
   * is worth. A command that runs for seconds still appears while it is running,
   * because the record is written before the command starts.
   */
  let cmdTimer = 0;
  let cmdPaused = false;
  let cmdBusy = false;

  async function tickCommands() {
    if (cmdPaused || cmdBusy || activePanel !== 'sandbox') return;
    cmdBusy = true;
    const dot = $('sbxCmdDot');
    if (dot) dot.dataset.on = '0';
    try {
      await loadCommands();
    } finally {
      cmdBusy = false;
      if (dot && !cmdPaused) dot.dataset.on = '1';
    }
  }

  function startCmdPolling() {
    stopCmdPolling();
    if (cmdPaused) return;
    tickCommands();
    cmdTimer = setInterval(tickCommands, 3000);
    const dot = $('sbxCmdDot');
    if (dot) dot.dataset.on = '1';
  }

  function stopCmdPolling() {
    if (cmdTimer) clearInterval(cmdTimer);
    cmdTimer = 0;
    const dot = $('sbxCmdDot');
    if (dot) dot.dataset.on = '0';
  }

  $('btnSbxCmdPause')?.addEventListener('click', (ev) => {
    cmdPaused = !cmdPaused;
    ev.currentTarget.textContent = cmdPaused ? '继续' : '暂停';
    if (cmdPaused) stopCmdPolling();
    else startCmdPolling();
  });

  // Remember the scroll position so a refresh does not move the reader's place.
  $('sbxCmdList')?.addEventListener('scroll', (ev) => {
    cmdScrollTop = ev.currentTarget.scrollTop;
  });

  // Search and filter re-render immediately; no wait for the next poll.
  $('sbxCmdSearch')?.addEventListener('input', () => renderCommands({ entries: cmdCache }));
  $('sbxCmdFilter')?.addEventListener('change', () => renderCommands({ entries: cmdCache }));

  /** Show whether the in-sandbox recorder is installed, without pretending. */
  async function refreshWatchStatus() {
    const note = $('sbxWatchNote');
    const btn = $('btnSbxInstallWatch');
    try {
      const st = await deck.sandboxWatchStatus();
      if (!note) return;
      if (st.installed) {
        note.textContent = `命令记录器已安装（${st.dir}）。沙盒内每条命令都会被记录，开销约 3–4ms/条。`;
        if (btn) { btn.textContent = '重新安装记录器'; btn.hidden = false; }
      } else {
        note.textContent = '命令记录器未安装：只能看到 AgentDeck 发起的命令，看不到 agent 自己起的命令。';
        if (btn) { btn.textContent = '安装命令记录器'; btn.hidden = false; }
      }
    } catch (e) {
      if (note) note.textContent = `记录器状态读取失败：${String(e)}`;
    }
  }

  $('btnSbxInstallWatch')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const note = $('sbxWatchNote');
    btn.disabled = true;
    btn.textContent = '正在安装…';
    if (note) note.textContent = '正在把记录器装进沙盒（约 2000 个命令软链，需要几秒）…';
    try {
      const res = await deck.sandboxInstallWatch();
      if (res.ok) {
        toast(`已记录 ${res.count} 个命令`);
        if (note) note.textContent = `安装完成：${res.count} 个命令已接管，日志在 ${res.logPath}`;
      } else {
        toast(`安装失败：${res.error || ''}`);
        if (note) note.textContent = `安装失败：${res.error || '未知错误'}`;
      }
    } finally {
      btn.disabled = false;
      await refreshWatchStatus();
    }
  });

  $('btnSbxRunCmdInline')?.addEventListener('click', async () => {
    const input = $('sbxCmdInput');
    const btn = $('btnSbxRunCmdInline');
    const cmd = (input && input.value || '').trim();
    if (!cmd) return;
    btn.disabled = true;
    try {
      await deck.sandboxExec({ command: cmd, origin: '手动执行' });
      await loadCommands();
    } finally {
      btn.disabled = false;
    }
  });

  $('sbxCmdInput')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('btnSbxRunCmdInline')?.click();
  });

  $('btnSbxClearCmds')?.addEventListener('click', () => renderCommands({ entries: [] }));

  $('btnSbxRunAgent')?.addEventListener('click', async () => {
    const sel = $('sbxAgentSelect');
    const input = $('sbxAgentPrompt');
    const btn = $('btnSbxRunAgent');
    const agent = sel ? sel.value : 'claude';
    const prompt = (input && input.value || '').trim();
    if (!prompt) return;
    btn.disabled = true;
    btn.textContent = '运行中…';
    try {
      const res = await deck.sandboxRunAgent({ agent, prompt });
      if (res && res.ok) toast(`${agent} 已在沙盒中执行`);
      else toast(`失败：${(res && res.error) || '未知错误'}`);
      await loadCommands();
    } finally {
      btn.disabled = false;
      btn.textContent = '在沙盒中运行 agent';
    }
  });

  $('btnSbxOpenCmdLog')?.addEventListener('click', async () => {
    const r = await deck.sandboxOpenLog().catch((e) => ({ ok: false, error: String(e) }));
    if (r && r.ok) toast('已打开审计文件');
    else toast((r && r.error) || '打开失败');
  });

  // ── customisation ──────────────────────────────────────────────────────
  /**
   * Show the built-in guide in a panel, rather than opening a file in another app.
   *
   * The requirement was that the documentation be built in, so it is rendered here
   * and stays inside the window.
   */
  $('btnCustomizeGuide')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const body = $('customizeBody');
    if (body) body.innerHTML = '<div class="env-empty">正在读取…</div>';
    try {
      const guide = await deck.customizeGuide();
      if (!body) return;
      if (!guide.ok) {
        body.innerHTML = `<div class="env-empty">读取失败：${escapeHtml(guide.error || '')}</div>`;
        return;
      }
      body.innerHTML = `<pre class="sbx-doc">${escapeHtml(guide.text)}</pre>`;
    } finally {
      btn.disabled = false;
    }
  });

  $('btnCustomizeRender')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const body = $('customizeBody');
    if (body) body.innerHTML = '<div class="env-empty">正在生成…</div>';
    try {
      const t = await deck.customizeTemplate({});
      if (!body) return;
      if (!t.ok) {
        body.innerHTML = `<div class="env-empty">生成失败：${escapeHtml(t.error || '')}</div>`;
        return;
      }
      body.innerHTML = (t.rendered || []).map((r) => {
        const content = r.json
          ? JSON.stringify(r.json, null, 2)
          : (r.toml || (r.skill ? `${r.skill.dir}\n\n${r.skill.snippet}` : ''));
        // Only the target this app owns gets a write button. The rest are text to
        // place by hand, and offering a button that cannot work would be a lie.
        const canApply = r.target === 'claude';
        // Collapsed by default: four open code blocks is a wall of text that pushes
        // everything else off the page, and the detail is only wanted for the one
        // target being edited.
        return `
          <details class="sbx-target">
            <summary class="sbx-target-head">
              <strong>${escapeHtml(r.label)}</strong>
              ${canApply
                ? `<button class="set-btn sbx-btn-sm sbx-apply" data-target="${escapeHtml(r.target)}" type="button">写入</button>`
                : '<span class="sbx-manual">手动放置</span>'}
              <code class="sbx-target-path">${escapeHtml(r.file)}</code>
            </summary>
            <div class="sbx-target-body">
              <p class="sbx-target-note">${escapeHtml(r.note || '')}</p>
              <pre class="sandbox-out">${escapeHtml(content)}</pre>
            </div>
          </details>`;
      }).join('');

      for (const b of body.querySelectorAll('.sbx-apply')) {
        b.addEventListener('click', async () => {
          const target = b.dataset.target;
          b.disabled = true;
          try {
            const res = await deck.customizeApply({ target });
            if (res.ok) toast(`已写入 ${res.file}`);
            else if (res.manual) toast('这个目标需要手动放置');
            else toast(`失败：${res.error || ''}`);
          } finally {
            b.disabled = false;
          }
        });
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('btnSbxHealth')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const section = $('sbxHealthSection');
    const out = $('sbxHealthOut');
    if (out) out.textContent = '正在运行 sbx diagnose…';
    if (section) section.hidden = false;
    try {
      const health = await deck.sandboxHostHealth();
      if (out) out.textContent = health && health.text ? health.text : (health.error || '无输出');
    } catch (e) {
      if (out) out.textContent = `失败：${String(e)}`;
    } finally {
      btn.disabled = false;
    }
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
    if (GUEST_PANELS.includes(activePanel)) await restartGuest(activePanel);
    else await deck.reloadAgent();
    setTimeout(() => ev.currentTarget.classList.remove('is-spinning'), 900);
  });

  $('btnRestart').addEventListener('click', async (ev) => {
    ev.currentTarget.classList.add('is-spinning');
    if (GUEST_PANELS.includes(activePanel)) await restartGuest(activePanel);
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
    await loadProvider();

    // Always open on Home. Restoring into a panel would start work the user did
    // not ask for: the terminal would spawn a PTY, OpenChamber may still be
    // booting (an empty black panel), and a guest would launch as its own window
    // for a moment before it is adopted — which is exactly the flash of a
    // separate window seen at startup.
    showPanel('home');
    reportContentBounds();
  });
})();
