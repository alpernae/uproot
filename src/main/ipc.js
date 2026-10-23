'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, shell, app, nativeTheme, clipboard } = require('electron');

const { listAllApps } = require('./scan/apps');
const { buildPlan } = require('./uninstall/plan');
const { executeUninstall } = require('./uninstall/run');
const { findLeftovers, findOrphanedFolders, buildTarget, candidateNames } = require('./leftovers/find');
const clean = require('./leftovers/clean');
const system = require('./system/system');
const runtimes = require('./system/runtimes');
const privacy = require('./privacy/privacy');
const registry = require('./util/registry');
const { isAdmin } = require('./util/elevate');
const { compactKey } = require('./util/names');
const store = require('./store');
const log = require('./logger');

const state = {
  apps: [],
  byId: new Map(),
  errors: [],
  counts: null,
  loadedAt: 0,
};

let mainWindow = null;

const THEME_SOURCES = ['dark', 'light', 'system'];
const WINDOW_BG = { dark: '#080a0e', light: '#f5f6f8' };
const APP_CACHE_MS = 60000;

function setWindow(win) {
  mainWindow = win;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function currentTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// Sets nativeTheme.themeSource, which in turn drives the renderer's
// prefers-color-scheme media query, native chrome (scrollbars, form controls)
// and the off-screen window background colour.
function applyTheme(source) {
  nativeTheme.themeSource = THEME_SOURCES.includes(source) ? source : 'system';
  syncWindowBackground();
  return { source: nativeTheme.themeSource, resolved: currentTheme() };
}

function syncWindowBackground() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setBackgroundColor(WINDOW_BG[currentTheme()]);
    } catch {
      /* window may be mid-close */
    }
  }
}

function broadcastTheme() {
  const payload = { source: nativeTheme.themeSource, resolved: currentTheme() };
  syncWindowBackground();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme', payload);
  }
  return payload;
}

function progress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', payload);
  }
}

async function loadApps(force = false) {
  if (!force && state.apps.length && Date.now() - state.loadedAt < APP_CACHE_MS) {
    return { apps: state.apps, errors: state.errors, counts: state.counts, cached: true };
  }
  progress({ phase: 'apps', message: 'Reading installed programs from the registry…' });
  const result = await listAllApps();
  state.apps = result.apps;
  state.errors = result.errors;
  state.counts = result.counts;
  state.loadedAt = Date.now();
  state.byId = new Map(state.apps.map((a) => [a.id, a]));
  log.info('Enumerated applications', result.counts);
  return { apps: state.apps, errors: state.errors, counts: state.counts, cached: false };
}

function requireApp(appId) {
  const found = state.byId.get(appId);
  if (!found) throw new Error(`Unknown application: ${appId}`);
  return found;
}

function otherAppNames(exceptId) {
  return state.apps.filter((a) => a.id !== exceptId).map((a) => a.name);
}

/** Drop cached inventory and icons after anything that changes what is installed. */
function invalidateInventory() {
  state.loadedAt = 0;
  iconCache.clear();
}

/** A registry key that merely stores the install path: never pre-selected. */
function referenceFinding(ref, extra) {
  return {
    path: ref.path,
    matchedOn: ref.needle,
    score: 1.6,
    confidence: 'medium',
    checked: false,
    admin: registry.isMachineScope(ref.path),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const iconCache = new Map();

function findExecutableIn(dir, preferredName) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const exes = entries.filter((e) => e.isFile() && /\.(exe|ico)$/i.test(e.name)).map((e) => path.join(dir, e.name));
  if (!exes.length) return null;
  if (preferredName) {
    const wanted = compactKey(preferredName);
    const match = exes.find((e) => {
      const base = compactKey(path.basename(e, path.extname(e)));
      return base && wanted && (base === wanted || wanted.includes(base) || base.includes(wanted));
    });
    if (match) return match;
  }
  return exes[0];
}

function findLogoIn(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const pngs = entries
    .filter((e) => e.isFile() && /\.(png|jpg|jpeg)$/i.test(e.name))
    .map((e) => path.join(dir, e.name));
  if (!pngs.length) return null;
  const preferred = pngs.find((p) => /square44x44logo|logo44|appicon|icon/i.test(path.basename(p)));
  return preferred || pngs[0];
}

function resolveIconSource({ iconPath, installLocation, name }) {
  const expand = (p) =>
    String(p || '').replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
  const cleanIcon = (p) => {
    let s = expand(p).trim();
    if (s.startsWith('@')) s = s.slice(1);
    const comma = s.indexOf(',');
    if (comma > 0) s = s.slice(0, comma);
    return s;
  };
  if (iconPath) {
    const p = cleanIcon(iconPath);
    if (p && fs.existsSync(p)) {
      const ext = path.extname(p).toLowerCase();
      if (['.exe', '.ico', '.dll', '.png', '.jpg'].includes(ext)) return p;
    }
  }
  if (installLocation) {
    const loc = expand(installLocation);
    const stat = fs.existsSync(loc) ? fs.statSync(loc) : null;
    if (stat && stat.isDirectory()) {
      return findExecutableIn(loc, name) || findLogoIn(loc);
    }
    if (stat && stat.isFile()) return loc;
  }
  return null;
}

async function getIcon({ appId, iconPath, installLocation, name }) {
  const key = appId || iconPath || installLocation || name || 'unknown';
  if (iconCache.has(key)) return iconCache.get(key);
  const source = resolveIconSource({ iconPath, installLocation, name });
  let dataUrl = null;
  if (source) {
    try {
      const image = await app.getFileIcon(source, { size: 'large' });
      if (image && !image.isEmpty()) dataUrl = image.toDataURL();
    } catch {
      dataUrl = null;
    }
  }
  iconCache.set(key, dataUrl);
  return dataUrl;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function register() {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        const data = await fn(payload || {});
        return { ok: true, data };
      } catch (e) {
        log.error(`IPC ${channel} failed`, { message: e.message });
        return { ok: false, error: e.message || String(e) };
      }
    });
  };

  handle('app:info', async () => ({
    name: app.getName(),
    version: app.getVersion(),
    isAdmin: await isAdmin(true),
    dataDir: store.dataDir(),
    quarantineDir: store.quarantineDir(),
    logFile: log.file(),
    platform: process.platform,
    themeSource: nativeTheme.themeSource,
    resolvedTheme: currentTheme(),
    settings: store.getSettings(),
  }));

  handle('apps:list', ({ force } = {}) => loadApps(Boolean(force)));

  handle('app:plan', ({ appId }) => {
    const target = requireApp(appId);
    return buildPlan(target, {});
  });

  handle('app:detail', ({ appId }) => {
    const target = requireApp(appId);
    return {
      app: target,
      plan: buildPlan(target, {}),
      candidates: candidateNames(buildTarget(target), otherAppNames(appId)),
    };
  });

  handle('app:footprint', async ({ appId, includeReferences }) => {
    const target = requireApp(appId);
    const built = buildTarget(target);
    const exclude = otherAppNames(appId);
    const candidates = candidateNames(built, exclude);
    progress({ phase: 'footprint', message: 'Inspecting services, tasks and shell extensions…' });
    const { findings, errors } = await system.scanSystem(built, candidates, exclude);

    let references = [];
    if (includeReferences && built.installLocation) {
      progress({ phase: 'footprint', message: 'Searching the registry for references to the install path…' });
      const refs = await system.scanRegistryReferences([built.installLocation]);
      references = refs.items.map((r) =>
        referenceFinding(r, {
          kind: 'registry-reference',
          name: r.path.split('\\').pop(),
          regPath: r.path,
          target: r.matchedValue,
          note: 'A registry value stores this path. Review before removing.',
        }),
      );
    }

    return { findings: [...findings, ...references], errors };
  });

  handle('leftovers:find', async ({ appId, includeRegistryReferences }) => {
    const target = requireApp(appId);
    progress({ phase: 'leftovers', message: 'Scanning for leftover files and registry keys…' });
    const result = await findLeftovers(target, { otherAppNames: otherAppNames(appId) });

    if (includeRegistryReferences && target.installLocation) {
      const refs = await system.scanRegistryReferences([target.installLocation]);
      const existing = new Set(result.registry.map((r) => r.path.toLowerCase()));
      for (const r of refs.items) {
        if (existing.has(r.path.toLowerCase())) continue;
        result.registry.push(
          referenceFinding(r, {
            id: `reg:${r.path.toLowerCase()}`,
            conflict: null,
            note: 'A registry value stores the install path.',
            exists: true,
          }),
        );
      }
    }
    return result;
  });

  handle('leftovers:findByName', async ({ name, publisher, installLocation }) => {
    if (!name || String(name).trim().length < 2) throw new Error('Enter at least two characters to search for.');
    const target = {
      id: `name:${name}`,
      name: String(name).trim(),
      publisher: publisher || '',
      installLocation: installLocation || '',
      commandPaths: [],
      registryPaths: [],
      packageFullName: '',
      packageFamilyName: '',
    };
    return findLeftovers(target, { otherAppNames: state.apps.map((a) => a.name) });
  });

  handle('leftovers:orphaned', async () => {
    const names = state.apps.map((a) => a.name);
    const folders = await findOrphanedFolders(names);
    return { folders };
  });

  handle('clean:execute', async ({ files = [], registryKeys = [], system = [], mode }) => {
    const settings = store.getSettings();
    const chosen = mode || settings.defaultCleanupMode;
    const processNames = new Set();
    for (const f of files) {
      const base = path.basename(f.path || '');
      if (/\.exe$/i.test(base)) processNames.add(base.replace(/\.exe$/i, ''));
    }
    const manifest = await clean.executeCleanup({
      files,
      registryKeys,
      system,
      quarantineDir: store.quarantineDir(),
      mode: chosen,
      processNames: [...processNames],
      onProgress: (p) => progress(p),
    });
    log.info('Cleanup executed', { mode: chosen, succeeded: manifest.succeeded, failed: manifest.failed });
    invalidateInventory();
    return manifest;
  });

  handle('quarantine:list', () => clean.listQuarantine(store.quarantineDir()));

  handle('quarantine:restore', async ({ id }) => {
    if (!id) throw new Error('Missing batch id');
    const result = await clean.restoreBatch(store.quarantineDir(), id);
    invalidateInventory();
    return result;
  });

  handle('quarantine:purge', async ({ id }) => {
    if (!id) throw new Error('Missing batch id');
    return clean.purgeBatch(store.quarantineDir(), id);
  });

  handle('uninstall:run', async ({ appId, allUsers, stopRunningProcesses, force }) => {
    const target = requireApp(appId);
    const plan = buildPlan(target, { force: Boolean(force) });
    if (!plan.possible && !target.installLocation && !target.packageFullName) {
      throw new Error('This entry has no uninstall command registered.');
    }
    const settings = store.getSettings();
    const result = await executeUninstall(target, plan, {
      allUsers: Boolean(allUsers),
      force: Boolean(force),
      stopRunningProcesses: stopRunningProcesses === undefined ? settings.stopRunningProcesses : Boolean(stopRunningProcesses),
      onEvent: (event) => progress({ phase: 'uninstall', ...event }),
    });
    log.info('Uninstall finished', { name: target.name, method: plan.method, ok: result.ok, force: Boolean(force) });
    invalidateInventory();
    return result;
  });

  // ------------------------------------------------------------------
  // Privacy (Windows telemetry / activity data)
  // ------------------------------------------------------------------

  handle('privacy:scan', async () => {
    progress({ phase: 'privacy', message: 'Inventorying Windows telemetry services, tasks and activity stores…' });
    const result = await privacy.scanPrivacy(store.getSettings());
    log.info('Privacy scan finished', { findings: result.findings.length, errors: result.errors.length });
    return result;
  });

  handle('privacy:remove', async ({ items = [], mode } = {}) => {
    const settings = store.getSettings();
    const chosen = mode || settings.defaultCleanupMode;
    const payload = privacy.buildRemovalPayload(items);
    if (!payload.files.length && !payload.registryKeys.length && !payload.system.length) {
      throw new Error('Nothing selected to remove.');
    }
    const manifest = await clean.executeCleanup({
      files: payload.files,
      registryKeys: payload.registryKeys,
      system: payload.system,
      quarantineDir: store.quarantineDir(),
      mode: chosen,
      processNames: [],
      onProgress: (p) => progress({ phase: 'clean', ...p }),
    });
    log.info('Privacy cleanup executed', { mode: chosen, succeeded: manifest.succeeded, failed: manifest.failed });
    store.appendHistory({
      name: 'Windows privacy cleanup',
      version: '',
      method: 'privacy',
      ok: manifest.failed === 0,
      cleaned: manifest.succeeded,
      mode: chosen,
    });
    invalidateInventory();
    return manifest;
  });

  handle('runtimes:analyze', async ({ force } = {}) => {
    if (!state.apps.length) await loadApps();
    progress({ phase: 'runtimes', message: 'Reading import tables to find runtime dependants…' });
    const results = await runtimes.analyzeRuntimes(state.apps, {
      force: Boolean(force),
      onProgress: (p) => progress(p),
    });
    return { runtimes: results };
  });

  handle('icon:get', (payload) => getIcon(payload));

  handle('shell:reveal', ({ target }) => {
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  handle('shell:openExternal', ({ url }) => {
    if (url && /^https?:/i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => {
    const next = store.setSettings(patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      applyTheme(next.theme);
    }
    return next;
  });

  handle('theme:current', () => ({ source: nativeTheme.themeSource, resolved: currentTheme() }));

  handle('clipboard:writeText', ({ text } = {}) => {
    clipboard.writeText(text == null ? '' : String(text));
    return true;
  });

  handle('log:tail', ({ count } = {}) => ({ lines: log.tail(count || 400), file: log.file() }));
  handle('history:list', () => store.readHistory());
  handle('history:add', (entry) => store.appendHistory(entry || {}));

  // nativeTheme re-resolves when the OS scheme changes while the user is on
  // "system" (and when themeSource changes). Push the resolved theme so the
  // renderer never has to guess.
  nativeTheme.on('updated', () => broadcastTheme());
}

module.exports = {
  register,
  setWindow,
  loadApps,
  applyTheme,
  broadcastTheme,
  currentTheme,
};
