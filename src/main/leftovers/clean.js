'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { run, nextId } = require('../util/exec');
const { paths, tools, isMachinePath } = require('../util/paths');
const { tempFile, writeScriptFile, psLiteral, PS_FLAGS } = require('../util/ps');
const { isAdmin, runElevatedPs } = require('../util/elevate');
const registry = require('../util/registry');

// Batch ids come from nextId('batch'); anything else could escape the store.
const BATCH_ID_RE = /^batch-[a-z0-9]+-\d+$/;

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/** Directories that must never themselves be a cleanup target. */
function protectedRoots() {
  const list = [
    paths.systemDrive,
    paths.windows,
    paths.system32,
    path.join(paths.windows, 'SysWOW64'),
    paths.programFiles,
    paths.programFilesX86,
    paths.programData,
    paths.appData,
    paths.localAppData,
    paths.userProfile,
    path.join(paths.systemDrive, 'Users'),
    path.join(paths.userProfile, 'Desktop'),
    path.join(paths.userProfile, 'Documents'),
    path.join(paths.userProfile, 'Downloads'),
    path.join(paths.appData, 'Microsoft'),
    path.join(paths.localAppData, 'Microsoft'),
    path.join(paths.localAppData, 'Packages'),
    path.join(paths.programData, 'Microsoft'),
  ];
  return list.filter(Boolean).map((p) => path.resolve(p).toLowerCase());
}

const PROTECTED = protectedRoots();

function assertSafeToDelete(target, quarantineDir) {
  if (!target || typeof target !== 'string') throw new Error('Empty path');
  const resolved = path.resolve(target);
  const lower = resolved.toLowerCase();
  const parsed = path.parse(resolved);

  if (parsed.root === resolved) throw new Error(`Refusing to delete a drive root: ${resolved}`);
  if (parsed.dir === parsed.root) throw new Error(`Refusing to delete a top-level directory: ${resolved}`);
  if (PROTECTED.includes(lower)) throw new Error(`Refusing to delete a protected system directory: ${resolved}`);
  if (quarantineDir && lower.startsWith(path.resolve(quarantineDir).toLowerCase())) {
    throw new Error(`Refusing to delete inside the quarantine store: ${resolved}`);
  }
  for (const root of PROTECTED) {
    if (root.startsWith(lower + path.sep)) {
      throw new Error(`Refusing to delete an ancestor of a protected directory: ${resolved}`);
    }
  }
  const leaf = path.basename(resolved);
  if (leaf === '.' || leaf === '..' || leaf.length < 2) throw new Error(`Refusing to delete: ${resolved}`);
  return resolved;
}

/** Resolve a batch directory, refusing ids that are not ones we generated. */
function batchDirFor(quarantineDir, batchId) {
  if (!BATCH_ID_RE.test(String(batchId || ''))) throw new Error(`Invalid quarantine batch id: ${batchId}`);
  return path.join(quarantineDir, batchId);
}

/**
 * Manifests store absolute paths. Re-anchor anything that lived inside the
 * batch onto its current location so a batch keeps working if the data
 * directory moves (e.g. after the app was renamed).
 */
function rebaseIntoBatch(p, batchDir) {
  if (!p) return p;
  const marker = `${path.sep}${path.basename(batchDir)}${path.sep}`.toLowerCase();
  const idx = String(p).toLowerCase().lastIndexOf(marker);
  return idx < 0 ? p : path.join(batchDir, String(p).slice(idx + marker.length));
}

function quarantineDestFor(batchDir, target) {
  const parsed = path.parse(target);
  const drive = parsed.root.replace(/[:\\/]+/g, '') || 'X';
  const rel = target.slice(parsed.root.length);
  return path.join(batchDir, 'files', drive, rel);
}

// ---------------------------------------------------------------------------
// PowerShell worker
// ---------------------------------------------------------------------------

const WORKER = String.raw`
param([string]$JobFile, [string]$OutFile)

$ErrorActionPreference = 'Continue'
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$results = New-Object System.Collections.Generic.List[object]

function Take-RegistryOwnership {
  param([string]$RegPath)
  $parts = $RegPath -split '\\', 2
  if ($parts.Count -lt 2) { return $false }
  $hiveName = $parts[0].ToUpper()
  $sub = $parts[1]
  $hive = switch ($hiveName) {
    'HKLM' { [Microsoft.Win32.Registry]::LocalMachine }
    'HKCU' { [Microsoft.Win32.Registry]::CurrentUser }
    'HKCR' { [Microsoft.Win32.Registry]::ClassesRoot }
    'HKU'  { [Microsoft.Win32.Registry]::Users }
    default { $null }
  }
  if (-not $hive) { return $false }
  try {
    $key = $hive.OpenSubKey($sub, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]::TakeOwnership)
    if (-not $key) { return $false }
    $acl = $key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner)
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($me)
    $key.SetAccessControl($acl)
    $acl2 = $key.GetAccessControl()
    $rule = New-Object System.Security.AccessControl.RegistryAccessRule($me, 'FullControl', 'ContainerInherit', 'None', 'Allow')
    $acl2.SetAccessRule($rule)
    $key.SetAccessControl($acl2)
    $key.Close()
    return $true
  } catch { return $false }
}

function Remove-KeyForce {
  param([string]$RegPath, [string]$PsPath)
  try {
    Remove-Item -LiteralPath $PsPath -Recurse -Force -ErrorAction Stop
    return @{ ok = $true }
  } catch { }
  $null = Take-RegistryOwnership -RegPath $RegPath
  try {
    Get-ChildItem -LiteralPath $PsPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $null = Take-RegistryOwnership -RegPath ($_.Name -replace '^.*Registry::', '')
    }
  } catch { }
  try {
    Remove-Item -LiteralPath $PsPath -Recurse -Force -ErrorAction Stop
    return @{ ok = $true }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

function Grant-FileAccess {
  param([string]$Target)
  & takeown.exe /f "$Target" /r /d y 2>&1 | Out-Null
  & icacls.exe "$Target" /grant "*S-1-5-32-544:F" /t /c /q 2>&1 | Out-Null
}

function Remove-SysItem {
  param($sys)
  $type = [string]$sys.type
  if ($type -eq 'service') {
    $name = [string]$sys.name
    $backup = [string]$sys.backup
    $exported = $false
    if ($backup) {
      $parent = Split-Path -Parent $backup
      if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      & reg.exe export "HKLM\SYSTEM\CurrentControlSet\Services\$name" "$backup" /y 2>&1 | Out-Null
      $exported = Test-Path -LiteralPath $backup
    }
    try { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue } catch { }
    $p = Start-Process -FilePath 'sc.exe' -ArgumentList @('delete', $name) -NoNewWindow -Wait -PassThru
    return @{ ok = ($p.ExitCode -eq 0); error = if ($p.ExitCode -eq 0) { '' } else { "sc delete exit $($p.ExitCode)" }; backup = if ($exported) { $backup } else { '' } }
  }
  if ($type -eq 'task') {
    $taskName = [string]$sys.taskName
    $taskPath = [string]$sys.taskPath
    $backup = [string]$sys.backup
    $exported = $false
    if ($backup) {
      $parent = Split-Path -Parent $backup
      if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      try {
        $xml = Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
        if ($xml) { $xml | Out-File -LiteralPath $backup -Encoding UTF8; $exported = $true }
      } catch { }
    }
    try {
      Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
      return @{ ok = $true; error = ''; backup = if ($exported) { $backup } else { '' } }
    } catch {
      return @{ ok = $false; error = $_.Exception.Message; backup = '' }
    }
  }
  if ($type -eq 'registryValue') {
    $regPath = [string]$sys.regPath
    $psPath  = [string]$sys.psPath
    $value   = [string]$sys.valueName
    $backup  = [string]$sys.backup
    $exported = $false
    if ($backup) {
      $parent = Split-Path -Parent $backup
      if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      & reg.exe export "$regPath" "$backup" /y 2>&1 | Out-Null
      $exported = Test-Path -LiteralPath $backup
    }
    try {
      if (-not (Test-Path -LiteralPath $psPath)) { return @{ ok = $true; error = ''; backup = if ($exported) { $backup } else { '' } } }
      Remove-ItemProperty -LiteralPath $psPath -Name $value -Force -ErrorAction Stop
      return @{ ok = $true; error = ''; backup = if ($exported) { $backup } else { '' } }
    } catch {
      return @{ ok = $false; error = $_.Exception.Message; backup = '' }
    }
  }
  return @{ ok = $false; error = "Unsupported system type: $type"; backup = '' }
}

# Close processes that hold the target paths open.
foreach ($procName in @($job.processNames)) {
  if (-not $procName) { continue }
  try { Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
}

foreach ($file in @($job.files)) {
  $src = [string]$file.path
  if (-not $src) { continue }
  if (-not (Test-Path -LiteralPath $src)) {
    $results.Add([pscustomobject]@{ type = 'file'; path = $src; ok = $true; skipped = 'missing' })
    continue
  }
  $dest = [string]$file.dest
  $attempt = 0
  $done = $false
  $lastError = ''
  while ($attempt -lt 2 -and -not $done) {
    try {
      if ($job.mode -eq 'quarantine') {
        $parent = Split-Path -Parent $dest
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        if (Test-Path -LiteralPath $dest) { $dest = "$dest-" + (Get-Random) }
        Move-Item -LiteralPath $src -Destination $dest -Force -ErrorAction Stop
        $results.Add([pscustomobject]@{ type = 'file'; path = $src; ok = $true; movedTo = $dest })
      } else {
        Remove-Item -LiteralPath $src -Recurse -Force -ErrorAction Stop
        $results.Add([pscustomobject]@{ type = 'file'; path = $src; ok = $true; deleted = $true })
      }
      $done = $true
    } catch {
      $lastError = $_.Exception.Message
      if ($attempt -eq 0) { Grant-FileAccess -Target $src }
    }
    $attempt++
  }
  if (-not $done) {
    $results.Add([pscustomobject]@{ type = 'file'; path = $src; ok = $false; error = $lastError })
  }
}

foreach ($item in @($job.registry)) {
  $regPath = [string]$item.regPath
  $psPath = [string]$item.psPath
  if (-not $regPath) { continue }
  $backup = [string]$item.backup
  $exists = $false
  try { $exists = Test-Path -LiteralPath $psPath } catch { $exists = $false }
  if (-not $exists) {
    $results.Add([pscustomobject]@{ type = 'registry'; path = $regPath; ok = $true; skipped = 'missing' })
    continue
  }
  $exported = $false
  if ($backup) {
    try {
      $parent = Split-Path -Parent $backup
      if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      & reg.exe export "$regPath" "$backup" /y 2>&1 | Out-Null
      $exported = Test-Path -LiteralPath $backup
    } catch { $exported = $false }
  }
  $del = Remove-KeyForce -RegPath $regPath -PsPath $psPath
  if (-not $del.ok -and $backup) {
    & reg.exe delete "$regPath" /f 2>&1 | Out-Null
    $del = @{ ok = ($LASTEXITCODE -eq 0) }
  }
  $results.Add([pscustomobject]@{
    type    = 'registry'
    path    = $regPath
    ok      = [bool]$del.ok
    backup  = if ($exported) { $backup } else { '' }
    error   = if ($del.ok) { '' } else { [string]$del.error }
  })
}

foreach ($sys in @($job.system)) {
  $r = Remove-SysItem -sys $sys
  $results.Add([pscustomobject]@{
    type   = [string]$sys.type
    path   = if ([string]$sys.name) { [string]$sys.name } else { [string]$sys.regPath }
    ok     = [bool]$r.ok
    error  = [string]$r.error
    backup = [string]$r.backup
  })
}

$results | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $OutFile -Encoding UTF8
`;

let workerFile = null;

/** Write the worker script on first use rather than as a side effect of require(). */
function workerScript() {
  if (!workerFile) {
    fs.mkdirSync(paths.workDir, { recursive: true });
    workerFile = writeScriptFile(path.join(paths.workDir, 'clean-worker.ps1'), WORKER);
  }
  return workerFile;
}

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

async function runWorker(job, { elevated }) {
  const jobFile = tempFile('.json');
  const outFile = tempFile('.json');
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
  const worker = workerScript();
  try {
    let res;
    if (elevated) {
      const r = await runElevatedPs(
        `& ${psLiteral(worker)} -JobFile ${psLiteral(jobFile)} -OutFile ${psLiteral(outFile)}`,
      );
      if (!r.ok) return { ok: false, blocked: r.blocked, error: r.error, results: [] };
      res = { ok: true };
    } else {
      res = await run(tools.powershell, [...PS_FLAGS, '-File', worker, '-JobFile', jobFile, '-OutFile', outFile], {
        timeout: 3600000,
      });
    }
    const results = readJsonSafe(outFile);
    if (!results.length && !res.ok) {
      return { ok: false, error: res.error || res.stderr || 'Cleanup worker failed', results: [] };
    }
    return { ok: true, error: null, results };
  } finally {
    fs.rmSync(jobFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove the selected leftovers. Files are moved into a quarantine store by
 * default so the operation is reversible; registry keys are exported to .reg
 * files before deletion regardless of mode.
 */
async function executeCleanup({ files = [], registryKeys = [], system = [], quarantineDir, mode = 'quarantine', processNames = [], onProgress = () => {} }) {
  const admin = await isAdmin();
  const batchId = nextId('batch');
  const batchDir = path.join(quarantineDir, batchId);

  const filePlan = [];
  for (const item of files) {
    const resolved = assertSafeToDelete(item.path, quarantineDir);
    filePlan.push({
      path: resolved,
      dest: quarantineDestFor(batchDir, resolved),
      machine: isMachinePath(resolved),
    });
  }

  const regPlan = registryKeys.map((k, index) => {
    const regPath = registry.toRegPath(k.path || k);
    return {
      regPath,
      psPath: registry.toPsPath(regPath),
      backup: path.join(batchDir, 'registry', `${String(index).padStart(3, '0')}.reg`),
      machine: registry.isMachineScope(regPath),
    };
  });

  const sysPlan = system.map((s, index) => {
    const type = String(s.type || '');
    const ext = { service: '.reg', task: '.xml', registryValue: '.reg' }[type];
    if (!ext) throw new Error(`Unsupported system cleanup type: ${type}`);
    const backup = path.join(batchDir, 'registry', `sys-${String(index).padStart(3, '0')}${ext}`);
    if (type === 'service') {
      const name = String(s.name || '').trim();
      if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error(`Invalid service name: ${name}`);
      return { type, name, regPath: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${name}`, backup, machine: true };
    }
    if (type === 'task') {
      const taskName = String(s.taskName || '').trim();
      const taskPath = String(s.taskPath || '\\');
      if (!taskName) throw new Error('Missing scheduled task name');
      return { type, taskName, taskPath, backup, machine: true };
    }
    const regPath = registry.toRegPath(s.regPath);
    const valueName = String(s.valueName || '');
    if (!valueName) throw new Error('Missing registry value name');
    return {
      type,
      regPath,
      psPath: registry.toPsPath(regPath),
      valueName,
      backup,
      machine: registry.isMachineScope(regPath),
    };
  });

  const jobFor = (machine) => ({
    mode,
    quarantineDir,
    processNames,
    files: filePlan.filter((f) => f.machine === machine).map((f) => ({ path: f.path, dest: f.dest })),
    registry: regPlan.filter((r) => r.machine === machine),
    system: sysPlan.filter((x) => x.machine === machine),
  });
  const sizeOf = (job) => job.files.length + job.registry.length + job.system.length;

  const outcomes = [];
  const total = filePlan.length + regPlan.length + sysPlan.length;
  let done = 0;

  const manifest = {
    id: batchId,
    createdAt: Date.now(),
    mode,
    fileCount: filePlan.length,
    registryCount: regPlan.length,
    systemCount: sysPlan.length,
    files: filePlan,
    registry: regPlan,
    system: sysPlan,
    outcomes,
    succeeded: 0,
    failed: 0,
    complete: false,
  };
  const writeManifest = () => {
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  };
  // Written before anything moves, so an interrupted cleanup still leaves a
  // batch the Quarantine view can list and restore.
  writeManifest();

  for (const scope of ['user', 'machine']) {
    const job = jobFor(scope === 'machine');
    if (!sizeOf(job)) continue;
    // Machine-wide items need a UAC prompt unless we already run elevated.
    const r = await runWorker(job, { elevated: scope === 'machine' && !admin });
    if (!r.ok) outcomes.push({ ok: false, blocked: r.blocked === true, error: r.error, scope });
    else outcomes.push(...r.results.map((x) => ({ ...x, scope })));
    done += sizeOf(job);
    onProgress({ phase: 'clean', done, total, label: scope });
  }

  // The worker picks a fresh name when the quarantine destination is taken;
  // record where each file really went so restore can find it.
  const movedTo = new Map(outcomes.filter((o) => o.movedTo).map((o) => [String(o.path).toLowerCase(), o.movedTo]));
  for (const f of filePlan) {
    const actual = movedTo.get(f.path.toLowerCase());
    if (actual) f.dest = actual;
  }

  manifest.succeeded = outcomes.filter((o) => o.ok).length;
  manifest.failed = outcomes.filter((o) => !o.ok).length;
  manifest.complete = true;
  writeManifest();
  if (mode === 'delete') {
    fs.writeFileSync(path.join(batchDir, 'PURGED'), 'Delete mode: files were removed permanently. Registry backups are kept here.\n', 'utf8');
  }

  return manifest;
}

async function listQuarantine(quarantineDir) {
  let dirs = [];
  try {
    dirs = await fsp.readdir(quarantineDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const batches = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const manifestPath = path.join(quarantineDir, d.name, 'manifest.json');
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      batches.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        mode: manifest.mode,
        fileCount: manifest.fileCount,
        registryCount: manifest.registryCount,
        systemCount: manifest.systemCount || 0,
        succeeded: manifest.succeeded,
        failed: manifest.failed,
        purged: fs.existsSync(path.join(quarantineDir, d.name, 'PURGED')),
      });
    } catch {
      /* not a batch we manage */
    }
  }
  batches.sort((a, b) => b.createdAt - a.createdAt);
  return batches;
}

async function restoreBatch(quarantineDir, batchId) {
  const batchDir = batchDirFor(quarantineDir, batchId);
  const manifest = JSON.parse(await fsp.readFile(path.join(batchDir, 'manifest.json'), 'utf8'));
  const admin = await isAdmin();
  const inBatch = (p) => rebaseIntoBatch(p, batchDir);

  const fileRestores = manifest.files.map((f) => ({ from: inBatch(f.dest), to: f.path, machine: f.machine }));
  const regRestores = manifest.registry.map((r) => ({ regPath: r.regPath, backup: inBatch(r.backup), machine: r.machine }));
  const sysRestores = (manifest.system || []).map((s) => {
    const label = s.name || (s.type === 'task' ? `${s.taskPath || '\\'}${s.taskName}` : s.regPath || '');
    return {
      type: s.type,
      name: label,
      taskName: s.taskName,
      taskPath: s.taskPath,
      regPath: s.regPath,
      backup: inBatch(s.backup),
      machine: s.machine !== false,
    };
  });

  const script = `
$items = Get-Content -LiteralPath ${psLiteral(path.join(batchDir, 'restore-job.json'))} -Raw -Encoding UTF8 | ConvertFrom-Json
$results = New-Object System.Collections.Generic.List[object]
foreach ($f in @($items.files)) {
  try {
    if (-not (Test-Path -LiteralPath $f.from)) { $results.Add([pscustomobject]@{ type='file'; path=$f.to; ok=$false; error='quarantined copy missing' }); continue }
    $parent = Split-Path -Parent $f.to
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Move-Item -LiteralPath $f.from -Destination $f.to -Force -ErrorAction Stop
    $results.Add([pscustomobject]@{ type='file'; path=$f.to; ok=$true })
  } catch {
    $results.Add([pscustomobject]@{ type='file'; path=$f.to; ok=$false; error=$_.Exception.Message })
  }
}
foreach ($r in @($items.registry)) {
  try {
    if (-not (Test-Path -LiteralPath $r.backup)) { $results.Add([pscustomobject]@{ type='registry'; path=$r.regPath; ok=$false; error='backup missing' }); continue }
    & reg.exe import "$($r.backup)" 2>&1 | Out-Null
    $results.Add([pscustomobject]@{ type='registry'; path=$r.regPath; ok=($LASTEXITCODE -eq 0) })
  } catch {
    $results.Add([pscustomobject]@{ type='registry'; path=$r.regPath; ok=$false; error=$_.Exception.Message })
  }
}
foreach ($s in @($items.system)) {
  $label = if ([string]$s.name) { [string]$s.name } else { [string]$s.regPath }
  try {
    if (-not (Test-Path -LiteralPath $s.backup)) { $results.Add([pscustomobject]@{ type=[string]$s.type; path=$label; ok=$false; error='backup missing' }); continue }
    if ([string]$s.type -eq 'task') {
      $xml = Get-Content -LiteralPath $s.backup -Raw -Encoding UTF8
      Register-ScheduledTask -TaskName ([string]$s.taskName) -TaskPath ([string]$s.taskPath) -Xml $xml -Force -ErrorAction Stop | Out-Null
    } else {
      & reg.exe import "$($s.backup)" 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "reg import failed ($LASTEXITCODE)" }
    }
    $results.Add([pscustomobject]@{ type=[string]$s.type; path=$label; ok=$true })
  } catch {
    $results.Add([pscustomobject]@{ type=[string]$s.type; path=$label; ok=$false; error=$_.Exception.Message })
  }
}
$results | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath ${psLiteral(path.join(batchDir, 'restore-result.json'))} -Encoding UTF8
`;

  fs.writeFileSync(
    path.join(batchDir, 'restore-job.json'),
    JSON.stringify({ files: fileRestores, registry: regRestores, system: sysRestores }),
    'utf8',
  );

  const scriptFile = writeScriptFile(path.join(batchDir, 'restore.ps1'), script);

  const needsElevation = !admin && [...fileRestores, ...regRestores, ...sysRestores].some((x) => x.machine);
  const r = needsElevation
    ? await runElevatedPs(`& ${psLiteral(scriptFile)}`)
    : await run(tools.powershell, [...PS_FLAGS, '-File', scriptFile], { timeout: 1800000 });

  const results = readJsonSafe(path.join(batchDir, 'restore-result.json'));
  fs.rmSync(scriptFile, { force: true });
  fs.rmSync(path.join(batchDir, 'restore-job.json'), { force: true });
  fs.rmSync(path.join(batchDir, 'restore-result.json'), { force: true });

  return {
    ok: r.ok,
    blocked: r.blocked === true,
    error: r.ok ? null : r.error || r.stderr,
    results,
    restored: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
  };
}

async function purgeBatch(quarantineDir, batchId) {
  const resolved = path.resolve(batchDirFor(quarantineDir, batchId));
  // The worker takes ownership of files it cannot delete (quarantined machine
  // files keep their original ACLs); fall back to a plain rm for the rest.
  const job = { mode: 'delete', quarantineDir, processNames: [], files: [{ path: resolved, dest: '' }], registry: [], system: [] };
  const r = await runWorker(job, { elevated: false });
  if (fs.existsSync(resolved)) {
    await fsp.rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
  const removed = !fs.existsSync(resolved);
  return { ok: removed, error: removed ? null : r.error || 'Some quarantined files could not be deleted.', results: r.results };
}

module.exports = {
  executeCleanup,
  listQuarantine,
  restoreBatch,
  purgeBatch,
  assertSafeToDelete,
  quarantineDestFor,
  rebaseIntoBatch,
};
