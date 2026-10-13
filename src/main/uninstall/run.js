'use strict';

const fs = require('node:fs');

const path = require('node:path');

const { run } = require('../util/exec');
const { tools, wingetPath } = require('../util/paths');
const { psJson, tempFile, asArray } = require('../util/ps');
const { isAdmin, runElevatedCmd, runElevatedPs, writeBatchFile, lit } = require('../util/elevate');
const registry = require('../util/registry');

const MSI_SUCCESS = new Set([0, 1605, 1614, 1641, 3010]);
const WINGET_SUCCESS = new Set([0]);
// 0x8A15002B APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND (already gone)
const WINGET_ALREADY_GONE = -1978335189;

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

function stopProcessesScript(installLocation) {
  // Trailing separator so "C:\Apps\Foo" does not also match "C:\Apps\FooBar".
  const prefix = String(installLocation).replace(/[\\/]+$/, '').toLowerCase() + path.sep;
  return `
$loc = ${lit(prefix)}
$result = @()
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($loc)
} | ForEach-Object {
  $proc = $_
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    $result += [pscustomobject]@{ pid = $proc.ProcessId; name = [string]$proc.Name; stopped = $true; error = '' }
  } catch {
    $result += [pscustomobject]@{ pid = $proc.ProcessId; name = [string]$proc.Name; stopped = $false; error = $_.Exception.Message }
  }
}
`;
}

async function stopProcessesIn(installLocation, options = {}) {
  if (!installLocation) return { stopped: [], failed: [] };
  const script = stopProcessesScript(installLocation);
  const r = options.elevated === true ? await runElevatedPs(script) : await psJson(script, { timeout: 60000 });
  const rows = asArray(r.data);
  return {
    stopped: rows.filter((x) => x.stopped),
    failed: rows.filter((x) => !x.stopped),
  };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Run a Windows command line from a temporary batch file. Using a batch file
 * sidesteps the nested-quoting problems of passing vendor uninstall strings
 * through cmd.exe. `start /wait` keeps the console hidden while still showing
 * any installer UI.
 */
async function runCommandLine(commandLine, opts = {}) {
  const bat = writeBatchFile(tempFile('.cmd'), [`start "" /wait ${commandLine}`, 'exit /b %errorlevel%']);
  try {
    return await run(tools.cmd, ['/d', '/s', '/c', bat], {
      timeout: opts.timeout ?? 0,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(bat, { force: true });
  }
}

/** msiexec writes UTF-16LE logs on some systems; decode by BOM. */
function readLogText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  return buf.toString('utf8');
}

async function runWingetUninstall(wingetId, opts = {}) {
  return run(
    wingetPath(),
    [
      'uninstall',
      '--id',
      wingetId,
      '--exact',
      '--silent',
      '--disable-interactivity',
      '--accept-source-agreements',
    ],
    { timeout: opts.timeout ?? 900000, maxBuffer: 32 * 1024 * 1024 },
  );
}

function appxScript(packageFullName, allUsers) {
  if (allUsers) {
    return `
$full = ${lit(packageFullName)}
$base = $full
if ($full -match '^(.+?)_[0-9a-fA-F]{16}$') { $base = $matches[1] }
$removed = 0
try {
  Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue |
    Where-Object { $_.PackageFullName -eq $full } |
    ForEach-Object {
      Remove-AppxPackage -Package $_.PackageFullName -AllUsers -ErrorAction Stop
      $removed++
    }
} catch { }
try {
  Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue |
    Where-Object { $_.PackageName -eq $full -or $_.DisplayName -eq $base } |
    ForEach-Object { Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName -ErrorAction Stop; $removed++ }
} catch { }
$result = [pscustomobject]@{ removed = $removed; name = $full }
`;
  }
  return `
$name = ${lit(packageFullName)}
Remove-AppxPackage -Package $name -ErrorAction Stop
$result = [pscustomobject]@{ removed = 1; name = $name }
`;
}

async function runAppxRemove(packageFullName, allUsers) {
  if (allUsers) {
    const r = await runElevatedPs(appxScript(packageFullName, true));
    return { ok: r.ok, blocked: r.blocked, error: r.error, data: r.data };
  }
  const r = await psJson(appxScript(packageFullName, false), { timeout: 300000 });
  return { ok: r.ok, error: r.ok ? null : r.error || r.stderr, data: r.data };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyRemoved(app) {
  const reasons = [];

  for (const r of app.registry || []) {
    if (await registry.keyExists(r.regPath)) reasons.push(`Registry uninstall entry remains: ${r.regPath}`);
  }

  if (app.packageFullName) {
    const check = await psJson(`
      $full = ${lit(app.packageFullName)}
      $p = Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.PackageFullName -eq $full }
      $result = [pscustomobject]@{ present = [bool]$p }
    `);
    if (check.ok && check.data && check.data.present === true) reasons.push('MSIX package is still registered');
  }

  if (app.installLocation) {
    const exists = fs.existsSync(app.installLocation);
    if (exists) reasons.push(`Install folder still exists: ${app.installLocation}`);
  }

  return { removed: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function executeUninstall(app, plan, options = {}) {
  const { onEvent = () => {}, allUsers = false, stopRunningProcesses = true } = options;
  const admin = await isAdmin();
  const elevated = plan.needsAdmin && !admin;

  const result = {
    appId: app.id,
    name: app.name,
    method: plan.method,
    elevated,
    blocked: false,
    steps: [],
    ok: false,
    code: null,
    output: '',
    verification: null,
    stoppedProcesses: [],
    needsUserConfirmation: false,
  };

  const step = (id, status, detail) => {
    const entry = { id, status, detail: detail || '', at: Date.now() };
    result.steps.push(entry);
    onEvent({ type: 'step', ...entry });
  };

  if (stopRunningProcesses && plan.installLocation) {
    step('stop-processes', 'running');
    try {
      const sp = await stopProcessesIn(plan.installLocation, { elevated });
      result.stoppedProcesses = sp.stopped;
      step(
        'stop-processes',
        'done',
        sp.stopped.length ? `Closed ${sp.stopped.length} process(es): ${sp.stopped.map((p) => p.name).join(', ')}` : 'No running processes found.',
      );
    } catch (e) {
      step('stop-processes', 'warning', e.message);
    }
  }

  step('uninstall', 'running', plan.command);

  try {
    switch (plan.method) {
      case 'msi-silent': {
        const logFile = tempFile('.log');
        if (elevated) {
          const r = await runElevatedCmd(`"${tools.msiexec}" /x${plan.msiProductCode} /qn /norestart /l*v "${logFile}"`);
          result.code = r.code;
          // A null code means the launcher could not read it back; verification decides.
          result.ok = r.ok && (r.code === null || MSI_SUCCESS.has(r.code));
          result.output = r.error || '';
          if (r.blocked) result.blocked = true;
        } else {
          const r = await run(tools.msiexec, [`/x${plan.msiProductCode}`, '/qn', '/norestart', '/l*v', logFile], {
            timeout: 1800000,
          });
          result.code = r.code;
          result.ok = MSI_SUCCESS.has(r.code);
          result.output = r.stdout + r.stderr;
        }
        try {
          result.output += `\n--- verbose log: ${logFile} ---\n` + readLogText(logFile).slice(-8000);
        } catch {
          /* log may not exist */
        }
        break;
      }

      case 'vendor-quiet':
      case 'vendor-interactive': {
        const r = elevated
          ? await runElevatedCmd(plan.command)
          : await runCommandLine(plan.command, { timeout: 3600000 });
        result.ok = r.ok && (r.code === null || r.code === 0);
        result.code = r.code;
        result.output = r.stdout || r.stderr || r.error || '';
        if (r.blocked) result.blocked = true;
        break;
      }

      case 'url': {
        const r = await runCommandLine(plan.command, { timeout: 60000 });
        result.ok = r.ok;
        result.output = r.stdout || r.stderr || r.error || '';
        result.needsUserConfirmation = true;
        break;
      }

      case 'winget': {
        const r = await runWingetUninstall(plan.wingetId, { timeout: 1800000 });
        result.code = r.code;
        result.ok = WINGET_SUCCESS.has(r.code) || r.code === WINGET_ALREADY_GONE;
        result.output = r.stdout + r.stderr;
        break;
      }

      case 'appx': {
        const r = await runAppxRemove(plan.packageFullName, allUsers);
        result.ok = r.ok;
        result.output = r.error || JSON.stringify(r.data || {});
        if (r.blocked) result.blocked = true;
        break;
      }

      default:
        result.ok = false;
        result.output = 'Unsupported removal method.';
    }
  } catch (e) {
    result.ok = false;
    result.output = String(e && e.message);
  }

  step('uninstall', result.ok ? 'done' : 'error', result.output.slice(-2000));

  // Vendor uninstallers can return before their child process finishes; give
  // the system a moment before judging success. Skip the wait entirely when the
  // UAC prompt was cancelled — nothing ran.
  step('verify', 'running');
  let verification = null;
  if (plan.method !== 'url' && !result.blocked) {
    for (let i = 0; i < 12; i += 1) {
      verification = await verifyRemoved(app).catch((e) => ({ removed: false, reasons: [e.message] }));
      if (verification.removed) break;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
  result.verification = verification || { removed: false, reasons: ['Not verified (interactive uninstaller).'] };
  step(
    'verify',
    result.verification.removed ? 'done' : 'warning',
    result.verification.removed ? 'The application is no longer registered.' : result.verification.reasons.join(' '),
  );

  return result;
}

module.exports = {
  executeUninstall,
  stopProcessesIn,
  verifyRemoved,
  runCommandLine,
  runWingetUninstall,
  runAppxRemove,
  MSI_SUCCESS,
};
