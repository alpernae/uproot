'use strict';

const fs = require('node:fs');

const { run } = require('./exec');
const { tools } = require('./paths');
const { psJson, tempFile, writeScriptFile, extractJson, psLiteral, PS_FLAGS, encodeCommand } = require('./ps');

let adminCache = null;

async function isAdmin(force = false) {
  if (adminCache !== null && !force) return adminCache;
  const r = await psJson(
    '$result = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  );
  adminCache = r.data === true;
  return adminCache;
}

/**
 * Launch a program elevated via UAC. Resolves once the elevated process exits.
 * `blocked` is true when the user declined the UAC prompt.
 */
async function launchElevated(file, args) {
  const argList = Array.isArray(args) ? `@(${args.map(psLiteral).join(',')})` : psLiteral(args);
  const launcher = [
    "$ProgressPreference='SilentlyContinue'",
    'try {',
    `  Start-Process -FilePath ${psLiteral(file)} -ArgumentList ${argList} -Verb RunAs -Wait -WindowStyle Hidden`,
    '  $result = @{ ok = $true }',
    '} catch {',
    '  $result = @{ ok = $false; error = $_.Exception.Message }',
    '}',
    '$result | ConvertTo-Json -Compress',
  ].join('\n');

  const res = await run(tools.powershell, [...PS_FLAGS, '-EncodedCommand', encodeCommand(launcher)]);
  const parsed = extractJson(res.stdout);
  if (!parsed.ok) {
    return { ok: false, blocked: false, error: res.error || res.stderr || 'Elevation launcher failed' };
  }
  const data = parsed.value || {};
  if (data.ok === true) return { ok: true, blocked: false };
  const msg = String(data.error || '');
  const blocked = /canceled by the user|cancelled by the user|operation was canceled/i.test(msg);
  return { ok: false, blocked, error: msg || 'Elevation failed' };
}

/**
 * Run a PowerShell body with administrator rights. The body assigns to
 * `$result`; the JSON round-trips through a temp file because an elevated
 * process has no usable stdout pipe back to us.
 */
async function runElevatedPs(body) {
  const outFile = tempFile('.json');
  const ps1 = tempFile('.ps1');
  writeScriptFile(
    ps1,
    [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      body,
      'if ($null -eq $result) { $result = @() }',
      `$result | ConvertTo-Json -Depth 40 -Compress | Set-Content -LiteralPath ${psLiteral(outFile)} -Encoding UTF8`,
    ].join('\r\n'),
  );

  const launched = await launchElevated(tools.powershell, [...PS_FLAGS, '-File', ps1]);
  let data = null;
  try {
    if (fs.existsSync(outFile)) data = extractJson(fs.readFileSync(outFile, 'utf8')).value;
  } finally {
    fs.rmSync(ps1, { force: true });
    fs.rmSync(outFile, { force: true });
  }
  if (!launched.ok) {
    return { ok: false, blocked: launched.blocked, error: launched.error, data: null };
  }
  return { ok: true, blocked: false, data, error: null };
}

/**
 * Write a batch file that runs a raw Windows command line. `chcp 65001` makes
 * cmd.exe read the remaining lines as UTF-8, so non-ASCII paths in vendor
 * uninstall strings survive.
 */
function writeBatchFile(file, lines) {
  fs.writeFileSync(file, ['@echo off', 'chcp 65001 >nul', ...lines].join('\r\n'), 'utf8');
  return file;
}

/**
 * Run a raw Windows command line elevated (used for vendor uninstallers).
 * `code` is the command's exit code, or null when it could not be read back.
 */
async function runElevatedCmd(cmdLine) {
  const bat = tempFile('.cmd');
  const codeFile = tempFile('.txt');
  writeBatchFile(bat, ['setlocal', cmdLine, `>"${codeFile}" echo %errorlevel%`, 'endlocal']);

  const launched = await launchElevated(tools.cmd, ['/d', '/s', '/c', bat]);
  let code = null;
  try {
    if (fs.existsSync(codeFile)) code = parseInt(fs.readFileSync(codeFile, 'utf8').trim(), 10);
  } finally {
    fs.rmSync(bat, { force: true });
    fs.rmSync(codeFile, { force: true });
  }
  if (!launched.ok) return { ok: false, blocked: launched.blocked, error: launched.error, code: null };
  return { ok: true, blocked: false, code: Number.isNaN(code) ? null : code, error: null };
}

module.exports = { isAdmin, launchElevated, runElevatedPs, runElevatedCmd, writeBatchFile, lit: psLiteral };
