'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');

const { psJson, asArray } = require('../util/ps');
const { readImports } = require('../util/pe');

/**
 * A "shared runtime" is a redistributable that many products link against. We
 * can prove a runtime is still required by statically reading the import tables
 * of the executables belonging to the *other* installed products.
 */
const SIGNATURES = [
  {
    kind: 'vcredist',
    label: 'Microsoft Visual C++ Redistributable',
    product: /visual c\+\+.*redistributable/i,
    needs: /^(vcruntime\d*|msvcp\d*|msvcr\d*|mfc\d+|concrt\d*|atl\d*)\.dll$/i,
    why: 'links against the Visual C++ runtime',
  },
  {
    kind: 'dotnetfx',
    label: '.NET Framework',
    product: /microsoft \.net framework/i,
    needs: /^(mscoree|mscorlib|clr)\.dll$/i,
    needsDotNet: true,
    why: 'is a .NET Framework application',
  },
  {
    kind: 'dotnet',
    label: '.NET Runtime',
    product: /(microsoft \.net (runtime|host|asp\.net|windows desktop runtime|sdk)|\.net runtime)/i,
    needs: /^(hostfxr|hostpolicy|coreclr|clrjit)\.dll$/i,
    why: 'is a modern .NET application',
  },
  {
    kind: 'java',
    label: 'Java Runtime',
    product: /(java|jre|jdk|temurin|zulu|corretto|openjdk).*(runtime|se|jre|jdk|development kit)?/i,
    productExclude: /(javascript|script|plugin.*browser|update|autoupdater)/i,
    needs: /^(jvm|jawt|java)\.dll$/i,
    why: 'links against the Java VM',
  },
  {
    kind: 'webview2',
    label: 'Microsoft Edge WebView2 Runtime',
    product: /webview2/i,
    needs: /^webview2loader\.dll$/i,
    why: 'embeds WebView2',
  },
];

const EXE_CAP_PER_APP = 200;
const FILE_CAP_TOTAL = 6000;

function signatureFor(name) {
  return SIGNATURES.find((s) => s.product.test(name) && !(s.productExclude && s.productExclude.test(name))) || null;
}

/**
 * Installed redistributables plus .NET Framework versions (which do not
 * register an uninstaller). `apps` is the merged inventory; every registry
 * record is considered, but `appId` points at the merged entry so the UI can
 * launch the uninstall wizard for it.
 */
async function listRuntimes(apps) {
  const runtimes = [];

  for (const app of apps) {
    for (const rec of app.registry || []) {
      const sig = signatureFor(rec.name);
      if (!sig) continue;
      runtimes.push({
        id: `runtime:${sig.kind}:${rec.id}`,
        kind: sig.kind,
        label: sig.label,
        name: rec.name,
        version: rec.version,
        publisher: rec.publisher,
        installLocation: rec.installLocation,
        architecture: /\(x86\)|\bx86\b|32-bit/i.test(rec.name) ? 'x86' : 'x64',
        appId: app.id,
        canUninstall: Boolean(rec.uninstallString || rec.windowsInstaller),
        uninstallString: rec.uninstallString,
        quietUninstallString: rec.quietUninstallString,
        windowsInstaller: rec.windowsInstaller,
        regPath: rec.regPath,
        isMachineScope: rec.isMachineScope,
        why: sig.why,
        needsPattern: sig.needs.source,
        needsDotNet: Boolean(sig.needsDotNet),
      });
    }
  }

  // .NET Framework lives under its own registry branch, not the Uninstall keys.
  const ndp = await psJson(`
    $result = @()
    $base = 'HKLM:\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP'
    if (Test-Path $base) {
      foreach ($v in @('v4\\Full','v4\\Client','v2.0.50727')) {
        $p = Join-Path $base $v
        $item = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
        if ($item -and $item.Version) {
          $result += [pscustomobject]@{ branch = $v; version = [string]$item.Version; release = $item.Release }
        }
      }
    }
  `);
  if (ndp.ok) {
    // v4\Full and v4\Client report the same install; list each version once.
    const seenVersions = new Set();
    for (const row of asArray(ndp.data)) {
      if (!row || !row.version || seenVersions.has(row.version)) continue;
      seenVersions.add(row.version);
      runtimes.push({
        id: `runtime:dotnetfx:${row.branch}`,
        kind: 'dotnetfx',
        label: '.NET Framework',
        name: `.NET Framework ${row.version}`,
        version: row.version,
        publisher: 'Microsoft Corporation',
        installLocation: path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64'),
        architecture: 'x64',
        appId: null,
        canUninstall: false,
        isMachineScope: true,
        why: 'is a .NET Framework application',
        needsPattern: SIGNATURES.find((s) => s.kind === 'dotnetfx').needs.source,
        needsDotNet: true,
        systemComponent: true,
      });
    }
  }

  runtimes.sort((a, b) => a.label.localeCompare(b.label) || String(b.version).localeCompare(String(a.version)));
  return runtimes;
}

async function walkExes(dir, cap) {
  const out = [];
  const stack = [{ dir, depth: 0 }];
  while (stack.length && out.length < cap) {
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
        if (depth + 1 <= 6) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) {
        // DLLs matter for e.g. plugins that are the only VC++ consumer.
        out.push(full);
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

let usageCache = null;

/**
 * Read the import tables of every other installed product's binaries and work
 * out which runtimes are still referenced.
 */
async function computeUsage(runtimes, apps, options = {}) {
  const { onProgress = () => {}, excludeAppIds = [] } = options;
  if (usageCache && !options.force && usageCache.stamp === stampFor(apps)) {
    return usageCache.result;
  }

  const excluded = new Set(excludeAppIds);

  const scannable = apps.filter((app) => {
    if (excluded.has(app.id)) return false;
    if (!app.installLocation) return false;
    // Do not let a runtime product "depend on itself".
    if (signatureFor(app.name)) return false;
    return true;
  });

  const consumers = [];
  let filesRead = 0;
  let scannedApps = 0;

  for (const app of scannable) {
    if (filesRead >= FILE_CAP_TOTAL) break;
    let stat;
    try {
      stat = await fsp.stat(app.installLocation);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const exes = await walkExes(app.installLocation, EXE_CAP_PER_APP);
    if (!exes.length) continue;

    const imports = new Set();
    let hasDotNetEntry = false;
    let hasRuntimeConfig = false;

    for (const file of exes) {
      if (filesRead >= FILE_CAP_TOTAL) break;
      filesRead += 1;
      const r = readImports(file);
      if (!r.ok) continue;
      for (const imp of r.imports) imports.add(imp);
      if (r.isDotNet) hasDotNetEntry = true;
    }

    try {
      const entries = await fsp.readdir(app.installLocation).catch(() => []);
      hasRuntimeConfig = entries.some((e) => /\.runtimeconfig\.json$/i.test(e));
    } catch {
      /* ignore */
    }

    consumers.push({
      appId: app.id,
      appName: app.name,
      installLocation: app.installLocation,
      imports,
      hasDotNetEntry,
      hasRuntimeConfig,
      isDotNetFramework: imports.has('mscoree.dll'),
    });

    scannedApps += 1;
    onProgress({ phase: 'runtimes', scannedApps, totalApps: scannable.length, filesRead });
  }

  const result = {};
  for (const runtime of runtimes) {
    const pattern = new RegExp(runtime.needsPattern, 'i');
    const users = [];
    for (const consumer of consumers) {
      let hit = null;
      for (const imp of consumer.imports) {
        if (pattern.test(imp)) {
          hit = imp;
          break;
        }
      }
      if (!hit && runtime.needsDotNet && (consumer.hasDotNetEntry || consumer.isDotNetFramework)) {
        hit = 'CLR';
      }
      if (!hit && runtime.kind === 'dotnet' && consumer.hasRuntimeConfig) hit = '*.runtimeconfig.json';
      if (hit) users.push({ appId: consumer.appId, appName: consumer.appName, evidence: hit });
    }
    result[runtime.id] = {
      runtimeId: runtime.id,
      users,
      scannedApps,
      filesRead,
      status: users.length ? 'in-use' : scannedApps ? 'no-known-dependents' : 'unknown',
    };
  }

  usageCache = { stamp: stampFor(apps), result };
  return result;
}

function stampFor(apps) {
  return apps.map((a) => `${a.id}|${a.installLocation}`).join(';');
}

async function analyzeRuntimes(apps, options = {}) {
  const runtimes = await listRuntimes(apps);
  const usage = await computeUsage(runtimes, apps, options);
  return runtimes.map((r) => {
    const u = usage[r.id] || { users: [], status: 'unknown' };
    return {
      ...r,
      users: u.users,
      status: u.status,
      scannedApps: u.scannedApps,
      filesRead: u.filesRead,
      // A runtime with no proven dependents is a *candidate*, never an
      // automatic deletion: drivers, store apps and plugins may use it.
      removable: r.canUninstall && u.status === 'no-known-dependents',
    };
  });
}

module.exports = { listRuntimes, analyzeRuntimes, computeUsage, SIGNATURES, signatureFor };
