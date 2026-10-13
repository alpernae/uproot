'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');

const { psJson, asArray } = require('../util/ps');
const { run } = require('../util/exec');
const { paths, tools } = require('../util/paths');
const registry = require('../util/registry');
const { matchScore, compactKey, isPathInside, confidenceOf } = require('../util/names');

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const SERVICES_SCRIPT = String.raw`
$result = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    name        = [string]$_.Name
    displayName = [string]$_.DisplayName
    pathName    = [string]$_.PathName
    startMode   = [string]$_.StartMode
    state       = [string]$_.State
    startName   = [string]$_.StartName
    processId   = $_.ProcessId
  }
}
`;

async function listServices() {
  const r = await psJson(SERVICES_SCRIPT, { timeout: 120000 });
  if (!r.ok) return { items: [], error: r.error || r.stderr };
  const rows = asArray(r.data);
  return {
    items: rows.map((s) => ({
      kind: 'service',
      name: s.name,
      displayName: s.displayName || s.name,
      target: s.pathName || '',
      state: s.state,
      startMode: s.startMode,
      account: s.startName,
      running: String(s.state).toLowerCase() === 'running',
    })),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

const TASKS_SCRIPT = String.raw`
$result = Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $t = $_
  $exec = ''
  $arguments = ''
  try { $exec = (@($t.Actions) | ForEach-Object { [string]$_.Execute } | Where-Object { $_ }) -join ';' } catch { }
  try { $arguments = (@($t.Actions) | ForEach-Object { [string]$_.Arguments } | Where-Object { $_ }) -join ';' } catch { }
  [pscustomobject]@{
    taskName  = [string]$t.TaskName
    taskPath  = [string]$t.TaskPath
    state     = [string]$t.State
    author    = [string]$t.Author
    execute   = $exec
    arguments = $arguments
  }
}
`;

async function listScheduledTasks() {
  const r = await psJson(TASKS_SCRIPT, { timeout: 180000 });
  if (!r.ok) return { items: [], error: r.error || r.stderr };
  const rows = asArray(r.data);
  return {
    items: rows.map((t) => ({
      kind: 'task',
      name: `${t.taskPath || '\\'}${t.taskName}`.replace(/\\+/g, '\\'),
      taskPath: t.taskPath || '\\',
      taskName: t.taskName,
      target: t.execute || '',
      arguments: t.arguments || '',
      state: t.state,
      author: t.author,
    })),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Startup entries (Run keys + Startup folders)
// ---------------------------------------------------------------------------

const RUN_SCRIPT = String.raw`
$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
)
$result = foreach ($k in $keys) {
  $item = Get-Item -Path $k -ErrorAction SilentlyContinue
  if (-not $item) { continue }
  foreach ($n in @($item.Property)) {
    $data = $null
    try { $data = $item.GetValue($n) } catch { }
    [pscustomobject]@{
      key   = $k
      name  = [string]$n
      data  = [string]$data
      scope = if ($k -like 'HKCU*') { 'user' } else { 'machine' }
    }
  }
}
`;

async function listRunEntries() {
  const r = await psJson(RUN_SCRIPT, { timeout: 120000 });
  const rows = r.ok ? asArray(r.data) : [];
  const items = rows.map((v) => ({
    kind: 'startup',
    name: v.name,
    target: v.data || '',
    container: v.key,
    regPath: registry.toRegPath(v.key),
    valueName: v.name,
    scope: v.scope,
  }));
  return { items, error: r.ok ? null : r.error || r.stderr };
}

async function listStartupFolder() {
  const roots = [
    path.join(paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    path.join(paths.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
  ];
  const items = [];
  for (const dir of roots) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.(lnk|url|bat|cmd|exe)$/i.test(e.name)) continue;
      items.push({
        kind: 'startup',
        name: e.name,
        target: path.join(dir, e.name),
        container: dir,
        isFile: true,
        scope: dir.toLowerCase().startsWith(paths.programData.toLowerCase()) ? 'machine' : 'user',
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Shell extensions / context menu handlers
// ---------------------------------------------------------------------------

const SHELLEX_SCRIPT = String.raw`
$targets = @(
  'HKEY_CLASSES_ROOT\*\shellex\ContextMenuHandlers',
  'HKEY_CLASSES_ROOT\Directory\shellex\ContextMenuHandlers',
  'HKEY_CLASSES_ROOT\Directory\Background\shellex\ContextMenuHandlers',
  'HKEY_CLASSES_ROOT\Folder\shellex\ContextMenuHandlers',
  'HKEY_CLASSES_ROOT\AllFilesystemObjects\shellex\ContextMenuHandlers',
  'HKEY_CLASSES_ROOT\Drive\shellex\ContextMenuHandlers',
  'HKEY_CLASSES_ROOT\*\shellex\PropertySheetHandlers',
  'HKEY_CLASSES_ROOT\Directory\shellex\PropertySheetHandlers'
)
$result = foreach ($t in $targets) {
  $key = "Registry::$t"
  Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue | ForEach-Object {
    $handler = $_
    $clsid = ''
    try { $clsid = [string](Get-ItemProperty -LiteralPath $handler.PSPath -ErrorAction SilentlyContinue).'(default)' } catch { }
    if (-not $clsid) { $clsid = [string]$handler.PSChildName }
    $dll = ''
    foreach ($clsRoot in @('HKEY_CLASSES_ROOT','HKEY_CURRENT_USER\SOFTWARE\Classes')) {
      if ($dll) { break }
      foreach ($srv in @('InprocServer32','LocalServer32')) {
        try {
          $v = (Get-ItemProperty -LiteralPath "Registry::$clsRoot\CLSID\$clsid\$srv" -ErrorAction SilentlyContinue).'(default)'
          if ($v) { $dll = [string]$v; break }
        } catch { }
      }
    }
    [pscustomobject]@{
      scope       = $t
      handlerName = [string]$handler.PSChildName
      handlerKey  = [string]$handler.PSPath
      clsid       = $clsid
      dllPath     = $dll
    }
  }
}
`;

async function listShellExtensions() {
  const r = await psJson(SHELLEX_SCRIPT, { timeout: 180000 });
  if (!r.ok) return { items: [], error: r.error || r.stderr };
  const rows = asArray(r.data);
  return {
    items: rows.map((s) => ({
      kind: 'shellex',
      name: s.handlerName,
      scope: s.scope,
      clsid: s.clsid,
      target: s.dllPath || '',
      regPath: registry.toRegPath(s.handlerKey),
      clsidKey: s.clsid ? `HKCR\\CLSID\\${s.clsid}` : '',
    })),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Whole-registry references to a path
// ---------------------------------------------------------------------------

const REF_ROOTS = [
  'HKLM\\SOFTWARE',
  'HKLM\\SOFTWARE\\Classes',
  'HKLM\\SOFTWARE\\WOW6432Node',
  'HKCU\\SOFTWARE',
  'HKCU\\SOFTWARE\\Classes',
];

/**
 * Native recursive registry search for every key whose data mentions the given
 * path. This is how we catch COM registrations, shell integration, browser
 * helper objects and similar "dependencies" that are not keyed on a name.
 */
async function scanRegistryReferences(needles, opts = {}) {
  const list = (Array.isArray(needles) ? needles : [needles]).filter((n) => n && n.length > 6);
  if (!list.length) return { items: [], error: null };

  const found = new Map();
  for (const needle of list) {
    for (const root of REF_ROOTS) {
      const r = await run(tools.reg, ['query', root, '/s', '/f', needle, '/d'], {
        timeout: opts.timeout ?? 120000,
      });
      if (!r.stdout) continue;
      let currentKey = null;
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (/^HKEY_|^HK(LM|CU|CR|U|CC)\\/i.test(line) && !/\s{2,}REG_/.test(line)) {
          currentKey = line;
          continue;
        }
        if (currentKey && line.toLowerCase().includes(needle.toLowerCase())) {
          const key = registry.toRegPath(currentKey);
          if (!found.has(key.toLowerCase())) {
            found.set(key.toLowerCase(), { path: key, needle, matchedValue: line.slice(0, 300) });
          }
        }
      }
    }
  }
  return { items: [...found.values()], error: null };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function scoreItem(item, candidates, excludeNames, installLocation) {
  let best = { score: 0, matchedOn: null, conflict: null };

  if (installLocation && item.target && isPathInside(installLocation, item.target.replace(/^"|"$/g, ''))) {
    best = { score: 3, matchedOn: 'inside install folder', conflict: null };
  }
  if (installLocation && item.arguments && item.arguments.toLowerCase().includes(installLocation.toLowerCase())) {
    best = { score: 3, matchedOn: 'command line', conflict: null };
  }

  for (const c of candidates) {
    const s = matchScore(c.value, item.name);
    if (s && s * c.weight > best.score) best = { score: s * c.weight, matchedOn: c.value, conflict: null };
  }
  if (installLocation && item.target && item.target.toLowerCase().includes(installLocation.toLowerCase()) && best.score < 3) {
    best = { score: 3, matchedOn: 'references install folder', conflict: null };
  }

  if (best.score >= 1.6) {
    for (const other of excludeNames) {
      if (compactKey(other) === compactKey(item.name)) {
        const exact = candidates.some((c) => compactKey(c.value) === compactKey(item.name));
        if (!exact) best.conflict = other;
        break;
      }
    }
  }
  return best;
}

function toFinding(item, best) {
  const confidence = confidenceOf(best.score);
  return {
    ...item,
    id: `${item.kind}:${(item.regPath || item.name || item.target || '').toLowerCase()}`,
    score: Math.round(best.score * 100) / 100,
    confidence,
    checked: confidence === 'high' && !best.conflict,
    conflict: best.conflict || null,
    matchedOn: best.matchedOn || '',
    admin:
      item.kind === 'service' ||
      item.kind === 'task' ||
      (item.regPath ? registry.isMachineScope(item.regPath) : false),
  };
}

async function scanSystem(target, candidates, excludeNames) {
  const install = target.installLocation || '';
  const [services, tasks, runEntries, startupFiles, shellex] = await Promise.all([
    listServices(),
    listScheduledTasks(),
    listRunEntries(),
    listStartupFolder(),
    listShellExtensions(),
  ]);

  const all = [
    ...services.items,
    ...tasks.items,
    ...runEntries.items,
    ...startupFiles,
    ...shellex.items,
  ];

  const findings = [];
  for (const item of all) {
    const best = scoreItem(item, candidates, excludeNames, install);
    if (best.score <= 0) continue;
    findings.push(toFinding(item, best));
  }

  findings.sort((a, b) => b.score - a.score);
  const errors = [services.error, tasks.error, runEntries.error, shellex.error].filter(Boolean);
  return { findings, errors };
}

module.exports = {
  listServices,
  listScheduledTasks,
  listRunEntries,
  listStartupFolder,
  listShellExtensions,
  scanRegistryReferences,
  scanSystem,
};
