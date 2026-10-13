'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const env = process.env;
const winDir = env.SystemRoot || env.windir || 'C:\\Windows';
const system32 = path.join(winDir, 'System32');

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const paths = {
  windows: winDir,
  system32,
  programFiles: env.ProgramFiles || 'C:\\Program Files',
  programFilesX86: env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  programData: env.ProgramData || 'C:\\ProgramData',
  appData: env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  localAppData: env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  userProfile: env.USERPROFILE || os.homedir(),
  temp: env.TEMP || os.tmpdir(),
  // Scratch space for generated scripts and job files.
  workDir: path.join(env.TEMP || os.tmpdir(), 'uproot'),
  systemDrive: path.parse(winDir).root,
  commonProgramFiles: env.CommonProgramFiles || path.join(env.ProgramFiles || 'C:\\Program Files', 'Common Files'),
  commonProgramFilesX86:
    env['CommonProgramFiles(x86)'] || path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Common Files'),
};

/** Absolute paths to the system tools we shell out to. */
const tools = {
  reg: path.join(system32, 'reg.exe'),
  cmd: path.join(system32, 'cmd.exe'),
  msiexec: path.join(system32, 'msiexec.exe'),
  powershell: firstExisting([path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) || 'powershell.exe',
  taskkill: path.join(system32, 'taskkill.exe'),
  sc: path.join(system32, 'sc.exe'),
  schtasks: path.join(system32, 'schtasks.exe'),
  takeown: path.join(system32, 'takeown.exe'),
  icacls: path.join(system32, 'icacls.exe'),
};

/**
 * winget.exe lives behind an app-execution alias whose PATH entry is not always
 * present when we are launched from Explorer, so probe the known locations.
 */
let cachedWinget;
function wingetPath() {
  if (cachedWinget) return cachedWinget;
  cachedWinget =
    firstExisting([
      path.join(paths.localAppData, 'Microsoft', 'WindowsApps', 'winget.exe'),
      path.join(paths.userProfile, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'winget.exe'),
      path.join(paths.system32, 'winget.exe'),
    ]) || 'winget';
  return cachedWinget;
}

const MACHINE_ROOTS = [paths.programFiles, paths.programFilesX86, paths.programData, paths.windows];

/** True when a file-system path lives in a machine-wide location that needs elevation to modify. */
function isMachinePath(p) {
  if (!p) return false;
  const lower = path.resolve(String(p)).toLowerCase();
  return MACHINE_ROOTS.some((root) => {
    const r = path.resolve(root).toLowerCase();
    return lower === r || lower.startsWith(r + path.sep);
  });
}

module.exports = { paths, tools, wingetPath, isMachinePath };
