'use strict';

const { listRegistryApps } = require('./registry');
const { listWingetApps } = require('./winget');
const { listAppxPackages } = require('./appx');
const { matchScore, compactKey } = require('../util/names');

function newEntry() {
  return {
    registry: [],
    winget: [],
    appx: [],
  };
}

function primaryRegistry(entry) {
  // Prefer a machine-wide record that actually has an uninstall command.
  const withCmd = entry.registry.filter((r) => r.uninstallString || r.windowsInstaller);
  const pool = withCmd.length ? withCmd : entry.registry;
  return pool.find((r) => r.view === '64' && r.isMachineScope) || pool[0] || null;
}

function finalize(entry) {
  const reg = primaryRegistry(entry);
  const appx = entry.appx[0] || null;
  const winget = entry.winget[0] || null;

  const sources = [];
  if (entry.registry.length) sources.push('registry');
  if (entry.winget.length) sources.push('winget');
  if (entry.appx.length) sources.push('appx');

  let id;
  if (reg) id = reg.id;
  else if (appx) id = appx.id;
  else if (winget) id = winget.id;
  else return null;

  // Registry names are the most human-friendly; winget names beat raw AppX
  // package identifiers ("UnigramPreview" -> "Unigram—Telegram for Windows").
  const rawAppxName = (appx && appx.name) || '';
  const name = (reg && reg.name) || (winget && winget.name) || rawAppxName;
  const version = (reg && reg.version) || (appx && appx.version) || (winget && winget.version) || '';

  const isPackageIdentifier =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawAppxName) ||
    /^[A-Za-z0-9.]+\.[A-Za-z0-9.]+$/.test(rawAppxName) ||
    !rawAppxName;

  const isSystemPackage =
    entry.appx.length > 0 &&
    (entry.appx.every((p) => p.isFramework) ||
      (isPackageIdentifier && !winget) ||
      /(framework|runtime|redistributable|vclibs|native\.|\.net\.native|ui\.xaml)/i.test(`${rawAppxName} ${name}`));

  const needsAdmin =
    Boolean(reg && reg.isMachineScope) || entry.appx.some((p) => p.nonRemovable || p.isFramework);

  const uninstallers = [];
  if (reg) {
    if (reg.quietUninstallString) uninstallers.push('quiet');
    if (reg.uninstallString) uninstallers.push('normal');
    if (reg.windowsInstaller) uninstallers.push('msi');
  }
  if (winget && winget.wingetId) uninstallers.push('winget');
  if (appx) uninstallers.push('appx');

  return {
    id,
    name: name || (winget && winget.wingetId) || 'Unknown',
    version,
    publisher: (reg && reg.publisher) || (appx && appx.publisher) || '',
    installLocation: (reg && reg.installLocation) || (appx && appx.installLocation) || '',
    iconPath: (reg && reg.iconPath) || (appx && appx.installLocation) || '',
    estimatedSizeKb: (reg && reg.estimatedSizeKb) || 0,
    installDate: (reg && reg.installDate) || '',
    sources,
    registry: entry.registry,
    winget: entry.winget,
    appx: entry.appx,
    wingetId: winget ? winget.wingetId : null,
    packageFullName: appx ? appx.packageFullName : null,
    packageFamilyName: appx ? appx.packageFamilyName : null,
    isFramework: entry.appx.length > 0 && entry.appx.every((p) => p.isFramework),
    isSystemPackage,
    nonRemovable: entry.appx.some((p) => p.nonRemovable),
    isSystemComponent: entry.registry.some((r) => r.isSystemComponent),
    isUpdate: entry.registry.length > 0 && entry.registry.every((r) => r.isUpdate),
    scope: reg ? (reg.isMachineScope ? 'machine' : 'user') : appx ? 'appx' : 'winget',
    needsAdmin,
    uninstallers,
    canUpgrade: Boolean(winget && winget.canUpgrade),
    availableVersion: (winget && winget.availableVersion) || '',
  };
}

function attachWinget(entry, w) {
  if (!entry.winget.some((x) => x.wingetId === w.wingetId && x.version === w.version)) {
    entry.winget.push(w);
  }
}

/**
 * Collapse the three inventories into one list. Joins are deterministic where
 * possible (winget encodes registry keys as ARP\Scope\Arch\Key and MSIX package
 * full names verbatim) and fuzzy only as a last resort.
 */
function mergeInventories({ registry = [], winget = [], appx = [] }) {
  const entries = [];
  const byRegKey = new Map();
  const byAppxFull = new Map();
  const byName = new Map();

  const index = (entry, key) => {
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  };

  for (const r of registry) {
    const entry = newEntry();
    entry.registry.push(r);
    entries.push(entry);
    const k = r.keyName.toLowerCase();
    if (!byRegKey.has(k)) byRegKey.set(k, entry);
    const nk = compactKey(r.name);
    if (nk) index(entry, nk);
  }

  for (const p of appx) {
    const entry = newEntry();
    entry.appx.push(p);
    entries.push(entry);
    byAppxFull.set(p.packageFullName.toLowerCase(), entry);
    const nk = compactKey(p.name);
    if (nk) index(entry, nk);
  }

  const unattached = [];
  for (const w of winget) {
    let target = null;
    if (/^ARP\\/i.test(w.wingetId)) {
      const keyName = w.wingetId.split('\\').pop().toLowerCase();
      target = byRegKey.get(keyName) || null;
    } else if (/^MSIX\\/i.test(w.wingetId)) {
      target = byAppxFull.get(w.wingetId.slice(5).toLowerCase()) || null;
    }
    if (target) attachWinget(target, w);
    else unattached.push(w);
  }

  const leftovers = [];
  for (const w of unattached) {
    const nk = compactKey(w.name);
    const pool = (byName.get(nk) || []).filter((e) => !e.winget.length);
    if (pool.length === 1) {
      attachWinget(pool[0], w);
      continue;
    }
    if (pool.length > 1) {
      // Ambiguous by exact name; only take it when one candidate scores 3.
      const strong = pool.filter((e) => matchScore(e.registry[0]?.name || e.appx[0]?.name, w.name) === 3);
      if (strong.length === 1) {
        attachWinget(strong[0], w);
        continue;
      }
    }
    leftovers.push(w);
  }

  for (const w of leftovers) {
    const entry = newEntry();
    entry.winget.push(w);
    entries.push(entry);
  }

  const finals = entries.map(finalize).filter(Boolean);

  // Two registry records describing the same product+version collapse into one.
  const deduped = [];
  const seen = new Map();
  for (const app of finals) {
    const key = `${compactKey(app.name)}|${app.version}|${app.scope}`;
    if (!app.name || !app.registry.length) {
      deduped.push(app);
      continue;
    }
    const prev = seen.get(key);
    if (prev) {
      // Keep both registry records so uninstall can fall back between them.
      for (const r of app.registry) {
        if (!prev.registry.some((x) => x.regPath === r.regPath)) prev.registry.push(r);
      }
      for (const w of app.winget) attachWinget(prev, w);
      continue;
    }
    seen.set(key, app);
    deduped.push(app);
  }

  deduped.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return deduped;
}

async function listAllApps() {
  const errors = [];
  const [reg, wg, ax] = await Promise.all([
    listRegistryApps().catch((e) => ({ apps: [], error: e.message })),
    listWingetApps().catch((e) => ({ apps: [], error: e.message })),
    listAppxPackages().catch((e) => ({ packages: [], error: e.message })),
  ]);

  if (reg.error) errors.push(`registry: ${reg.error}`);
  if (wg.error) errors.push(`winget: ${wg.error}`);
  if (ax.error) errors.push(`appx: ${ax.error}`);

  const apps = mergeInventories({ registry: reg.apps, winget: wg.apps, appx: ax.packages });
  return {
    apps,
    errors,
    counts: { registry: reg.apps.length, winget: wg.apps.length, appx: ax.packages.length, merged: apps.length },
  };
}

module.exports = { listAllApps, mergeInventories };
