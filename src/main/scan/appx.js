'use strict';

const { psJson, asArray } = require('../util/ps');

const SCRIPT = String.raw`
$list = New-Object System.Collections.Generic.List[object]
try { Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object { $list.Add($_) } } catch { }
try { Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | ForEach-Object { $list.Add($_) } } catch { }

$seen = @{}
$result = foreach ($p in $list) {
  $full = [string]$p.PackageFullName
  if (-not $full) { continue }
  if ($seen.ContainsKey($full)) { continue }
  $seen[$full] = $true
  [pscustomobject]@{
    name               = [string]$p.Name
    packageFullName    = $full
    packageFamilyName  = [string]$p.PackageFamilyName
    publisher          = [string]$p.Publisher
    publisherId        = [string]$p.PublisherId
    version            = [string]$p.Version
    architecture       = [string]$p.Architecture
    installLocation    = [string]$p.InstallLocation
    isFramework        = [bool]$p.IsFramework
    isResourcePackage  = [bool]$p.IsResourcePackage
    isBundle           = [bool]$p.IsBundle
    nonRemovable       = [bool]$p.NonRemovable
    signatureKind      = [string]$p.SignatureKind
    status             = [string]$p.Status
    packageUserInformation = [string]$p.PackageUserInformation
  }
}
`;

/** Turn a publisher DN into something readable: "CN=Microsoft Corporation, O=..." */
function cleanPublisher(dn) {
  if (!dn) return '';
  const m = String(dn).match(/CN=([^,]+)/i);
  return (m ? m[1] : String(dn)).trim();
}

async function listAppxPackages() {
  const r = await psJson(SCRIPT, { timeout: 180000 });
  if (!r.ok) return { packages: [], error: r.error || r.stderr || 'AppX enumeration failed' };
  const rows = asArray(r.data);
  const packages = rows
    .filter((row) => row && row.packageFullName)
    .map((row) => ({
      id: `appx:${row.packageFullName}`,
      source: 'appx',
      name: row.name,
      packageFullName: row.packageFullName,
      packageFamilyName: row.packageFamilyName || '',
      publisher: cleanPublisher(row.publisher),
      publisherDn: row.publisher || '',
      version: row.version || '',
      architecture: row.architecture || '',
      installLocation: row.installLocation || '',
      isFramework: row.isFramework === true,
      isResourcePackage: row.isResourcePackage === true,
      isBundle: row.isBundle === true,
      nonRemovable: row.nonRemovable === true,
      signatureKind: row.signatureKind || '',
      status: row.status || '',
      isMachineScope: false,
    }))
    .filter((p) => !p.isResourcePackage);
  return { packages, error: null };
}

module.exports = { listAppxPackages };
