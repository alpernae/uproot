'use strict';

const { psJson, asArray } = require('../util/ps');
const { toRegPath, hiveOf, isMachineScope } = require('../util/registry');

const SCRIPT = String.raw`
$roots = New-Object System.Collections.Generic.List[string]
$roots.Add('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
$roots.Add('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$roots.Add('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
$roots.Add('HKCU:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
try {
  Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -notmatch '_Classes$' } |
    ForEach-Object {
      $sid = $_.PSChildName
      $roots.Add("Registry::HKEY_USERS\$sid\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall")
      $roots.Add("Registry::HKEY_USERS\$sid\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")
    }
} catch { }

$result = foreach ($root in $roots) {
  Get-ItemProperty -Path ($root + '\*') -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName } |
    ForEach-Object {
      [pscustomobject]@{
        keyName                = [string]$_.PSChildName
        regPath                = [string]$_.PSPath
        displayName            = [string]$_.DisplayName
        displayVersion         = [string]$_.DisplayVersion
        publisher              = [string]$_.Publisher
        installLocation        = [string]$_.InstallLocation
        installSource          = [string]$_.InstallSource
        uninstallString        = [string]$_.UninstallString
        quietUninstallString   = [string]$_.QuietUninstallString
        modifyPath             = [string]$_.ModifyPath
        displayIcon            = [string]$_.DisplayIcon
        urlInfoAbout           = [string]$_.URLInfoAbout
        installDate            = [string]$_.InstallDate
        estimatedSizeKb        = $_.EstimatedSize
        windowsInstaller       = $_.WindowsInstaller
        systemComponent        = $_.SystemComponent
        noRemove               = $_.NoRemove
        releaseType            = [string]$_.ReleaseType
        parentKeyName          = [string]$_.ParentKeyName
        comments               = [string]$_.Comments
      }
    }
}
`;

function truthy(v) {
  return v === 1 || v === true || v === '1';
}

function cleanPath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/^"|"$/g, '');
  // "C:\path\icon.exe,0" -> "C:\path\icon.exe"
  if (/,\s*-?\d+\s*$/.test(s)) s = s.replace(/,\s*-?\d+\s*$/, '');
  return s.replace(/^"|"$/g, '').trim();
}

/**
 * Read every Uninstall key we can see: machine + current user + all loaded
 * user hives, in both the 64-bit and WOW6432Node (32-bit) views.
 */
async function listRegistryApps() {
  const r = await psJson(SCRIPT, { timeout: 120000 });
  if (!r.ok) {
    return { apps: [], error: r.error || r.stderr || 'Registry enumeration failed' };
  }
  const rows = asArray(r.data);
  const apps = [];
  for (const row of rows) {
    const regPath = toRegPath(row.regPath);
    if (!regPath) continue;
    const is32 = /\\WOW6432Node\\/i.test(regPath);
    const hive = hiveOf(regPath);
    const installLocation = cleanPath(row.installLocation);
    apps.push({
      id: `reg:${regPath}`,
      source: 'registry',
      regPath,
      keyName: row.keyName || regPath.split('\\').pop(),
      hive,
      view: is32 ? '32' : '64',
      isMachineScope: isMachineScope(regPath),
      name: String(row.displayName || '').trim(),
      version: String(row.displayVersion || '').trim(),
      publisher: String(row.publisher || '').trim(),
      installLocation,
      installSource: cleanPath(row.installSource),
      uninstallString: String(row.uninstallString || '').trim(),
      quietUninstallString: String(row.quietUninstallString || '').trim(),
      modifyPath: String(row.modifyPath || '').trim(),
      iconPath: cleanPath(row.displayIcon),
      url: String(row.urlInfoAbout || '').trim(),
      installDate: String(row.installDate || '').trim(),
      estimatedSizeKb: Number(row.estimatedSizeKb) || 0,
      windowsInstaller: truthy(row.windowsInstaller),
      isSystemComponent: truthy(row.systemComponent),
      noRemove: truthy(row.noRemove),
      releaseType: String(row.releaseType || '').trim(),
      parentKeyName: String(row.parentKeyName || '').trim(),
      comments: String(row.comments || '').trim(),
      isUpdate: /update|hotfix|patch|redistributable/i.test(String(row.releaseType || '')),
    });
  }
  return { apps, error: null };
}

module.exports = { listRegistryApps };
