'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { paths, isMachinePath } = require('../util/paths');
const {
  matchScore,
  isSafeEntryName,
  normalizeName,
  compactKey,
  confidenceOf,
  extractPathsFromCommandLine,
} = require('../util/names');
const registry = require('../util/registry');

// ---------------------------------------------------------------------------
// Target description
// ---------------------------------------------------------------------------

function stripVendorNoise(name) {
  return String(name || '')
    .replace(/\s*[-–—]\s*\d+(\.\d+)*\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function folderNameOf(p) {
  if (!p) return '';
  try {
    const norm = String(p).replace(/[\\/]+$/, '');
    return path.basename(norm);
  } catch {
    return '';
  }
}

function stripInstallKeySuffix(keyName) {
  if (!keyName) return '';
  if (/^\{[0-9A-Fa-f-]{36}\}/.test(keyName)) return '';
  return keyName.replace(/_(is1|is|msi|uninstall|setup)$/i, '').trim();
}

/**
 * Collect every plausible name this application might use for its own files
 * and registry keys, each with a weight reflecting how specific it is.
 */
function candidateNames(target, allAppNames = []) {
  const out = [];
  const push = (value, kind, weight) => {
    const v = String(value || '').trim();
    if (!v || v.length < 3) return;
    if (!isSafeEntryName(v)) return;
    if (isGenericCandidate(v)) return;
    if (out.some((c) => c.kind === kind && c.value.toLowerCase() === v.toLowerCase())) return;
    out.push({ value: v, kind, weight });
  };

  const raw = target.name || '';
  const cleaned = stripVendorNoise(raw);
  const normalized = normalizeName(raw);

  push(raw, 'name', 1);
  if (cleaned && cleaned !== raw) push(cleaned, 'name', 1);
  if (normalized && normalized.length >= 3) push(normalized, 'name', 1);

  const installFolder = folderNameOf(target.installLocation);
  push(installFolder, 'installFolder', 1.1);

  for (const p of target.commandPaths || []) {
    push(path.basename(p), 'commandFile', 0.8);
  }
  const iconBase = target.iconPath ? path.basename(stripVendorNoise(target.iconPath)) : '';
  if (iconBase) push(iconBase.replace(/\.(exe|ico|png|dll)$/i, ''), 'icon', 0.9);

  push(stripInstallKeySuffix(target.keyName), 'registryKey', 1);

  // Publisher is a useful hint but far from unique (e.g. "Google" holds many
  // products) so it only ever scores into the "review" bucket.
  if (target.publisher && !isGenericPublisherName(target.publisher)) {
    push(target.publisher, 'publisher', 0.4);
    if (normalized) push(`${target.publisher} ${normalized}`, 'publisherName', 0.9);
    push(`${target.publisher} ${cleaned}`, 'publisherName', 0.9);
  }

  return out;
}

function isGenericCandidate(v) {
  const k = compactKey(v);
  return /^(program files|program files x86|programdata|windows|system32|common files|microsoft|users|public|temp|desktop|documents|appdata|localappdata|roaming|packages|bin|lib|include|share|resources|assets|tools|runtime|redistributable|update|installer|uninstall|unins\d*)$/.test(
    k,
  );
}

function isGenericPublisherName(name) {
  const k = compactKey(name);
  return /^(microsoft|microsoftcorporation|windows|unknown|none|na|inc|ltd|llc|corp|verifiedpublisher|google|apple|adobe|intel|nvidia|amd)$/.test(
    k,
  );
}

function buildTarget(app) {
  const reg = (app.registry && app.registry[0]) || {};
  const commandPaths = [reg.uninstallString, reg.quietUninstallString, reg.modifyPath].flatMap(
    extractPathsFromCommandLine,
  );
  return {
    id: app.id,
    name: app.name,
    publisher: app.publisher || '',
    installLocation: app.installLocation || '',
    installSource: reg.installSource || '',
    keyName: reg.keyName || '',
    regPath: reg.regPath || '',
    hive: reg.hive || '',
    iconPath: app.iconPath || '',
    commandPaths,
    packageFullName: app.packageFullName || '',
    packageFamilyName: app.packageFamilyName || '',
    registryPaths: (app.registry || []).map((r) => r.regPath),
    installDate: app.installDate || '',
  };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function scoreName(candidates, name, excludeNames) {
  let best = { score: 0, matchedOn: null, conflict: null };

  for (const c of candidates) {
    const s = matchScore(c.value, name);
    if (!s) continue;
    const weighted = s * c.weight;
    if (weighted > best.score) best = { score: weighted, matchedOn: c.value, conflict: null };
  }

  if (!best.score) return best;

  // If the path looks more like some *other* installed product, flag it rather
  // than silently offering it up for deletion.
  for (const other of excludeNames) {
    if (compactKey(other) === compactKey(name)) {
      const exactSelf = candidates.some((c) => compactKey(c.value) === compactKey(name));
      if (!exactSelf) best = { ...best, conflict: other };
      break;
    }
  }
  return best;
}

function shouldDefaultCheck(confidence) {
  return confidence === 'high';
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

async function dirSizeKb(dir, budget = { entries: 40000 }) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > budget.entries) return { kb: Math.round(total / 1024), truncated: true };
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(full);
          total += st.size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { kb: Math.round(total / 1024), truncated: false };
}

async function listChildren(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}


/** Directories that plausibly belong to the product name passed in. */
async function scanStandardRoots(target, candidates, excludeNames, results, seenPaths) {
  const roots = [
    { key: 'Program Files', dir: paths.programFiles },
    { key: 'Program Files (x86)', dir: paths.programFilesX86 },
    { key: 'ProgramData', dir: paths.programData },
    { key: 'AppData\\Roaming', dir: paths.appData },
    { key: 'AppData\\Local', dir: paths.localAppData },
    { key: 'User profile', dir: paths.userProfile },
  ];

  for (const root of roots) {
    if (!root.dir) continue;
    const children = await listChildren(root.dir);
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (!isSafeEntryName(child.name)) continue;
      const full = path.join(root.dir, child.name);
      if (seenPaths.has(full.toLowerCase())) continue;

      let match = scoreName(candidates, child.name, excludeNames);

      // Descend one level for vendor folders (e.g. AppData\Roaming\Vendor\Product).
      if (match.score < 1.6 && child.name.length <= 40) {
        const grandchildren = await listChildren(full);
        for (const gc of grandchildren) {
          if (!gc.isDirectory() || !isSafeEntryName(gc.name)) continue;
          const gcFull = path.join(full, gc.name);
          if (seenPaths.has(gcFull.toLowerCase())) continue;
          const gcMatch = scoreName(candidates, gc.name, excludeNames);
          if (gcMatch.score >= 1.6) {
            seenPaths.add(gcFull.toLowerCase());
            results.push(
              makeFileItem({
                path: gcFull,
                kind: 'dir',
                score: Math.min(gcMatch.score, 3),
                matchedOn: `${gcMatch.matchedOn} (inside ${child.name})`,
                conflict: gcMatch.conflict,
                origin: `${root.key}\\${child.name}`,
              }),
            );
          }
        }
        continue;
      }

      if (match.score <= 0) continue;
      seenPaths.add(full.toLowerCase());
      results.push(
        makeFileItem({
          path: full,
          kind: 'dir',
          score: match.score,
          matchedOn: match.matchedOn,
          conflict: match.conflict,
          origin: root.key,
        }),
      );
    }
  }
}

function makeFileItem({ path: p, kind, score, matchedOn, conflict, origin, note }) {
  const confidence = confidenceOf(score);
  return {
    id: `fs:${p.toLowerCase()}`,
    path: p,
    kind,
    score: Math.round(score * 100) / 100,
    confidence,
    checked: shouldDefaultCheck(confidence) && !conflict,
    conflict: conflict || null,
    matchedOn: matchedOn || '',
    origin: origin || '',
    note: note || '',
    admin: isMachinePath(p),
    sizeKb: null,
    broken: false,
  };
}

/** The install folder itself, if it is still on disk after uninstalling. */
async function scanInstallLocation(target, results, seenPaths) {
  const loc = target.installLocation;
  if (!loc) return;
  const normalized = loc.replace(/[\\/]+$/, '');
  const exists = await fsp
    .stat(normalized)
    .then(() => true)
    .catch(() => false);
  if (!exists) return;
  if (seenPaths.has(normalized.toLowerCase())) return;
  seenPaths.add(normalized.toLowerCase());
  results.push(
    makeFileItem({
      path: normalized,
      kind: 'dir',
      score: 3,
      matchedOn: 'install location',
      origin: 'InstallLocation',
      note: 'The application reported this as its install directory.',
    }),
  );
}

async function scanStartMenuAndDesktop(target, candidates, excludeNames, results, seenPaths) {
  const startMenuRoots = [
    { dir: path.join(paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), origin: 'Start Menu (user)' },
    { dir: path.join(paths.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), origin: 'Start Menu (all users)' },
    { dir: path.join(paths.userProfile, 'Desktop'), origin: 'Desktop' },
    { dir: path.join(paths.systemDrive, 'Users', 'Public', 'Desktop'), origin: 'Public Desktop' },
  ];
  const installLower = (target.installLocation || '').toLowerCase();

  for (const root of startMenuRoots) {
    const files = await walk(root.dir, { maxDepth: 4, maxFiles: 4000, exts: ['.lnk', '.url'] });
    for (const file of files) {
      const full = file.full;
      if (seenPaths.has(full.toLowerCase())) continue;
      const base = path.basename(full).replace(/\.(lnk|url)$/i, '');
      let match = scoreName(candidates, base, excludeNames);

      // Also catch shortcuts whose payload points into the install directory.
      if (match.score < 3 && installLower) {
        const payload = await readLnkText(full);
        if (payload && payload.toLowerCase().includes(installLower)) {
          match = { score: 3, matchedOn: 'shortcut target', conflict: null };
        }
      }
      if (match.score <= 0) continue;
      seenPaths.add(full.toLowerCase());
      results.push(
        makeFileItem({
          path: full,
          kind: 'file',
          score: match.score,
          matchedOn: match.matchedOn,
          conflict: match.conflict,
          origin: root.origin,
        }),
      );
    }
  }
}

/** Symlinks are never followed; .lnk payloads are read as raw text. */
async function readLnkText(file) {
  try {
    const buf = await fsp.readFile(file);
    const latin = buf.toString('latin1');
    const utf16 = buf.toString('utf16le');
    return `${latin}\n${utf16}`;
  } catch {
    return '';
  }
}

async function walk(dir, { maxDepth = 3, maxFiles = 2000, exts = null } = {}) {
  const out = [];
  const stack = [{ dir, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir: current, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        if (!exts || exts.includes(path.extname(entry.name).toLowerCase())) out.push({ full, name: entry.name });
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/** Orphaned package data under AppData\Local\Packages for AppX apps. */
async function scanAppxData(target, results, seenPaths) {
  const root = path.join(paths.localAppData, 'Packages');
  if (!target.packageFamilyName && !target.name) return;
  const familyBase = target.packageFamilyName ? target.packageFamilyName.split('_')[0].toLowerCase() : '';
  const children = await listChildren(root);
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const full = path.join(root, child.name);
    if (seenPaths.has(full.toLowerCase())) continue;
    const lname = child.name.toLowerCase();
    const matchesFamily = familyBase && lname.startsWith(`${familyBase}_`);
    const matchesName = compactKey(child.name.split('_')[0]) && compactKey(child.name.split('_')[0]) === compactKey(target.name);
    if (matchesFamily || matchesName) {
      seenPaths.add(full.toLowerCase());
      results.push(
        makeFileItem({
          path: full,
          kind: 'dir',
          score: 3,
          matchedOn: matchesFamily ? 'AppX package family' : 'AppX package name',
          origin: 'AppData\\Local\\Packages',
          note: 'Per-user application data for this package.',
        }),
      );
    }
  }
}

async function scanFilesystem(target, candidates, excludeNames) {
  const results = [];
  const seenPaths = new Set();
  await scanInstallLocation(target, results, seenPaths);
  await scanStandardRoots(target, candidates, excludeNames, results, seenPaths);
  await scanStartMenuAndDesktop(target, candidates, excludeNames, results, seenPaths);
  await scanAppxData(target, results, seenPaths);

  // Drop anything nested inside something already scheduled for removal so we
  // do not present the same bytes twice.
  const top = [];
  const sorted = results.sort((a, b) => a.path.length - b.path.length);
  for (const item of sorted) {
    const parent = top.find(
      (t) => t.kind === 'dir' && item.path.toLowerCase().startsWith(t.path.toLowerCase() + path.sep),
    );
    if (parent) continue;
    top.push(item);
  }

  // Size on disk, bounded so a huge folder cannot stall the scan.
  await Promise.all(
    top
      .filter((i) => i.kind === 'dir')
      .map(async (i) => {
        const { kb, truncated } = await dirSizeKb(i.path);
        i.sizeKb = kb;
        i.sizeTruncated = truncated;
      }),
  );
  for (const item of top.filter((i) => i.kind === 'file')) {
    try {
      const st = await fsp.stat(item.path);
      item.sizeKb = Math.round(st.size / 1024);
    } catch {
      item.broken = true;
    }
  }

  top.sort((a, b) => b.score - a.score || (b.sizeKb || 0) - (a.sizeKb || 0));
  return top;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

async function scanRegistry(target, candidates, excludeNames) {
  const items = [];
  const seen = new Set();

  const add = ({ regPath, score, matchedOn, note, conflict }) => {
    const normalized = registry.toRegPath(regPath);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    const confidence = confidenceOf(score);
    seen.add(key);
    items.push({
      id: `reg:${key}`,
      path: normalized,
      score: Math.round(score * 100) / 100,
      confidence,
      checked: shouldDefaultCheck(confidence) && !conflict,
      conflict: conflict || null,
      matchedOn: matchedOn || '',
      note: note || '',
      admin: registry.isMachineScope(normalized),
      exists: true,
      hive: registry.hiveOf(normalized),
    });
  };

  // 1. The application's own Uninstall keys (these must survive the vendor
  //    uninstaller or they are the classic "still in Programs and Features" bug).
  for (const regPath of target.registryPaths || []) {
    if (await registry.keyExists(regPath)) {
      add({ regPath, score: 3, matchedOn: 'uninstall entry', note: 'Leftover Programs and Features entry.' });
    }
  }

  // 2. Vendor software keys under each hive.
  const softwareRoots = [
    'HKLM\\SOFTWARE',
    'HKLM\\SOFTWARE\\WOW6432Node',
    'HKCU\\SOFTWARE',
    'HKCU\\SOFTWARE\\WOW6432Node',
  ];

  for (const root of softwareRoots) {
    const children = await registry.listSubKeys(root);
    for (const child of children) {
      const full = `${root}\\${child}`;
      const match = scoreName(candidates, child, excludeNames);
      if (match.score <= 1.1) continue;

      // Vendor key? Look one level deeper for the product itself.
      if (match.score < 2) {
        const sub = await registry.listSubKeys(full);
        for (const s of sub) {
          const subFull = `${full}\\${s}`;
          const subMatch = scoreName(candidates, s, excludeNames);
          if (subMatch.score >= 1.6) {
            add({
              regPath: subFull,
              score: Math.min(subMatch.score, 3),
              matchedOn: `${subMatch.matchedOn} (under ${child})`,
              conflict: subMatch.conflict,
              note: 'Application settings.',
            });
          }
        }
        continue;
      }
      add({ regPath: full, score: match.score, matchedOn: match.matchedOn, conflict: match.conflict, note: 'Application settings.' });
    }
  }

  // 3. App Paths and file-association registrations keyed on the executable.
  const exeNames = new Set();
  for (const p of target.commandPaths || []) exeNames.add(path.basename(p).toLowerCase());
  if (target.iconPath) exeNames.add(path.basename(target.iconPath).toLowerCase());
  for (const exe of exeNames) {
    if (!/\.(exe|com|bat)$/i.test(exe)) continue;
    const appPath = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
    const appPath32 = `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
    if (await registry.keyExists(appPath)) add({ regPath: appPath, score: 2.5, matchedOn: 'App Paths' });
    if (await registry.keyExists(appPath32)) add({ regPath: appPath32, score: 2.5, matchedOn: 'App Paths (32-bit)' });
  }

  // 4. Classes\Applications\<exe> registrations.
  for (const exe of exeNames) {
    const k = `HKCR\\Applications\\${exe}`;
    if (await registry.keyExists(k)) add({ regPath: k, score: 2.5, matchedOn: 'Applications key' });
  }

  items.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return items;
}

// ---------------------------------------------------------------------------

/**
 * `app` is either an inventory entry (from the merged app list) or an ad-hoc
 * target ({ name, publisher, installLocation }) for a search by name.
 */
async function findLeftovers(app, options = {}) {
  const target = app.registry
    ? buildTarget(app)
    : {
        id: `name:${app.name}`,
        name: app.name,
        publisher: app.publisher || '',
        installLocation: app.installLocation || '',
        commandPaths: [],
        registryPaths: [],
        packageFullName: app.packageFullName || '',
        packageFamilyName: app.packageFamilyName || '',
      };

  const excludeNames = (options.otherAppNames || []).filter((n) => compactKey(n) !== compactKey(target.name));

  if (options.includeAppxPackages === false) {
    target.packageFullName = '';
    target.packageFamilyName = '';
  }

  const candidates =
    options.candidateNames && options.candidateNames.length
      ? options.candidateNames.map((v) => ({ value: v, kind: 'manual', weight: 1 }))
      : candidateNames(target, excludeNames);

  const [files, reg] = await Promise.all([
    scanFilesystem(target, candidates, excludeNames),
    scanRegistry(target, candidates, excludeNames),
  ]);

  return {
    target,
    candidates,
    files,
    registry: reg,
    totalSizeKb: files.reduce((sum, f) => sum + (f.sizeKb || 0), 0),
  };
}

/** Scan a folder list for entries that match no currently installed product. */
async function findOrphanedFolders(installedNames) {
  const roots = [
    { dir: paths.programFiles, origin: 'Program Files', admin: true },
    { dir: paths.programFilesX86, origin: 'Program Files (x86)', admin: true },
    { dir: paths.programData, origin: 'ProgramData', admin: true },
    { dir: paths.appData, origin: 'AppData\\Roaming', admin: false },
    { dir: paths.localAppData, origin: 'AppData\\Local', admin: false },
  ];
  const out = [];
  for (const root of roots) {
    const children = await listChildren(root.dir);
    for (const child of children) {
      if (!child.isDirectory() || !isSafeEntryName(child.name)) continue;
      if (isGenericCandidate(child.name)) continue;
      const matches = installedNames.some((n) => matchScore(n, child.name) >= 2);
      if (matches) continue;
      out.push({ path: path.join(root.dir, child.name), origin: root.origin, admin: root.admin, name: child.name });
    }
  }
  return out;
}

module.exports = { buildTarget, findLeftovers, findOrphanedFolders, candidateNames };
