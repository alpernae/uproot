'use strict';

/* Uninstall wizard: review -> uninstall -> verify -> leftover review -> clean. */
(function () {
  const U = window.UI;
  const { $, $$, esc, fmtSize, fmtDate, state } = U;
  const Views = U.Views;

  const METHOD_LABELS = {
    'msi-silent': 'Windows Installer (silent)',
    'vendor-quiet': "Vendor's silent uninstaller",
    'vendor-interactive': "Vendor's uninstall wizard",
    winget: 'Windows Package Manager (winget)',
    appx: 'Store / MSIX package',
    url: 'Protocol handler uninstaller',
  };

  const STEP_NAMES = ['Review', 'Uninstall', 'Verify', 'Leftovers', 'Cleanup'];

  function logLine(el, text, status) {
    if (!el) return;
    const row = document.createElement('div');
    row.className = 'logline';
    row.innerHTML = `<span class="dot ${status || ''}"></span><span class="txt"></span>`;
    row.querySelector('.txt').textContent = text;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  }

  function optionRow(name, label, checked) {
    return `<label class="toggle setting">
        <span class="setting-text"><span class="setting-name">${esc(label)}</span></span>
        <input type="checkbox" data-opt="${name}" ${checked ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>`;
  }

  const Wizard = {
    current: null,

    async start(app) {
      const planRes = await U.api.apps.plan(app.id);
      const plan = planRes.ok ? planRes.data : null;
      if (!plan || !plan.possible) {
        U.toast(plan && plan.notes ? plan.notes.join(' ') : 'No uninstall command registered.', 'warn');
        this.openLeftoversReview(app, true);
        return;
      }
      this.current = {
        app,
        plan,
        step: 1,
        opts: {
          stopProcesses: (state.settings && state.settings.stopRunningProcesses) !== false,
          allUsers: false,
          scanLeftovers: (state.settings && state.settings.checkLeftoversAfterUninstall) !== false,
          checkRuntimes: (state.settings && state.settings.analyzeRuntimesOnUninstall) !== false,
        },
        logLines: [],
        uninstallResult: null,
        scans: null,
        selections: null,
      };
      this.openModal();
      this.show();
    },

    async openLeftoversReview(app, standalone) {
      this.current = {
        app,
        plan: standalone ? null : this.current ? this.current.plan : null,
        step: standalone ? 4 : 1,
        standalone,
        opts: {
          stopProcesses: true,
          allUsers: false,
          scanLeftovers: true,
          checkRuntimes: (state.settings && state.settings.analyzeRuntimesOnUninstall) !== false,
        },
        logLines: [],
        uninstallResult: null,
        scans: null,
        selections: null,
      };
      this.openModal();
      this.show();
    },

    close() {
      window.__wizardProgress = null;
      U.closeModal();
      this.current = null;
    },

    openModal() {
      const app = this.current.app;
      const m = U.modal('<div id="wizard-body"><p class="muted">Loading…</p></div>', {
        title: this.current.standalone ? `Leftovers · ${app.name}` : `Uninstall ${app.name}`,
        wide: true,
        static: true,
        onClose: () => {
          this.current = null;
        },
      });
      this.modal = m;
    },

    chips() {
      const current = this.current;
      const labels = current.standalone ? ['Scan', 'Review', 'Cleanup'] : STEP_NAMES;
      const idx = current.standalone ? ((current.step - 3)) : current.step;
      return `<div class="steps">${labels
        .map((label, i) => {
          const stepNum = i + 1;
          const cls =
            stepNum === idx ? 'active' : stepNum < idx ? 'done' : '';
          return `<div class="step-chip ${cls}"><span class="step-label">${label}</span></div>`;
        })
        .join('')}</div>`;
    },

    show() {
      const body = $('#wizard-body');
      const app = this.current.app;
      if (!body) return;

      if (this.current.step === 1) {
        body.innerHTML = this.step1Html();
        this.wireStep1();
      } else if (this.current.step === 2) {
        body.innerHTML = this.step2Html();
        this.runUninstall();
      } else if (this.current.step === 3) {
        body.innerHTML = this.step3Html();
        this.wireStep3();
      } else if (this.current.step === 4) {
        body.innerHTML = this.step4Html();
        this.runScans();
      } else if (this.current.step === 5) {
        body.innerHTML = this.step5Html();
        this.runCleanup();
      }
    },

    // ---------------------------------------------------------------- step 1
    step1Html() {
      const { plan } = this.current;
      const notes = (plan.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');

      const opts = this.current.opts;
      const appxOptions =
        plan.method === 'appx'
          ? optionRow('allUsers', 'Remove for all users (requires administrator rights) — also removes the provisioned package', opts.allUsers) +
            `<div class="warn-block">Removing for all users needs a UAC prompt and may affect new user profiles.</div>`
          : '';

      return `
        ${this.chips()}
        <div class="card">
          <div class="kv">
            <dt>Application</dt><dd>${esc(plan.name)}</dd>
            <dt>Method</dt><dd>${esc(METHOD_LABELS[plan.method] || plan.method)}</dd>
            <dt>Command</dt><dd><code>${esc(plan.command)}</code></dd>
            <dt>Interaction</dt><dd>${plan.interactive ? '<span class="badge warn">a wizard window will open — finish it manually</span>' : '<span class="badge ok">runs unattended</span>'}</dd>
          </div>
          ${notes ? `<ul>${notes}</ul>` : ''}
          ${plan.needsAdmin ? '<div class="warn-block">This uninstaller needs administrator rights. A UAC prompt will appear.</div>' : ''}
          <div class="stack">
            ${optionRow('stopProcesses', 'Close processes running from the install folder first', opts.stopProcesses)}
            ${appxOptions}
            ${optionRow('scanLeftovers', 'Scan for leftover files, registry keys and dependencies after uninstalling', opts.scanLeftovers)}
            ${optionRow('checkRuntimes', 'Check whether any shared runtime became orphaned', opts.checkRuntimes)}
          </div>
        </div>
        <div class="row end">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn danger" data-go><svg class="ico"><use href="#i-trash"></use></svg>Start uninstall</button>
        </div>`;
    },

    wireStep1() {
      const body = $('#wizard-body');
      const app = this.current.app;
      $$('[data-opt]', body).forEach((el) => {
        el.onchange = () => {
          this.current.opts[el.dataset.opt] = el.checked;
        };
      });
      $('[data-cancel]', body).onclick = () => this.close();
      $('[data-go]', body).onclick = () => {
        this.current.step = 2;
        this.show();
      };
    },

    // ---------------------------------------------------------------- step 2
    step2Html() {
      return `
        ${this.chips()}
        <div class="card">
          <div class="section-title" style="margin-top:0">Uninstalling</div>
          <div class="wizard-log" id="wizard-log"></div>
        </div>`;
    },

    async runUninstall() {
      const { app, plan, opts } = this.current;
      const logEl = $('#wizard-log');
      const append = (text, status) => {
        const line = `${new Date().toLocaleTimeString()}  ${text}`;
        this.current.logLines.push(line);
        logLine(logEl, line, status);
      };

      window.__wizardProgress = (event) => {
        if (event.phase !== 'uninstall' && event.phase !== 'clean') return;
        const status = event.status === 'done' ? 'ok' : event.status === 'error' ? 'err' : event.status === 'warning' ? 'warn' : 'run';
        append(`${event.id || 'step'} ${event.detail || ''}`.trim(), status);
      };

      append(`Starting: ${plan.command}`, 'run');
      const res = await U.api.uninstall.run({
        appId: app.id,
        allUsers: opts.allUsers,
        stopRunningProcesses: opts.stopProcesses,
      });
      append(res.ok ? `Uninstaller finished (${res.data ? res.data.code : 'ok'}).` : `Failed: ${res.error}`, res.ok ? 'ok' : 'err');
      if (res.data && res.data.steps) {
        for (const step of res.data.steps) {
          const st = step.status === 'done' ? 'ok' : step.status === 'error' ? 'err' : 'warn';
          append(`${step.id}${step.detail ? ' — ' + step.detail : ''}`, st);
        }
      }
      this.current.uninstallResult = res;
      this.current.step = 3;
      this.show();
    },

    // ---------------------------------------------------------------- step 3
    step3Html() {
      const res = this.current.uninstallResult;
      const data = res.ok ? res.data : null;
      let block = '';
      if (!res.ok) block = `<div class="err-block">${esc(res.error)}</div>`;
      else if (data && data.blocked === true) block = `<div class="err-block">The UAC prompt was cancelled. Nothing was changed.</div>`;
      else if (data && data.ok === false && data.method === 'appx' && data.output && /denied/i.test(data.output)) {
        block = `<div class="err-block">Access denied. Try running this package removal as administrator.</div>`;
      } else if (data) {
        const verification = data.verification;
        if (verification && verification.removed) block = `<div class="ok-block">The application is no longer registered — uninstalled successfully.</div>`;
        else if (verification && verification.reasons && verification.reasons.length) {
          block = `<div class="warn-block"><strong>Partial.</strong><br/>${verification.reasons.map(esc).join('<br/>')}</div>`;
        } else if (data.needsUserConfirmation) {
          block = `<div class="warn-block">The uninstaller was opened through a protocol handler. Finish it manually, then press the button below.</div>`;
        } else {
          block = `<div class="warn-block">The uninstaller returned a non-success exit code (${esc(data.code)}). Review the log.</div>`;
        }
        if (data.stoppedProcesses && data.stoppedProcesses.length) {
          block += `<p class="hint">Closed ${data.stoppedProcesses.length} process(es) first.</p>`;
        }
      }

      // Runtime hint.
      let runtimeHint = '';
      if (this.current.opts.checkRuntimes && res.ok && data && (data.ok || (data.verification && data.verification.removed))) {
        runtimeHint = `<button class="btn" data-check-runtimes><svg class="ico"><use href="#i-cube"></use></svg>Check shared runtimes</button>`;
      }

      const scanBtn =
        this.current.opts.scanLeftovers || this.current.standalone
          ? `<button class="btn primary" data-next>Continue to leftover scan</button>`
          : `<button class="btn primary" data-finish>Finish</button>`;

      return `
        ${this.chips()}
        ${block}
        <details><summary>Full output</summary><pre class="wizard-log" style="max-height:260px">${esc((data && (data.output || '')) || '')}</pre></details>
        <div class="row end" style="margin-top:12px">
          ${runtimeHint}
          ${data && data.needsUserConfirmation ? `<button class="btn" data-recheck>I finished the uninstaller</button>` : ''}
          ${scanBtn}
        </div>`;
    },

    wireStep3() {
      const body = $('#wizard-body');
      const next = $('[data-next]', body);
      if (next) next.onclick = () => { this.current.step = 4; this.show(); };
      const finish = $('[data-finish]', body);
      if (finish) finish.onclick = () => this.done();
      const recheck = $('[data-recheck]', body);
      if (recheck) recheck.onclick = () => { this.current.step = 4; this.show(); };
      const checkRuntimes = $('[data-check-runtimes]', body);
      if (checkRuntimes) checkRuntimes.onclick = async () => {
        checkRuntimes.disabled = true;
        U.setProgress('Analyzing shared runtimes…');
        const r = await U.api.runtimes.analyze(true);
        U.clearProgress();
        if (r.ok) {
          const orphans = (r.data.runtimes || []).filter((x) => x.status === 'no-known-dependents');
          const html =
            orphans.length
              ? `<div class="section-title">Unused shared runtimes (${orphans.length})</div>
                 <div class="stack">${orphans
                   .map(
                     (o, i) =>
                       `<div class="finding" style="--i:${Math.min(i, 24)}"><div class="body"><div class="path">${esc(o.name)}</div><div class="meta">No installed application links against it.</div></div>${
                         o.appId ? `<button class="btn danger small" data-run-uninstall="${esc(o.appId)}">Uninstall</button>` : ''
                       }</div>`,
                   )
                   .join('')}</div>`
              : '<div class="empty">No shared runtime is left without dependants.</div>';
          const holder = document.createElement('div');
          holder.innerHTML = html;
          checkRuntimes.replaceWith(holder.firstElementChild || document.createElement('span'));
          $$('[data-run-uninstall]', holder).forEach((btn) => {
            btn.onclick = async () => {
              const app = state.apps.find((a) => a.id === btn.dataset.runUninstall);
              if (app) {
                this.current.afterClosed = () => Wizard.start(app);
                this.close();
              } else {
                U.toast('This runtime has no registered uninstall command. Use Apps → remove it manually.', 'warn');
              }
            };
          });
        }
      };
    },

    // ---------------------------------------------------------------- step 4
    step4Html() {
      const standaloneNote = this.current.standalone
        ? '<div class="warn-block">This scans everything the application may have left behind — even if it was never uninstalled here.</div>'
        : '';
      return `
        ${this.chips()}
        ${standaloneNote}
        <div class="card">
          <div class="section-title" style="margin-top:0" id="scan-status">Scanning</div>
          <div class="wizard-log" id="scan-log"></div>
        </div>`;
    },

    async runScans() {
      const app = this.current.app;
      const hint = $('#scan-status');
      const log = $('#scan-log');
      const flash = (msg) => {
        if (hint) hint.textContent = msg;
        logLine(log, msg, 'run');
      };

      this.current.scans = { files: [], registry: [], system: [], runtimes: [], errors: [] };

      const scanLeftovers = U.api.leftovers.find(app.id, (state.settings && state.settings.scanRegistryReferences) !== false);
      flash('Scanning leftover files and registry keys…');

      const scans = [scanLeftovers];
      let footprintRes = null;
      if (!this.current.standalone) footprintRes = U.api.apps.footprint(app.id, (state.settings && state.settings.scanRegistryReferences) !== false);
      if (!this.current.standalone) scans.push(footprintRes);
      let runtimeRes = null;
      if (this.current.opts.checkRuntimes && app.installLocation) {
        flash('Checking shared runtimes (reading import tables)…');
        runtimeRes = U.api.runtimes.analyze();
        scans.push(runtimeRes);
      }

      const [lo, fp, rt] = await Promise.all(scans);

      if (lo.ok && lo.data) {
        this.current.scans.files = lo.data.files || [];
        this.current.scans.registry = lo.data.registry || [];
        if (lo.data.target && lo.data.target.name) flash(`Scan complete: ${this.current.scans.files.length} paths, ${this.current.scans.registry.length} registry keys.`);
      } else {
        this.current.scans.errors.push(lo.error);
      }
      if (!this.current.standalone && fp && fp.ok && fp.data) {
        this.current.scans.system = fp.data.findings || [];
      }
      if (rt && rt.ok && rt.data) {
        this.current.scans.runtimes = (rt.data.runtimes || []).filter((r) => r.status === 'no-known-dependents' && r.removable);
      }

      this.renderReview();
    },

    renderReview() {
      const body = $('#wizard-body');
      const { files, registry, system, runtimes, errors } = this.current.scans;
      if (!body) return;

      const filesChecked = files.filter((f) => f.checked && !f.conflict).length;
      const regChecked = registry.filter((r) => r.checked && !r.conflict).length;
      const systemChecked = system.filter((s) => s.checked && !s.conflict).length;
      const fileSize = files.reduce((sum, f) => sum + (f.sizeKb || 0), 0);

      const group = (title, items, key, note) => {
        const checked = items.filter((i) => i.checked && !i.conflict).length;
        const total = items.length;
        return `
          <div class="section-title">${esc(title)} (${total}${checked !== total ? ` — ${checked} selected` : ''})${note ? ` <span class="muted small">${esc(note)}</span>` : ''}</div>
          ${renderChecklist(items, key, checked === total)}`;
      };

      body.innerHTML = `
        ${this.chips()}
        ${
          this.current.standalone
            ? ''
            : `<div class="ok-block">Uninstalled successfully. What is left is everything the application registered or installed that its own uninstaller did not remove.</div>`
        }
        ${errors.length ? `<div class="err-block">${esc(errors.join(' '))}</div>` : ''}

        <div class="card">
          <div class="row between">
            <div class="row gap">
              ${filesChecked ? `<span class="badge ok">${filesChecked} paths</span>` : ''}
              ${regChecked ? `<span class="badge ok">${regChecked} registry keys</span>` : ''}
              ${systemChecked ? `<span class="badge ok">${systemChecked} system items</span>` : ''}
              ${fileSize ? `<span class="muted small">≈ ${fmtSize(fileSize)}</span>` : ''}
            </div>
            <div class="segmented">
              <label><input type="radio" name="clean-mode" value="quarantine" ${state.settings.defaultCleanupMode !== 'delete' ? 'checked' : ''}/><span>Quarantine</span></label>
              <label><input type="radio" name="clean-mode" value="delete" ${state.settings.defaultCleanupMode === 'delete' ? 'checked' : ''}/><span>Delete</span></label>
            </div>
          </div>
          <div class="warn-block">Only select items you are sure about — anything unverified or matching another product is left unchecked.</div>
        </div>

        ${files.length ? group('Files & folders', files, 'file') : ''}
        ${registry.length ? group('Registry & settings', registry, 'registry') : ''}
        ${system.length ? group('Services, tasks & shell extensions', system, 'system') : ''}
        ${runtimes.length ? group('Orphaned shared runtimes', runtimes, 'runtime') : ''}

        <div class="row end" style="margin-top:16px">
          <button class="btn" data-back>Back</button>
          <button class="btn primary" data-clean><svg class="ico"><use href="#i-trash"></use></svg>Remove selected items</button>
        </div>`;

      this.wireReview();
    },

    wireReview() {
      const body = $('#wizard-body');
      const selections = {
        files: [],
        registry: [],
        system: [],
        runtimes: [],
      };

      const poolFor = (kind) =>
        kind === 'file' ? this.current.scans.files
        : kind === 'registry' ? this.current.scans.registry
        : kind === 'system' ? this.current.scans.system
        : kind === 'runtime' ? this.current.scans.runtimes
        : [];

      $$('input[data-check]', body).forEach((el) => {
        el.onchange = () => {
          const [kind, id] = el.dataset.check.split('|');
          const pool = poolFor(kind);
          const item = pool && pool.find((x) => x.id === id);
          if (item) item.checked = el.checked;
        };
      });

      $$('input[data-check-all]', body).forEach((el) => {
        el.onchange = () => {
          const container = el.closest('.card') || body;
          $$('input[data-check]', container).forEach((c) => {
            c.checked = el.checked;
            const [kind, id] = c.dataset.check.split('|');
            const pool = poolFor(kind);
            const item = pool && pool.find((x) => x.id === id);
            if (item) item.checked = el.checked;
          });
        };
      });

      const collect = (kind, source) => {
        const list = (source || []).filter((x) => x.checked && !x.conflict);
        if (kind === 'runtime') return list;
        if (kind === 'system') return list; // keep full finding for kind-aware cleanup
        return list.map((x) => ({ path: x.path }));
      };

      const back = $('[data-back]', body);
      if (back) back.onclick = () => { this.current.step = 3; this.show(); };

      const cleanBtn = $('[data-clean]', body);
      cleanBtn.onclick = async () => {
        const mode = $('input[name="clean-mode"]:checked', body).value;
        this.current.selectedMode = mode;
        if (mode === 'delete') {
          const ok = await U.confirmDialog({
            title: 'Permanent deletion',
            body: `Permanently delete the selected items? Registry keys are still exported as backups, but files will be gone.`,
            confirmLabel: 'Delete permanently',
            danger: true,
          });
          if (!ok) return;
        }
        this.current.selections = {
          files: collect('file', this.current.scans.files),
          registry: collect('registry', this.current.scans.registry).map((x) => ({ path: x.path })),
          system: collect('system', this.current.scans.system),
          runtimes: this.current.scans.runtimes.filter((r) => r.checked && !r.conflict),
        };
        const total =
          this.current.selections.files.length +
          this.current.selections.registry.length +
          this.current.selections.system.length;
        if (!total && !this.current.selections.runtimes.length) {
          U.toast('Nothing selected to remove.', 'warn');
          return;
        }
        this.current.step = 5;
        this.show();
      };
    },

    // ---------------------------------------------------------------- step 5
    step5Html() {
      return `
        ${this.chips()}
        <div class="card">
          <div class="section-title" style="margin-top:0" id="clean-status">Cleaning up</div>
          <div class="wizard-log" id="clean-log"></div>
        </div>`;
    },

    async runCleanup() {
      const { selections, app, plan } = this.current;
      const status = $('#clean-status');
      const log = $('#clean-log');
      const flash = (msg, st = 'run') => {
        if (status) status.textContent = msg;
        logLine(log, msg, st);
      };
      const mode = this.current.selectedMode || state.settings.defaultCleanupMode || 'quarantine';

      const files = [...selections.files];
      const registryKeys = [...selections.registry];
      const systemItems = [];
      for (const s of selections.system || []) {
        if (s.kind === 'service') systemItems.push({ type: 'service', name: s.name });
        else if (s.kind === 'task') systemItems.push({ type: 'task', taskName: s.taskName, taskPath: s.taskPath || '\\' });
        else if (s.kind === 'startup' && s.isFile && s.target) files.push({ path: s.target });
        else if (s.kind === 'startup' && s.valueName) systemItems.push({ type: 'registryValue', regPath: s.regPath, valueName: s.valueName });
        else if (s.kind === 'shellex') {
          if (s.regPath) registryKeys.push({ path: s.regPath });
          if (s.clsidKey) registryKeys.push({ path: s.clsidKey });
        } else if (s.regPath) registryKeys.push({ path: s.regPath });
      }

      let result = null;
      if (files.length || registryKeys.length || systemItems.length) {
        const res = await U.api.clean.execute({ files, registryKeys, system: systemItems, mode });
        result = res.ok ? res.data : null;
        if (res.ok) {
          flash(`Cleanup done: ${result.succeeded} succeeded, ${result.failed} failed${result.failed ? ' (see log)' : ''}.`, result.failed ? 'warn' : 'ok');
        } else {
          flash(`Cleanup failed: ${res.error}`, 'err');
        }
      } else {
        flash('Nothing to clean.');
      }

      // Record uninstall history.
      U.api.history.add({
        name: app.name,
        version: app.version || plan.version || '',
        method: plan ? plan.method : 'leftover-cleanup',
        ok: this.current.uninstallResult ? this.current.uninstallResult.ok === true && result !== null : true,
        cleaned: files.length + registryKeys.length + systemItems.length,
        mode,
      }).catch(() => {});

      const runtimeSuggestion = selections.runtimes.length
        ? `<div class="section-title">Orphaned shared runtimes — remove separately</div>
           <div class="stack">${selections.runtimes
             .map(
               (r, i) =>
                 `<div class="finding" style="--i:${Math.min(i, 24)}"><div class="body"><div class="path">${esc(r.name)}</div><div class="meta">No installed app links against it. Its own uninstaller must run to remove it safely.</div></div>${
                   r.appId ? `<button class="btn danger small" data-run-uninstall="${esc(r.appId)}">Uninstall</button>` : ''
                 }</div>`,
             )
             .join('')}</div>`
        : '';

      const holder = $('#wizard-body');
      if (holder) {
        const restoNote =
          mode === 'quarantine' && result
            ? `<div class="ok-block">Files were moved to quarantine — undo any of this from the <b>Quarantine</b> tab. Registry keys were exported as <code>.reg</code> backups before deletion.</div>`
            : result
              ? `<div class="ok-block">Cleanup complete. Registry backups were kept in the quarantine store.</div>`
              : '';
        holder.innerHTML = `
          ${this.chips()}
          <div class="card">
            <p><strong>${esc(app.name)}</strong> — removal finished.</p>
            ${restoNote}
            ${runtimeSuggestion}
          </div>
          <div class="row end">
            <button class="btn primary" data-done>Done</button>
          </div>`;
        $$('[data-run-uninstall]', holder).forEach((btn) => {
          btn.onclick = async () => {
            const runtimeApp = state.apps.find((a) => a.id === btn.dataset.runUninstall);
            this.close();
            setTimeout(() => runtimeApp && Wizard.start(runtimeApp), 150);
          };
        });
        $('[data-done]', holder).onclick = () => this.done();
      }
    },

    done() {
      this.close();
      U.toast('Removal finished. Re-scanning the installed applications list…', 'ok');
      U.loadApps(true).then(() => {
        U.clearIconCache();
        Views.refresh();
      });
    },
  };

  // Small shared checklist renderer.
  function renderChecklist(items, kind, allChecked) {
    if (!items.length) return '<p class="muted small">None found.</p>';
    return `
      <div class="card flush">
        <div class="card-head">
          <label class="check"><input type="checkbox" data-check-all="page" ${allChecked ? 'checked' : ''}/><span>Select all ${items.length}</span></label>
        </div>
        ${items
          .map((item, i) => {
            const id = item.id || `${kind}:${(item.path || item.regPath || item.name || '').toLowerCase()}`;
            if (item.id === undefined) item.id = id;
            const path = item.path || item.regPath || item.name || '';
            const confCls = U.confClass(item.confidence);
            const checked = item.checked && !item.conflict ? 'checked' : '';
            return `
            <div class="finding" data-kind="${esc(kind)}" data-id="${esc(item.id)}" style="--i:${Math.min(i, 24)}">
              <label title="Include in cleanup"><input type="checkbox" data-check="${esc(kind)}|${esc(item.id)}" ${checked} ${item.conflict ? 'disabled' : ''}/></label>
              <span class="conf ${confCls}">${U.confLabel(item.confidence)}</span>
              <div class="body">
                <div class="path">${esc(path)}</div>
                <div class="meta">
                  ${item.sizeKb ? fmtSize(item.sizeKb) : ''}
                  ${item.matchedOn ? `· matched ${esc(item.matchedOn)}` : ''}
                  ${item.kind === 'runtime' ? `· v${esc(item.version || '')}` : ''}
                  ${item.admin ? '· admin' : ''}
                </div>
                ${
                  item.conflict
                    ? `<div class="conflict">Unchecked because it also matches: ${esc(item.conflict)}</div>`
                    : ''
                }
              </div>
              ${U.copyBtn(path, 'path')}
            </div>`;
          })
          .join('')}
      </div>`;
  }

  U.Wizard = Wizard;
})();