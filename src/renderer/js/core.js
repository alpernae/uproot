'use strict';

/* Shared state, helpers and DOM utilities for the renderer. */
window.UI = (function () {
  const api = window.api;

  const state = {
    info: null,
    settings: null,
    apps: [],
    errors: [],
    counts: null,
    appsLoadedAt: 0,
    selectedId: null,
    filteredIds: [],
    currentView: 'apps',
    progressOpen: false,
    animateList: false,
    theme: { source: 'system', resolved: 'dark' },
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---------------------------------------------------------------- theme
  const THEME_ICON = { dark: 'i-moon', light: 'i-sun', system: 'i-auto' };
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function mediaTheme() {
    return themeMedia && themeMedia.matches ? 'dark' : 'light';
  }

  // Applied synchronously at parse time: the main process has already set
  // nativeTheme.themeSource before the window was created, so prefers-color-scheme
  // is authoritative here and there is no flash of the wrong theme.
  function applyTheme(resolved) {
    const next = resolved === 'light' ? 'light' : 'dark';
    if (document.documentElement.dataset.theme !== next) {
      document.documentElement.dataset.theme = next;
    }
  }

  function syncThemeControls() {
    const t = state.theme || { source: 'system', resolved: mediaTheme() };
    const btn = $('#theme-toggle');
    if (btn) {
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', '#' + (THEME_ICON[t.source] || 'i-auto'));
      const current = { dark: 'Dark', light: 'Light', system: 'System' }[t.source] || 'System';
      const next = { dark: 'light', light: 'system', system: 'dark' }[t.source] || 'light';
      btn.title = `Theme: ${current} — click to switch to ${next}`;
      btn.dataset.source = t.source;
    }
    $$('input[name="theme-mode"]').forEach((el) => {
      el.checked = el.value === t.source;
    });
  }

  async function setTheme(source) {
    const s = ['dark', 'light', 'system'].includes(source) ? source : 'system';
    state.theme = { source: s, resolved: s === 'system' ? mediaTheme() : s };
    applyTheme(state.theme.resolved);
    syncThemeControls();
    if (s === 'system') {
      // Main re-resolves after themeSource flips and will broadcast the truth;
      // re-apply shortly after in case the media query lags a frame.
      setTimeout(() => {
        state.theme = { source: 'system', resolved: mediaTheme() };
        applyTheme(state.theme.resolved);
        syncThemeControls();
      }, 60);
    }
    await saveSettings({ theme: s });
  }

  function cycleTheme() {
    const order = ['dark', 'light', 'system'];
    const current = (state.theme && state.theme.source) || 'system';
    return setTheme(order[(order.indexOf(current) + 1) % order.length]);
  }

  applyTheme(mediaTheme());
  if (themeMedia && themeMedia.addEventListener) {
    themeMedia.addEventListener('change', () => {
      if (!state.theme || state.theme.source === 'system') {
        state.theme = { source: 'system', resolved: mediaTheme() };
        applyTheme(state.theme.resolved);
        syncThemeControls();
      }
    });
  }

  // ------------------------------------------------------- search helpers
  function tokenize(query) {
    return String(query == null ? '' : query)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
  }

  function fieldsOf(app) {
    return {
      name: String(app.name || ''),
      publisher: app.publisher || '',
      version: app.version || '',
      id: [app.wingetId, app.appId].filter(Boolean).join(' '),
      path: [app.installLocation, app.keyName].filter(Boolean).join(' '),
      env: [app.architecture, app.scope].filter(Boolean).join(' '),
    };
  }

  // Every token must match somewhere; the highest-signal field wins for ranking.
  function matchScore(app, tokens) {
    if (!tokens.length) return 1;
    const f = fieldsOf(app);
    const name = f.name.toLowerCase();
    const words = name.split(/[^a-z0-9]+/).filter(Boolean);
    const publisher = f.publisher.toLowerCase();
    const id = f.id.toLowerCase();
    const path = f.path.toLowerCase();
    const env = f.env.toLowerCase();
    let total = 0;
    for (const t of tokens) {
      let s = 0;
      if (name === t) s = 1200;
      else if (name.startsWith(t)) s = 900;
      else if (words.some((w) => w.startsWith(t))) s = 640;
      else if (name.includes(t)) s = 420;
      else if (id.includes(t)) s = 260;
      else if (publisher.includes(t)) s = 220;
      else if (path.includes(t)) s = 140;
      else if (env.includes(t)) s = 80;
      if (!s) return 0;
      total += s;
    }
    return total;
  }

  // When the match came from a field other than the name, surface that field so
  // the user understands why the row is in the results.
  function matchHint(app, tokens) {
    if (!tokens.length) return null;
    const f = fieldsOf(app);
    const name = f.name.toLowerCase();
    if (tokens.every((t) => name.includes(t))) return null;
    const candidates = [
      ['Publisher', f.publisher],
      ['Version', f.version],
      ['Winget id', f.id],
      ['Install path', f.path],
      ['Architecture', f.env],
    ];
    for (const [label, value] of candidates) {
      if (!value) continue;
      const v = String(value).toLowerCase();
      if (tokens.some((t) => v.includes(t))) return { label, value: String(value) };
    }
    return null;
  }

  // Escapes the text and wraps case-insensitive token hits in <mark class="hl">.
  function highlight(raw, tokens) {
    const src = String(raw == null ? '' : raw);
    if (!tokens || !tokens.length) return esc(src);
    const ranges = [];
    for (const t of tokens) {
      if (!t) continue;
      const re = new RegExp(escapeRe(t), 'gi');
      let m;
      while ((m = re.exec(src)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
    if (!ranges.length) return esc(src);
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    let out = '';
    let pos = 0;
    for (const [s, e] of merged) {
      out += esc(src.slice(pos, s)) + '<mark class="hl">' + esc(src.slice(s, e)) + '</mark>';
      pos = e;
    }
    return out + esc(src.slice(pos));
  }

  function isPathish(key, value) {
    const v = String(value == null ? '' : value);
    if (/^(Install location|Uninstall command|Silent command|Registry key|Icon|Package)/i.test(key)) return true;
    return /[\\/]/.test(v) || /^[A-Za-z]:/.test(v) || /^HK(LM|CU|EY|CR)/i.test(v) || /\.(exe|dll|ico|lnk|sys)$/i.test(v);
  }

  function copyBtn(value, label) {
    const v = value == null ? '' : String(value);
    if (!v) return '';
    return (
      `<button type="button" class="copy" data-copy="${esc(v)}" title="Copy ${esc(label || 'value')}" aria-label="Copy ${esc(label || 'value')}">` +
      `<svg class="ico"><use href="#i-copy"></use></svg></button>`
    );
  }

  async function writeClipboard(text) {
    const value = text == null ? '' : String(text);
    try {
      const res = await api.clipboard.writeText(value);
      if (res && res.ok) return toast('Copied to clipboard', 'ok', 1600);
    } catch {
      /* fall through */
    }
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied to clipboard', 'ok', 1600);
    } catch {
      toast('Could not copy to clipboard', 'err');
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    writeClipboard(btn.dataset.copy);
  });

  function fmtSize(kb) {
    const n = Number(kb);
    if (!n || n <= 0) return '';
    const mb = n / 1024;
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.round(n) + ' KB';
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!n || n <= 0) return '';
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function confClass(confidence) {
    return confidence === 'high' ? 'high' : confidence === 'medium' ? 'medium' : 'low';
  }

  function confLabel(confidence) {
    return confidence === 'high' ? 'MATCH' : confidence === 'medium' ? 'PROBABLE' : 'REVIEW';
  }

  function appIndexOf(app) {
    return state.apps.findIndex((a) => a.id === app.id);
  }

  // ---------------------------------------------------------------- toasts
  const TOAST_ICONS = { ok: 'i-check', err: 'i-x', warn: 'i-warn', info: 'i-info' };

  function toast(message, type = 'info', ms = 4200) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<svg class="ico"><use href="#${TOAST_ICONS[type] || 'i-info'}"></use></svg><span class="txt"></span>`;
    $('.txt', el).textContent = message;
    root.appendChild(el);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 320);
    };
    el.addEventListener('click', dismiss);
    setTimeout(dismiss, ms);
  }

  // ------------------------------------------------------------- skeletons
  function skeletonList(rows = 8) {
    return Array.from({ length: rows })
      .map(
        () => `<li class="sk-row"><span class="sk-ico skeleton"></span>
          <span class="sk-col"><span class="sk-line skeleton w60"></span><span class="sk-line skeleton w35"></span></span></li>`,
      )
      .join('');
  }

  function skeletonTable(rows = 5, cols = 5) {
    return Array.from({ length: rows })
      .map(
        (_, r) => `<div class="sk-row">${Array.from({ length: cols })
          .map(() => `<span class="sk-line skeleton" style="flex:1;animation-delay:${r * 40}ms"></span>`)
          .join('')}</div>`,
      )
      .join('');
  }

  // ------------------------------------------------------------- progress
  let progressState = { open: false, label: 'Working…' };

  function setProgress(label, fraction) {
    progressState = { open: true, label };
    const bar = $('#progress-bar');
    bar.classList.remove('hidden');
    const fill = $('.progress-fill', bar);
    fill.style.width = `${Math.round((fraction == null ? 1 : fraction) * 100)}%`;
    fill.title = label;
  }

  function clearProgress() {
    progressState = { open: false };
    $('#progress-bar').classList.add('hidden');
  }

  api.onProgress((event) => {
    const phase = event.phase || '';
    if (event.message) {
      if (phase === 'apps' || phase === 'footprint' || phase === 'leftovers' || phase === 'runtimes' || phase === 'clean') {
        setProgress(event.message);
      }
      return;
    }
    // Step events from the uninstaller.
    const status = event.status;
    if (status === 'running') {
      const verbs = { 'stop-processes': 'Closing running processes…', uninstall: 'Running the uninstaller…', verify: 'Verifying removal…', leftovers: 'Scanning for leftovers…', clean: 'Cleaning up…' };
      setProgress(verbs[event.id] || 'Working…');
    }
    if (status === 'done' || status === 'error' || status === 'warning') {
      if (event.id === 'verify') clearProgress();
    }

    if (typeof window.__wizardProgress === 'function') window.__wizardProgress(event);
  });

  // ---------------------------------------------------------------- modals
  function modal(html, opts = {}) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" data-backdrop>
        <div class="modal ${opts.wide ? 'wide' : ''}" role="dialog">
          <div class="modal-head">
            <h3 class="modal-title">${opts.title ? esc(opts.title) : ''}</h3>
            <button class="modal-x" data-close aria-label="Close"><svg class="ico"><use href="#i-x"></use></svg></button>
          </div>
          <div class="modal-body">${html}</div>
        </div>
      </div>`;
    const backdrop = $('[data-backdrop]', root);
    const close = () => {
      root.innerHTML = '';
      if (opts.onClose) opts.onClose();
    };
    $('[data-close]', backdrop).onclick = close;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && !opts.static) close();
    });
    return { close, backdrop };
  }

  function closeModal() {
    $('#modal-root').innerHTML = '';
  }

  function confirmDialog({ title = 'Confirm', body = '', confirmLabel = 'Continue', danger = false, staticBackdrop = true }) {
    return new Promise((resolve) => {
      const m = modal(
        `<div class="stack gap">
           <p>${body}</p>
           <div class="row end modal-actions">
             <button class="btn" data-cancel>Cancel</button>
             <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirmLabel)}</button>
           </div>
         </div>`,
        { title, static: staticBackdrop },
      );
      $('[data-cancel]', m.backdrop).onclick = () => { m.close(); resolve(false); };
      $('[data-ok]', m.backdrop).onclick = () => { m.close(); resolve(true); };
    });
  }

  // -------------------------------------------------------------- icons
  // Icons are the expensive part of a long list: every one is an IPC round trip
  // that makes the main process stat the install folder and ask the shell to
  // extract an image. Resolve them lazily as rows scroll into view, dedupe
  // concurrent requests, and remember the result so re-renders stay instant.
  const iconCache = new Map();
  const iconInflight = new Map();

  function paintIcon(el, key, name, url) {
    if (url) el.src = url;
    else if (!el.getAttribute('src')) el.src = monogram(name, key);
  }

  function loadIcon(el) {
    const meta = el.__icon;
    if (!meta) return;
    if (iconCache.has(meta.key)) {
      paintIcon(el, meta.key, meta.name, iconCache.get(meta.key));
      return;
    }
    let pending = iconInflight.get(meta.key);
    if (!pending) {
      pending = (async () => {
        let url = null;
        try {
          const res = await api.icon.get(meta.payload);
          url = res && res.ok ? res.data : null;
        } catch {
          url = null;
        }
        iconCache.set(meta.key, url);
        iconInflight.delete(meta.key);
        return url;
      })();
      iconInflight.set(meta.key, pending);
    }
    pending.then((url) => paintIcon(el, meta.key, meta.name, url));
  }

  // Resolve icons only as rows approach the viewport, preloading a little ahead
  // so the list never looks empty while scrolling.
  const iconTargets = new Set();
  const iconObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries, obs) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              obs.unobserve(entry.target);
              iconTargets.delete(entry.target);
              loadIcon(entry.target);
            }
          },
          { rootMargin: '320px 0px' },
        )
      : null;

  function iconInto(imgEl, payload) {
    if (!imgEl) return;
    const key = payload.appId || payload.iconPath || payload.installLocation || payload.name || 'unknown';
    imgEl.__icon = { key, name: payload.name, payload };
    if (iconCache.has(key) || !iconObserver) {
      loadIcon(imgEl);
      return;
    }
    iconObserver.observe(imgEl);
    iconTargets.add(imgEl);
  }

  // Forget rows that have been removed from the document so the observer does
  // not accumulate detached elements; live targets (e.g. the detail icon) keep
  // waiting for their turn. Call after replacing list markup.
  function iconReset() {
    if (!iconObserver) return;
    for (const el of iconTargets) {
      if (!el.isConnected) {
        iconObserver.unobserve(el);
        iconTargets.delete(el);
      }
    }
  }

  function clearIconCache() {
    iconCache.clear();
    iconInflight.clear();
  }

  // Deterministic letter tile for apps that expose no extractable icon. Kept
  // neutral (no hue) so it never competes with the single accent, and mid-dark
  // so it reads on both the dark and light surfaces without re-rendering.
  const monogram = (name) => {
    const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
    const safe = initial.replace(/[<>&"']/g, '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="hsl(220 13% 36%)"/>` +
      `<stop offset="1" stop-color="hsl(220 13% 29%)"/>` +
      `</linearGradient></defs>` +
      `<rect width="64" height="64" rx="14" fill="url(#g)"/>` +
      `<text x="32" y="34" font-family="Segoe UI Variable, Segoe UI, sans-serif" font-size="27" font-weight="600" ` +
      `fill="hsl(220 16% 88%)" text-anchor="middle" dominant-baseline="central">${safe}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };

  // ------------------------------------------------------------ settings
  async function loadSettings() {
    const res = await api.settings.get();
    state.settings = res.ok ? res.data : {};
    return state.settings;
  }

  async function saveSettings(patch) {
    const res = await api.settings.set(patch);
    if (res.ok) state.settings = res.data;
    return res.ok;
  }

  // --------------------------------------------------------------- apps
  async function loadApps(force = false) {
    const res = await api.apps.list({ force: Boolean(force) });
    if (res.ok) {
      state.apps = res.data.apps || [];
      state.errors = res.data.errors || [];
      state.counts = res.data.counts || null;
    } else {
      state.apps = [];
      state.errors = [res.error];
    }
    state.appsLoadedAt = Date.now();
    return state.apps;
  }

  async function ensureApps(force = false) {
    if (!state.apps.length || force) await loadApps(force);
    return state.apps;
  }

  function findApp(id) {
    return state.apps.find((a) => a.id === id) || null;
  }

  function refreshListData() {
    // Selective replacement for cached icons/detail windows.
    for (const a of state.apps) {
      const row = document.querySelector(`[data-app-id="${CSS.escape(a.id)}"]`);
      if (row) updateListRow(row, a);
    }
  }

  function updateListRow(row, app) {
    const title = $('.list-title', row);
    const sub = $('.list-sub', row);
    if (title) title.textContent = app.name;
    if (sub) sub.textContent = [app.publisher, app.version].filter(Boolean).join(' · ');
    const size = $('.size-tag', row);
    if (size) size.textContent = fmtSize(app.estimatedSizeKb);
  }

  return {
    $,
    $$,
    esc,
    fmtSize,
    fmtBytes,
    fmtDate,
    confClass,
    confLabel,
    state,
    api,
    toast,
    modal,
    closeModal,
    confirmDialog,
    setProgress,
    clearProgress,
    progressState,
    skeletonList,
    skeletonTable,
    iconInto,
    iconReset,
    clearIconCache,
    loadSettings,
    saveSettings,
    loadApps,
    ensureApps,
    findApp,
    refreshListData,
    updateListRow,
    // theme
    applyTheme,
    syncThemeControls,
    setTheme,
    cycleTheme,
    mediaTheme,
    THEME_ICON,
    // search + paths
    tokenize,
    matchScore,
    matchHint,
    highlight,
    copyBtn,
    isPathish,
    writeClipboard,
  };
})();