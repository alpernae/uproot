'use strict';

const { extractPathsFromCommandLine } = require('../util/names');

const MSI_CODE_RE = /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/;

function extractMsiProductCode(command) {
  const m = String(command || '').match(MSI_CODE_RE);
  return m ? m[0] : null;
}

function isMsiCommand(command) {
  return /msiexec(\.exe)?\s/i.test(String(command || '')) && Boolean(extractMsiProductCode(command));
}

function isUrlCommand(command) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(command || '').trim());
}

function primaryRegistry(app) {
  return (app.registry || []).find((r) => r.uninstallString || r.quietUninstallString || r.windowsInstaller) || (app.registry || [])[0] || null;
}

/**
 * Decide how an application should be removed. Preference order favours
 * unattended removal, but the vendor's own uninstaller is always used rather
 * than deleting files behind its back.
 */
function buildPlan(app, options = {}) {
  const reg = primaryRegistry(app);
  const notes = [];
  const steps = [];

  const canAppx = Boolean(app.packageFullName);
  const wingetId = app.wingetId;
  const wingetUsable = Boolean(wingetId) && !/^(ARP|MSIX)\\/i.test(wingetId);

  let msiSource = null;
  if (reg) {
    if (isMsiCommand(reg.quietUninstallString)) msiSource = reg.quietUninstallString;
    else if (isMsiCommand(reg.uninstallString)) msiSource = reg.uninstallString;
  }
  const msiCode = msiSource ? extractMsiProductCode(msiSource) : null;

  let method = null;
  let command = '';
  let interactive = false;

  if (canAppx && options.preferAppx !== false) {
    method = 'appx';
    command = 'Remove-AppxPackage';
    notes.push('Store / MSIX package. Removed for the current user; use "all users" to also remove the provisioned copy.');
  } else if (msiCode) {
    method = 'msi-silent';
    command = `msiexec.exe /x${msiCode}`;
    notes.push(`Windows Installer product ${msiCode}.`);
  } else if (reg && reg.quietUninstallString && !isUrlCommand(reg.quietUninstallString)) {
    method = 'vendor-quiet';
    command = reg.quietUninstallString;
    notes.push("Runs the vendor's silent uninstall command.");
  } else if (wingetUsable && options.allowWinget !== false) {
    method = 'winget';
    command = `winget uninstall --id "${wingetId}" --exact --silent --disable-interactivity --accept-source-agreements`;
    notes.push(`Windows Package Manager identifier ${wingetId}.`);
  } else if (reg && reg.uninstallString && !isUrlCommand(reg.uninstallString)) {
    method = 'vendor-interactive';
    command = reg.uninstallString;
    interactive = true;
    notes.push("No silent switch is registered, so the vendor's uninstall wizard will open and you must complete it.");
  } else if (reg && (isUrlCommand(reg.uninstallString) || isUrlCommand(reg.quietUninstallString))) {
    method = 'url';
    command = (reg.quietUninstallString || reg.uninstallString).trim();
    interactive = true;
    notes.push('This application uninstalls through a registered protocol handler (for example a game launcher).');
  } else if (canAppx) {
    method = 'appx';
    command = 'Remove-AppxPackage';
  } else if (wingetUsable) {
    method = 'winget';
    command = `winget uninstall --id "${wingetId}" --exact --silent --disable-interactivity --accept-source-agreements`;
  }

  if (!method) {
    return {
      appId: app.id,
      name: app.name,
      method: null,
      command: '',
      interactive: false,
      needsAdmin: false,
      possible: false,
      notes: ['No uninstall command is registered for this entry. Only leftover traces can be removed.'],
      steps,
      target: app,
    };
  }

  const paths = extractPathsFromCommandLine(command);
  const executable = paths.find((p) => /\.(exe|com|bat|cmd)$/i.test(p)) || (method === 'msi-silent' ? 'msiexec.exe' : '');

  const needsAdmin =
    Boolean(reg && reg.isMachineScope) ||
    app.needsAdmin === true ||
    /program files|programdata/i.test(String(app.installLocation || ''));

  const force = canAppx && options.force === true;
  if (force) {
    notes.push(
      'System override is on: the package is removed for every user account and the provisioned copy is taken out of new profiles. This needs a UAC prompt.',
    );
  }

  steps.push({ id: 'stop-processes', label: 'Close any running processes from the install folder' });
  steps.push({ id: 'uninstall', label: `Run ${method}` });
  steps.push({ id: 'verify', label: 'Verify the application was removed' });
  steps.push({ id: 'leftovers', label: 'Find leftover files, registry keys and dependencies' });

  return {
    appId: app.id,
    name: app.name,
    version: app.version,
    publisher: app.publisher,
    method,
    command,
    executable,
    interactive,
    needsAdmin,
    possible: true,
    silent: !interactive,
    force,
    msiProductCode: msiCode,
    wingetId: wingetUsable ? wingetId : null,
    packageFullName: app.packageFullName || null,
    installLocation: app.installLocation || '',
    registryKeys: (app.registry || []).map((r) => r.regPath),
    notes,
    steps,
  };
}

module.exports = { buildPlan, extractMsiProductCode, isMsiCommand, isUrlCommand };
