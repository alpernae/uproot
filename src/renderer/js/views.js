'use strict';

/* View rendering for the renderer. Depends on UI core. */
(function () {
  const U = window.UI;
  const { $, $$, esc, fmtSize, fmtBytes, fmtDate, confClass, confLabel, state } = U;

  const Views = {};

  const METHOD_LABELS = {
    'msi-silent': 'Windows Installer (silent)',
    'vendor-quiet': "Vendor's silent uninstaller",
    'vendor-interactive': "Vendor's uninstall wizard",
    winget: 'Windows Package Manager (winget)',
    appx: 'Store / MSIX package',
    url: 'Protocol handler uninstaller',
  };

  // =====================================================================
  // Apps list
  // =====================================================================

  Views.renderAppsList = function () {
    const listEl = $('#apps-list');
    if (!listEl) return;

    const countEl = $('#apps-count');

    if (!state.apps.length && !state.appsLoadedAt) {
      listEl.classList.add('no-anim');
      listEl.dataset.renderKey = '';
      listEl.innerHTML = U.skeletonList(9);
      U.iconReset();
      if (countEl) countEl.textContent = 'Loading…';
      return;
    }

    const query = ($('#search-input').value || '').trim();
    const tokens = U.tokenize(query);
    const hideHidden = !$('#show-hidden').checked;

    let apps = state.apps;
    if (hideHidden) {
      apps = apps.filter(
        (a) => !a.isSystemComponent && !a.isSystemPackage && !a.isUpdate && !a.nonRemovable && !a.isFramework,
      );
    }

    if (tokens.length) {
      const scored = [];
      for (const a of apps) {
        const score = U.matchScore(a, tokens);
        if (score > 0) scored.push({ a, score });
      }
      scored.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name, undefined, { sensitivity: 'base' }));
      apps = scored.map((x) => x.a);
    } else {
      apps = apps.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    state.filteredIds = apps.map((a) => a.id);

    if (countEl) {
      countEl.textContent =
        apps.length === state.apps.length ? `${apps.length} applications` : `${apps.length} of ${state.apps.length}`;
    }

    // Cheap identity for the current result set. When nothing that affects the
    // list has changed, leave the DOM untouched so scroll position and already
    // resolved icons survive (selection, view switches, re-focus).
    const key = `${query}\u0000${hideHidden ? 1 : 0}\u0000${state.appsLoadedAt}\u0000${apps.length}`;
    if (listEl.dataset.renderKey === key && listEl.childElementCount) {
      state.animateList = false;
      return;
    }
    listEl.dataset.renderKey = key;

    const animate = state.animateList;
    state.animateList = false;
    listEl.classList.toggle('no-anim', !animate);

    if (!apps.length) {
      listEl.innerHTML = tokens.length
        ? `<li class="empty">No applications match “<b>${esc(query)}</b>”.<br/><span class="small">Try fewer words, or turn on <b>System packages</b>.</span></li>`
        : '<li class="empty">No applications to show. Turn on <b>System packages</b> or refresh.</li>';
      U.iconReset();
      return;
    }

    const byId = new Map(apps.map((a) => [a.id, a]));
    listEl.innerHTML = apps
      .map((a, i) => {
        const hint = tokens.length ? U.matchHint(a, tokens) : null;
        const sub = hint
          ? `${esc(hint.label)}: ${U.highlight(hint.value, tokens)}`
          : U.highlight([a.publisher, a.version].filter(Boolean).join(' · '), tokens);
        return `
      <li class="list-item ${a.id === state.selectedId ? 'active' : ''}" data-app-id="${esc(a.id)}" style="--i:${Math.min(i, 24)}">
        <img class="list-ico" alt="" />
        <div class="list-main">
          <div class="list-title">${U.highlight(a.name, tokens)}</div>
          <div class="list-sub">${sub}</div>
        </div>
        ${fmtSize(a.estimatedSizeKb) ? `<span class="size-tag">${fmtSize(a.estimatedSizeKb)}</span>` : ''}
        ${a.needsAdmin ? '<span class="badge machine" title="Requires administrator rights">admin</span>' : ''}
        ${
          a.isSystemComponent || a.isSystemPackage
            ? '<span class="badge sys" title="Windows component or framework package">system</span>'
            : ''
        }
      </li>`;
      })
      .join('');

    U.iconReset();
    for (const li of $$('.list-item[data-app-id]', listEl)) {
      const app = byId.get(li.dataset.appId);
      if (app) {
        U.iconInto($('img', li), {
          appId: app.id,
          iconPath: app.iconPath,
          installLocation: app.installLocation,
          name: app.name,
        });
      }
    }
  };

  // =====================================================================
  // Detail pane
  // =====================================================================

  function badgesFor(app) {
    const out = [];
    if (app.scope === 'machine') out.push('<span class="badge machine">machine-wide</span>');
    else if (app.scope === 'appx') out.push('<span class="badge appx">store</span>');
    else out.push('<span class="badge user">per-user</span>');
    if (app.sources.length > 1) out.push(`<span class="badge winget">${app.sources.join(' + ')}</span>`);
    if (app.needsAdmin) out.push('<span class="badge machine" title="Uninstall requires elevation">admin required</span>');
    if (app.isFramework) out.push('<span class="badge sys">framework package</span>');
    if (app.nonRemovable) out.push('<span class="badge sys">non-removable</span>');
    return out.join(' ');
  }

  Views.renderDetail = function (appId, opts) {
    const pane = $('#detail-pane');
    const app = state.apps.find((a) => a.id === appId) || U.findApp(appId);
    if (!app) {
      pane.innerHTML = `<div class="empty-state"><span class="empty-ico"><svg class="ico"><use href="#i-apps"></use></svg></span><h3>Application not found</h3><p>It may have been removed already. Refresh the list and pick another.</p></div>`;
      return;
    }
    state.selectedId = appId;
    // Full rebuild keeps icons/order fresh; arrow-key navigation uses the light
    // path so the list scroll position is preserved while moving the highlight.
    if (opts && opts.keepList) Views.setActive(appId);
    else Views.renderAppsList();

    const reg = app.registry && app.registry[0];
    const info = [
      ['Publisher', app.publisher],
      ['Version', app.version],
      ['Installed', app.installDate],
      ['Size on disk', fmtSize(app.estimatedSizeKb)],
      ['Install location', app.installLocation],
      ['Uninstall command', reg && reg.uninstallString],
      ['Silent command', reg && reg.quietUninstallString],
      ['Source', `${app.sources.join(', ')} (registry=${app.registry.length}, winget=${app.winget.length}, appx=${app.appx.length})`],
    ];

    let warnings = '';
    if (app.nonRemovable) {
      warnings += `<div class="err-block">This package is marked non-removable by Windows. Removal may fail or leave the Store in an inconsistent state.</div>`;
    }
    if (app.isSystemComponent) {
      warnings += `<div class="warn-block">Windows marks this as a system component. Removing it can affect other software.</div>`;
    }

    pane.innerHTML = `
      <div class="detail">
        <div class="detail-head">
          <img class="detail-ico" alt="" />
          <div>
            <div class="detail-title">${esc(app.name)}</div>
            <div class="detail-sub">${badgesFor(app)}</div>
          </div>
          <div class="grow"></div>
          <button class="btn danger" data-action="uninstall"><svg class="ico"><use href="#i-trash"></use></svg>Uninstall…</button>
        </div>
        ${warnings}
        <dl class="kv">
          ${info
            .filter(([, value]) => value)
            .map(([k, value]) => {
              const full = String(value);
              const shown = full.length > 400 ? full.slice(0, 400) + '…' : full;
              const pathish = U.isPathish(k, full);
              const copy = pathish || full.length > 60 ? U.copyBtn(full, k) : '';
              const titleAttr = pathish || full.length > 60 ? ` title="${esc(full)}"` : '';
              return `<dt>${esc(k)}</dt><dd class="${pathish ? 'pathish' : ''}"${titleAttr}><span class="val">${esc(shown)}</span>${copy}</dd>`;
            })
            .join('')}
        </dl>

        <div class="row gap" style="margin-top:16px">
          <button class="btn" data-action="leftovers"><svg class="ico"><use href="#i-sparkle"></use></svg>Find leftovers</button>
          <button class="btn" data-action="footprint"><svg class="ico"><use href="#i-search"></use></svg>Inspect system footprint</button>
          ${app.installLocation ? `<button class="btn ghost" data-action="reveal"><svg class="ico"><use href="#i-folder"></use></svg>Reveal in Explorer</button>` : ''}
        </div>

        <div id="detail-analysis"></div>
      </div>`;

    const img = $('.detail-ico', pane);
    U.iconInto(img, {
      appId: app.id,
      iconPath: app.iconPath,
      installLocation: app.installLocation,
      name: app.name,
    });

    $('[data-action="uninstall"]', pane).onclick = () => U.Wizard.start(app);
    $('[data-action="leftovers"]', pane).onclick = () => U.Wizard.openLeftoversReview(app, true);
    $('[data-action="footprint"]', pane).onclick = () => loadFootprint(app);
    const reveal = $('[data-action="reveal"]', pane);
    if (reveal) reveal.onclick = () => U.api.shell.reveal({ target: app.installLocation });
  };

  async function loadFootprint(app) {
    const target = $('#detail-analysis');
    if (!target) return;
    target.innerHTML = '<p class="muted">Inspecting services, tasks, startup entries, shell extensions and registry references…</p>';
    const res = await U.api.apps.footprint(app.id, state.settings && state.settings.scanRegistryReferences !== false);
    if (!res.ok) {
      target.innerHTML = `<div class="err-block">${esc(res.error)}</div>`;
      return;
    }
    const findings = res.data.findings || [];
    target.innerHTML = `
      <div class="section-title">System footprint (${findings.length})</div>
      ${findings.length ? renderFindings(findings, { showCheckbox: false }) : '<div class="empty">Nothing found that clearly belongs to this application.</div>'}`;
  }

  function kindLabel(kind) {
    return {
      service: 'Windows service',
      task: 'Scheduled task',
      startup: 'Startup entry',
      shellex: 'Shell extension',
      'registry-reference': 'Registry reference',
    }[kind] || kind;
  }

  function renderFindings(findings, opts = {}) {
    if (!findings.length) return '<div class="empty">No findings.</div>';
    return findings
      .map((f, i) => {
        const conf = confClass(f.confidence);
        const path = String(f.path || f.regPath || f.name || f.target || '');
        const checkbox = opts.showCheckbox !== false
          ? `<label title="Include in cleanup"><input type="checkbox" data-find="${esc(f.id)}" ${f.checked ? 'checked' : ''} ${f.conflict ? 'disabled' : ''}/></label>`
          : '';
        return `
      <div class="finding" data-find-id="${esc(f.id)}" style="--i:${Math.min(i, 24)}">
        ${checkbox}
        <span class="conf ${conf}" title="confidence ${f.confidence}">${confLabel(f.confidence)}</span>
        <div class="body">
          <div class="path">${esc(path)}</div>
          <div class="meta">
            ${esc(kindLabel(f.kind || 'item'))}
            ${f.matchedOn ? ` · matched: ${esc(f.matchedOn)}` : ''}
            ${f.sizeKb ? ` · ${fmtSize(f.sizeKb)}` : ''}
          </div>
          ${f.conflict ? `<div class="conflict">Careful — this also matches another installed product: ${esc(f.conflict)}</div>` : ''}
          ${f.note ? `<div class="meta">${esc(f.note)}</div>` : ''}
        </div>
        ${U.copyBtn(path, 'path')}
        ${f.admin ? '<span class="badge machine">admin</span>' : ''}
      </div>`;
      })
      .join('');
  }

  // =====================================================================
  // Leftovers view
  // =====================================================================

  Views.renderLeftovers = function () {
    $('#orphan-list').classList.add('hidden');
    U.api.leftovers.orphaned().then((res) => {
      if (!res.ok) return;
      const folders = res.data.folders || [];
      const list = $('#orphan-list');
      if (!folders.length) {
        list.innerHTML = '<div class="empty">No orphaned folders detected in the standard locations.</div>';
      } else {
        list.innerHTML = folders
          .map(
            (f, i) =>
              `<div class="finding" style="--i:${Math.min(i, 24)}"><div class="body"><div class="path">${esc(f.path)}</div><div class="meta">${esc(f.origin)}${f.admin ? ' · admin' : ''}</div></div>${U.copyBtn(f.path, 'path')}</div>`,
          )
          .join('');
      }
      list.classList.remove('hidden');
    });
  };

  // Name-based leftover scan (Leftovers tab -> "Scan for leftovers").
  Views.renderLoResults = async function ({ name, publisher, installLocation }) {
    const target = $('#lo-results');
    target.classList.remove('hidden');
    target.innerHTML = `<div class="card">${U.skeletonTable(3, 2)}</div>`;
    const res = await U.api.leftovers.findByName(name, publisher, installLocation);
    if (!res.ok) {
      target.innerHTML = `<div class="err-block">${esc(res.error)}</div>`;
      return;
    }
    const data = res.data || {};
    const files = data.files || [];
    const registry = data.registry || [];
    target.innerHTML = `
      <div class="section-title">Scan results — ${esc(name)}</div>
      <div class="card">
        <div class="row between">
          <span class="row gap">
            <span class="badge info">${files.length} paths</span>
            <span class="badge info">${registry.length} registry keys</span>
          </span>
          <span class="row gap">
            <label class="check"><input type="radio" name="lo-mode" value="quarantine" checked/> Quarantine</label>
            <label class="check"><input type="radio" name="lo-mode" value="delete"/> Permanent delete</label>
          </span>
        </div>
        <div class="warn-block">Only select items you are sure about. Anything unverified or matching another product is left unchecked.</div>
      </div>
      ${files.length ? `<div class="section-title">Files & folders</div>` + loChecklist(files, 'file') : ''}
      ${registry.length ? `<div class="section-title">Registry keys</div>` + loChecklist(registry, 'registry') : ''}
      ${
        files.length || registry.length
          ? `<div class="row end"><button class="btn danger" id="lo-clean"><svg class="ico"><use href="#i-trash"></use></svg>Remove selected</button></div>`
          : `<div class="empty">Nothing found that clearly belongs to this name in the standard locations.</div>`
      }`;

    $$('input[data-lo-all]', target).forEach((el) => {
      el.onchange = () => {
        const kind = el.dataset.loAll;
        const card = el.closest('.card');
        $$('input[data-lo-check]', card).forEach((c) => {
          if (c.dataset.loCheck.startsWith(kind + '|')) c.checked = el.checked;
        });
      };
    });

    const cleanBtn = $('#lo-clean', target);
    if (cleanBtn) {
      cleanBtn.onclick = async () => {
        const mode = $('input[name="lo-mode"]:checked', target).value;
        const filesOut = [];
        const regOut = [];
        $$('input[data-lo-check]:checked', target).forEach((c) => {
          const [kind, id] = c.dataset.loCheck.split('|');
          const pool = kind === 'file' ? files : registry;
          const item = pool.find((x) => x.id === id);
          if (!item) return;
          if (kind === 'file') filesOut.push({ path: item.path });
          else regOut.push({ path: item.path });
        });
        if (!filesOut.length && !regOut.length) {
          U.toast('Nothing selected to remove.', 'warn');
          return;
        }
        if (mode === 'delete') {
          const ok = await U.confirmDialog({
            title: 'Permanent deletion',
            body: 'Permanently delete the selected items? Registry keys are still exported as backups, but files will be gone.',
            confirmLabel: 'Delete permanently',
            danger: true,
          });
          if (!ok) return;
        }
        cleanBtn.disabled = true;
        cleanBtn.textContent = 'Removing…';
        const r = await U.api.clean.execute({ files: filesOut, registryKeys: regOut, system: [], mode });
        cleanBtn.disabled = false;
        cleanBtn.textContent = 'Remove selected';
        if (r.ok) {
          U.toast(`Cleanup done: ${r.data.succeeded} succeeded, ${r.data.failed} failed.`, r.data.failed ? 'warn' : 'ok');
          Views.renderLoResults({ name, publisher, installLocation });
        } else {
          U.toast('Cleanup failed: ' + (r.error || ''), 'err');
        }
      };
    }
  };

  function loChecklist(items, kind) {
    return `
      <div class="card flush">
        <div class="card-head">
          <label class="check"><input type="checkbox" data-lo-all="${esc(kind)}"/><span>Select all ${items.length}</span></label>
        </div>
        ${items
          .map((item, i) => {
            const path = item.path || item.regPath || '';
            return `
            <div class="finding" style="--i:${Math.min(i, 24)}">
              <label title="Include in cleanup"><input type="checkbox" data-lo-check="${esc(kind)}|${esc(item.id)}" ${item.checked && !item.conflict ? 'checked' : ''} ${item.conflict ? 'disabled' : ''}/></label>
              <span class="conf ${confClass(item.confidence)}">${confLabel(item.confidence)}</span>
              <div class="body">
                <div class="path">${esc(path)}</div>
                <div class="meta">${item.sizeKb ? fmtSize(item.sizeKb) + ' ' : ''}${item.matchedOn ? '· matched ' + esc(item.matchedOn) : ''}${item.admin ? '· admin' : ''}</div>
                ${item.conflict ? `<div class="conflict">Unchecked because it also matches: ${esc(item.conflict)}</div>` : ''}
              </div>
              ${U.copyBtn(path, 'path')}
            </div>`;
          })
          .join('')}
      </div>`;
  }

  // =====================================================================
  // Runtimes
  // =====================================================================

  Views.renderRuntimes = async function (force) {
    const target = $('#runtimes-results');
    target.classList.remove('hidden');
    target.innerHTML = `<div class="card">${U.skeletonTable(5, 4)}</div>`;
    const res = await U.api.runtimes.analyze(force ? true : undefined);
    if (!res.ok) {
      target.innerHTML = `<div class="err-block">${esc(res.error)}</div>`;
      return;
    }
    const runtimes = res.data.runtimes || [];
    if (!runtimes.length) {
      target.innerHTML = '<div class="empty">No shared runtimes were detected on this system.</div>';
      return;
    }
    target.innerHTML = `
      <table class="tbl">
        <thead><tr><th>Runtime</th><th>Version</th><th>Arch</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${runtimes
            .map((r, i) => statusRow(r, i))
            .join('')}
        </tbody>
      </table>`;
  };

  function statusRow(r, i) {
    const status =
      r.status === 'in-use'
        ? '<span class="badge ok">in use</span>'
        : r.status === 'no-known-dependents'
          ? '<span class="badge warn">no known dependants</span>'
          : '<span class="badge info">unverified</span>';
    const users = r.users || [];
    const button =
      r.removable && r.appId
        ? `<button class="btn danger small" data-run-uninstall="${esc(r.appId)}">Uninstall</button>`
        : r.status === 'in-use'
          ? `<span class="muted small">used by ${users.length} app${users.length === 1 ? '' : 's'}</span>`
          : '';
    return `
      <tr style="--i:${Math.min(i, 24)}">
        <td><strong>${esc(r.name)}</strong>${r.systemComponent ? ' <span class="badge sys">OS</span>' : ''}</td>
        <td>${esc(r.version || '')}</td>
        <td>${esc(r.architecture || '')}</td>
        <td>${status}</td>
        <td>${button}</td>
      </tr>
      ${
        users.length
          ? `<tr><td colspan="5" style="padding:0"><details><summary>Dependants (${users.length})</summary>
              <div class="stack">
              ${users.map((u, j) => `<div class="finding" style="--i:${Math.min(j, 24)}"><div class="body"><div class="path">${esc(u.appName)}</div><div class="meta">evidence: ${esc(u.evidence)}</div></div></div>`).join('')}
              </div></details></td></tr>`
          : ''
      }`;
  }

  // =====================================================================
  // Quarantine
  // =====================================================================

  Views.renderQuarantine = async function () {
    const target = $('#quarantine-list');
    target.innerHTML = `<div class="card">${U.skeletonTable(4, 6)}</div>`;
    const res = await U.api.quarantine.list();
    if (!res.ok) {
      target.innerHTML = `<div class="err-block">${esc(res.error)}</div>`;
      return;
    }
    const batches = res.data || [];
    if (!batches.length) {
      target.innerHTML = `<div class="empty-state">
        <span class="empty-ico"><svg class="ico"><use href="#i-shield"></use></svg></span>
        <h3>Nothing quarantined</h3>
        <p>Files you remove are held here so a mistake stays reversible. Registry keys are always saved as <code>.reg</code> backups first.</p>
      </div>`;
      return;
    }
    target.innerHTML = `
      <table class="tbl">
        <thead><tr><th>When</th><th>Mode</th><th>Files</th><th>Registry keys</th><th>System items</th><th>Result</th><th></th></tr></thead>
        <tbody>
          ${batches
            .map(
              (b, i) => `<tr style="--i:${Math.min(i, 24)}">
                <td>${esc(fmtDate(b.createdAt))}</td>
                <td>${esc(b.mode)}${b.purged ? ' <span class="badge sys">purged</span>' : ''}</td>
                <td>${b.fileCount || 0}</td>
                <td>${b.registryCount || 0}</td>
                <td>${b.systemCount || 0}</td>
                <td>${
                  b.failed
                    ? `<span class="badge err">${b.succeeded || 0} ok, ${b.failed} failed</span>`
                    : `<span class="badge ok">${b.succeeded || 0} ok</span>`
                }</td>
                <td>
                  <div class="row gap">
                    ${b.purged ? '' : `<button class="btn small" data-restore="${esc(b.id)}"><svg class="ico"><use href="#i-restore"></use></svg>Restore</button>`}
                    <button class="btn danger small" data-purge="${esc(b.id)}"><svg class="ico"><use href="#i-trash"></use></svg>Purge</button>
                  </div>
                </td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;

    $$('[data-restore]', target).forEach((btn) => {
      btn.onclick = async () => {
        const ok = await U.confirmDialog({
          title: 'Restore batch',
          body: 'Move the quarantined files back and re-import the exported registry keys?',
          confirmLabel: 'Restore',
        });
        if (!ok) return;
        const r = await U.api.quarantine.restore(btn.dataset.restore);
        U.toast(r.ok ? 'Restore finished.' : ('Restore failed: ' + (r.error || '')), r.ok ? 'ok' : 'err');
        Views.renderQuarantine();
      };
    });
    $$('[data-purge]', target).forEach((btn) => {
      btn.onclick = async () => {
        const ok = await U.confirmDialog({
          title: 'Purge batch',
          body: 'Permanently delete this quarantine batch and its registry backups? This cannot be undone.',
          confirmLabel: 'Purge',
          danger: true,
        });
        if (!ok) return;
        const r = await U.api.quarantine.purge(btn.dataset.purge);
        U.toast(r.ok ? 'Batch purged.' : 'Purge failed.', r.ok ? 'ok' : 'err');
        Views.renderQuarantine();
      };
    });
  };

  // =====================================================================
  // History
  // =====================================================================

  Views.renderHistory = async function () {
    const target = $('#history-list');
    const res = await U.api.history.list();
    const history = res.ok ? res.data || [] : [];
    if (!history.length) {
      target.innerHTML = `<div class="empty-state">
        <span class="empty-ico"><svg class="ico"><use href="#i-clock"></use></svg></span>
        <h3>No history yet</h3>
        <p>Uninstalls and cleanups you run will be recorded here with their method and result.</p>
      </div>`;
      return;
    }
    target.innerHTML = `
      <table class="tbl">
        <thead><tr><th>When</th><th>Application</th><th>Method</th><th>Result</th><th>Cleanup</th></tr></thead>
        <tbody>
          ${history
            .map(
              (h, i) => `<tr style="--i:${Math.min(i, 24)}">
                <td>${esc(fmtDate(h.at))}</td>
                <td>${esc(h.name || '')} ${h.version ? esc(` (${h.version})`) : ''}</td>
                <td>${esc(h.method || '')}</td>
                <td>${h.ok ? '<span class="badge ok">removed</span>' : '<span class="badge err">failed</span>'}</td>
                <td>${h.cleaned != null ? `${h.cleaned} items` : ''}${h.mode ? ` (${esc(h.mode)})` : ''}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
  };

  // =====================================================================
  // Log
  // =====================================================================

  Views.renderLog = async function () {
    const target = $('#log-output');
    const res = await U.api.log.tail(600);
    const lines = res.ok ? res.data.lines || [] : [];
    const file = res.ok ? res.data.file : '';
    target.textContent =
      lines
        .map((l) => `[${new Date(l.at).toISOString()}] [${l.level.toUpperCase().padEnd(5)}] ${l.message}${l.meta ? ' ' + (typeof l.meta === 'string' ? l.meta : JSON.stringify(l.meta)).slice(0, 500) : ''}`)
        .join('\n') + (file ? `\n\n--- log file: ${file}` : '');
    target.scrollTop = target.scrollHeight;
  };

  // =====================================================================
  // Settings
  // =====================================================================

  Views.renderSettings = async function () {
    const target = $('#settings-body');
    const s = state.settings || {};

    const groups = [
      {
        title: 'Scanning',
        items: [
          ['hideSystemComponents', 'Hide system components', 'Keep MSIX frameworks, shared runtimes and Windows components out of the application list.'],
          ['hideUpdates', 'Hide updates and hotfixes', 'Skip entries that are updates rather than removable programs.'],
          ['scanRegistryReferences', 'Scan the whole registry for references', 'Slower, but finds keys pointing at the install path anywhere under HKLM and HKCU.'],
          ['analyzeRuntimesOnUninstall', 'Analyze shared runtimes after uninstalling', 'Check whether a runtime such as Visual C++ just lost its last dependant.'],
          ['checkLeftoversAfterUninstall', 'Scan for leftovers automatically', 'Look for the files and keys the vendor uninstaller left behind.'],
          ['stopRunningProcesses', 'Close running processes first', 'Terminate processes running from the install folder before uninstalling.'],
        ],
      },
      {
        title: 'Safety',
        items: [
          ['confirmBeforeDelete', 'Always confirm before deleting files', 'Show the irreversible-deletion prompt even for small cleanups.'],
        ],
      },
    ];

    const themeSource = (state.settings && state.settings.theme) || 'system';
    const appearance = `
      <div class="card">
        <div class="section-title" style="margin-top:0">Appearance</div>
        <div class="toggle setting" style="cursor:default">
          <span class="setting-text">
            <span class="setting-name">Theme</span>
            <span class="hint">Match Windows automatically, or lock the interface to dark or light.</span>
          </span>
          <div class="segmented">
            <label title="Always dark"><input type="radio" name="theme-mode" value="dark" ${themeSource === 'dark' ? 'checked' : ''}/><svg class="ico sm"><use href="#i-moon"/></svg><span>Dark</span></label>
            <label title="Always light"><input type="radio" name="theme-mode" value="light" ${themeSource === 'light' ? 'checked' : ''}/><svg class="ico sm"><use href="#i-sun"/></svg><span>Light</span></label>
            <label title="Follow Windows"><input type="radio" name="theme-mode" value="system" ${themeSource === 'system' ? 'checked' : ''}/><svg class="ico sm"><use href="#i-auto"/></svg><span>System</span></label>
          </div>
        </div>
      </div>`;

    target.innerHTML = appearance + groups
      .map(
        (g) => `
      <div class="card">
        <div class="section-title" style="margin-top:0">${esc(g.title)}</div>
        ${g.items
          .map(
            ([key, name, desc]) => `
          <label class="toggle setting">
            <span class="setting-text">
              <span class="setting-name">${esc(name)}</span>
              <span class="hint">${esc(desc)}</span>
            </span>
            <input type="checkbox" data-setting="${esc(key)}" ${s[key] ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>`,
          )
          .join('')}
        ${
          g.title === 'Safety'
            ? `<div class="toggle setting" style="cursor:default">
                 <span class="setting-text">
                   <span class="setting-name">Default cleanup mode</span>
                   <span class="hint">Quarantine keeps a copy you can restore; permanent delete is irreversible.</span>
                 </span>
                 <div class="segmented">
                   <label><input type="radio" name="cleanup-mode" value="quarantine" ${s.defaultCleanupMode !== 'delete' ? 'checked' : ''}/><span>Quarantine</span></label>
                   <label><input type="radio" name="cleanup-mode" value="delete" ${s.defaultCleanupMode === 'delete' ? 'checked' : ''}/><span>Delete</span></label>
                 </div>
               </div>`
            : ''
        }
      </div>`,
      )
      .join('');

    $$('[data-setting]', target).forEach((el) => {
      el.onchange = async () => {
        await U.saveSettings({ [el.dataset.setting]: el.checked });
        U.toast('Setting saved', 'ok', 1800);
      };
    });
    $$('input[name="cleanup-mode"]', target).forEach((el) => {
      el.onchange = async () => {
        await U.saveSettings({ defaultCleanupMode: el.value });
        U.toast('Cleanup mode saved', 'ok', 1800);
      };
    });
    $$('input[name="theme-mode"]', target).forEach((el) => {
      el.onchange = () => U.setTheme(el.value);
    });
    U.syncThemeControls();
  };

  Views.setActive = function (appId) {
    $$('#apps-list .list-item[data-app-id]').forEach((li) => {
      li.classList.toggle('active', li.dataset.appId === appId);
    });
  };

  Views.refresh = function () {
    Views.renderAppsList();
    const sel = state.selectedId;
    if (sel) {
      const app = state.apps.find((a) => a.id === sel);
      if (!app) {
        const pane = $('#detail-pane');
        if (pane) pane.innerHTML = '<div class="placeholder">Select an application.</div>';
        state.selectedId = null;
      } else {
        Views.renderDetail(sel, { keepList: true });
      }
    }
  };

  // =====================================================================
  // Exports
  // =====================================================================

  U.Views = Views;

  // Wizard is defined in wizard.js but referenced from views; loaded order:
  window.__viewsReady = true;
})();
