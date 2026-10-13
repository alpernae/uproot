'use strict';

/* Renderer bootstrap: boot sequence, navigation, search, refresh, and per-view wiring. */
(function () {
  const U = window.UI;
  const { $, $$, state } = U;
  const Views = U.Views;

  const VIEW_META = {
    apps: ['Applications', 'Installed programs discovered from the registry, winget and the Store.'],
    leftovers: ['Leftovers', 'Residue, orphaned folders and shared dependency traces.'],
    runtimes: ['Shared runtimes', 'Redistributables and which applications still depend on them.'],
    quarantine: ['Quarantine', 'Undo removal — files are held here and registry keys are backed up.'],
    history: ['History', 'Every uninstall and cleanup this tool has performed.'],
    log: ['Activity log', 'Diagnostics written by the main process.'],
    settings: ['Settings', 'Scanning behaviour and the safety defaults used by the uninstall wizard.'],
  };

  const viewRenderers = {
    apps() {
      Views.renderAppsList();
      if (state.selectedId) {
        const app = U.findApp(state.selectedId);
        if (app) Views.renderDetail(state.selectedId, { keepList: true });
      }
    },
    leftovers() {
      Views.renderLeftovers();
    },
    runtimes() {
      Views.renderRuntimes(false);
    },
    quarantine() {
      Views.renderQuarantine();
    },
    history() {
      Views.renderHistory();
    },
    log() {
      Views.renderLog();
    },
    settings() {
      Views.renderSettings();
    },
  };

  function switchView(name) {
    state.currentView = name;
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    $$('#view > section').forEach((s) => s.classList.add('hidden'));
    const section = $(`#${name}-view`);
    if (section) section.classList.remove('hidden');

    const meta = VIEW_META[name];
    const title = $('#view-title');
    const sub = $('#view-sub');
    if (meta && title) title.textContent = meta[0];
    if (meta && sub) sub.textContent = meta[1];

    if (name === 'apps') state.animateList = true;
    const render = viewRenderers[name];
    if (render) render();
  }

  // ------------------------------------------------------------- wiring

  function wireNav() {
    $$('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  function selectApp(id) {
    const app = U.findApp(id);
    if (!app) return;
    Views.renderDetail(id, { keepList: true });
    const li = document.querySelector(`#apps-list .list-item[data-app-id="${CSS.escape(id)}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  }

  function moveSelection(dir) {
    const ids = state.filteredIds || [];
    if (!ids.length) return;
    let i = ids.indexOf(state.selectedId);
    if (i < 0) i = dir > 0 ? -1 : ids.length;
    const next = Math.min(ids.length - 1, Math.max(0, i + dir));
    if (next === i) return;
    selectApp(ids[next]);
  }

  function wireAppList() {
    const search = $('#search-input');
    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => Views.renderAppsList(), 120);
    });
    // Fired by the native clear (×) affordance on <input type="search">.
    search.addEventListener('search', () => Views.renderAppsList());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const first = (state.filteredIds || [])[0];
        if (first) selectApp(first);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        search.value = '';
        Views.renderAppsList();
      }
    });

    $('#show-hidden').addEventListener('change', () => Views.renderAppsList());
    $('#apps-list').addEventListener('click', (e) => {
      const li = e.target.closest('[data-app-id]');
      if (!li) return;
      const app = U.findApp(li.dataset.appId);
      if (!app) {
        U.toast('Application no longer in the list — refresh.', 'warn');
        return;
      }
      Views.renderDetail(app.id, { keepList: true });
    });
    $('#refresh-btn').addEventListener('click', async () => {
      U.setProgress('Refreshing installed applications…');
      try {
        await U.loadApps(true);
        U.clearIconCache();
        U.clearProgress();
        state.animateList = true;
        Views.refresh();
        U.toast(`Loaded ${state.apps.length} applications.`, 'ok');
      } catch (e) {
        U.clearProgress();
        U.toast('Refresh failed: ' + (e && e.message ? e.message : e), 'err');
      }
    });

    // Ctrl/Cmd+F (or /) jumps to the application search from anywhere.
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (state.currentView !== 'apps') switchView('apps');
        search.focus();
        search.select();
        return;
      }
      if (e.key === '/' && !isEditable(e.target)) {
        e.preventDefault();
        if (state.currentView !== 'apps') switchView('apps');
        search.focus();
      }
    });
  }

  function wireTheme() {
    const btn = $('#theme-toggle');
    if (btn) btn.addEventListener('click', () => U.cycleTheme());
  }

  function wireLeftovers() {
    const run = () => {
      const name = $('#lo-name').value.trim();
      const install = $('#lo-install').value.trim();
      if (name.length < 2) {
        U.toast('Enter at least two characters to search for.', 'warn');
        return;
      }
      Views.renderLoResults({ name, publisher: '', installLocation: install });
    };
    $('#lo-scan').addEventListener('click', run);
    $('#lo-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
    $('#lo-install').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
    $('#orphan-scan').addEventListener('click', () => Views.renderLeftovers());
  }

  function wireRuntimes() {
    $('#runtimes-scan').addEventListener('click', () => Views.renderRuntimes(true));
    $('#runtimes-results').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-run-uninstall]');
      if (!btn) return;
      const app = U.findApp(btn.dataset.runUninstall);
      if (!app) {
        U.toast('No registered uninstall command for that runtime.', 'warn');
        return;
      }
      U.Wizard.start(app);
    });
  }

  function wireLog() {
    $('#log-refresh').addEventListener('click', () => Views.renderLog());
  }

  // ------------------------------------------------------------- boot
  function applyAdminBadge(info) {
    if (!info) return;
    const badge = $('#admin-badge');
    if (!badge) return;
    if (info.isAdmin) {
      badge.textContent = 'Administrator';
      badge.title = 'Running with administrator rights.';
      badge.classList.add('admin');
    } else {
      badge.textContent = 'Standard rights';
      badge.title = 'Not elevated — each machine-wide operation raises a UAC prompt on demand.';
      badge.classList.add('standard');
    }
    badge.classList.remove('hidden');
  }

  async function boot() {
    // The elevation probe spawns PowerShell and can take a moment, so run it
    // off the critical path: the application list should appear as soon as it
    // is read, not after the badge has resolved.
    const infoPromise = U.api.app
      .info()
      .then((res) => {
        if (res && res.ok) state.info = res.data;
        return state.info;
      })
      .catch((e) => {
        console.error('app.info failed', e);
        return null;
      });

    await U.loadSettings();

    // Theme: nativeTheme is applied in the main process before the window
    // exists, so prefers-color-scheme already reflects the real theme. Apply it
    // now and let the probe confirm/correct it a moment later.
    state.theme = {
      source: (state.settings && state.settings.theme) || 'system',
      resolved: U.mediaTheme(),
    };
    U.applyTheme(state.theme.resolved);
    U.syncThemeControls();
    if (U.api.theme && U.api.theme.on) {
      U.api.theme.on((payload) => {
        if (!payload) return;
        state.theme = { source: payload.source || 'system', resolved: payload.resolved || U.mediaTheme() };
        U.applyTheme(state.theme.resolved);
        U.syncThemeControls();
      });
    }

    wireNav();
    wireAppList();
    wireTheme();
    wireLeftovers();
    wireRuntimes();
    wireLog();

    U.setProgress('Reading installed applications…');
    const appsList = $('#apps-list');
    if (appsList) appsList.innerHTML = U.skeletonList(9);
    try {
      await U.ensureApps(true);
    } finally {
      U.clearProgress();
    }
    if (state.errors.length) {
      U.toast(`Some sources reported errors — ${state.errors.length} (see Log).`, 'warn', 6000);
    }

    switchView('apps');

    // Fill in the authoritative theme and the elevation badge once the probe
    // resolves — they are informational and must not delay the first paint.
    const info = await infoPromise;
    if (info) {
      state.theme = {
        source: info.themeSource || state.theme.source,
        resolved: info.resolvedTheme || U.mediaTheme(),
      };
      U.applyTheme(state.theme.resolved);
      U.syncThemeControls();
      applyAdminBadge(info);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => {
      console.error('Boot failed', e);
      const root = $('#apps-list');
      if (root) root.innerHTML = `<li class="empty">Failed to start: ${U.esc(e && e.message ? e.message : e)}</li>`;
    });
  });
})();