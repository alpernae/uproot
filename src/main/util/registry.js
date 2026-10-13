'use strict';

const { run } = require('./exec');
const { tools } = require('./paths');

const HIVE_ALIASES = {
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKEY_CURRENT_USER: 'HKCU',
  HKEY_CLASSES_ROOT: 'HKCR',
  HKEY_USERS: 'HKU',
  HKEY_CURRENT_CONFIG: 'HKCC',
  HKLM: 'HKLM',
  HKCU: 'HKCU',
  HKCR: 'HKCR',
  HKU: 'HKU',
  HKCC: 'HKCC',
};

/**
 * Convert any of the path shapes we meet (reg.exe, PowerShell provider, or a
 * full Registry:: path) into a canonical `HKLM\Software\...` string that
 * reg.exe accepts.
 */
function toRegPath(input) {
  if (!input) return '';
  let p = String(input).replace(/\u0000/g, '').trim();
  p = p.replace(/^Microsoft\.PowerShell\.Core\\Registry::/i, '');
  const m = p.match(/^(HKEY_[A-Z_]+|HK(LM|CU|CR|U|CC))[\\:]*/i);
  if (!m) return p.replace(/^\\+/, '');
  const alias = HIVE_ALIASES[m[1].toUpperCase()] || m[1].toUpperCase();
  const rest = p.slice(m[0].length).replace(/^\\+/, '');
  return rest ? `${alias}\\${rest}` : alias;
}

/** `HKLM\Software\X` -> `HKLM:\Software\X` for the PowerShell registry provider. */
function toPsPath(regPath) {
  const p = toRegPath(regPath);
  const idx = p.indexOf('\\');
  if (idx < 0) return `${p}:`;
  return `${p.slice(0, idx)}:${p.slice(idx)}`;
}

function hiveOf(regPath) {
  const p = toRegPath(regPath);
  const idx = p.indexOf('\\');
  return (idx < 0 ? p : p.slice(0, idx)).toUpperCase();
}

function isMachineScope(regPath) {
  const hive = hiveOf(regPath);
  return hive === 'HKLM' || hive === 'HKCR' || hive === 'HKU' || hive === 'HKCC';
}

/** reg.exe must always be invoked from System32 to get the 64-bit view. */
async function reg(args, opts = {}) {
  return run(tools.reg, args, opts);
}

async function keyExists(regPath) {
  const r = await reg(['query', toRegPath(regPath)]);
  return r.ok;
}

async function listSubKeys(regPath) {
  const base = toRegPath(regPath);
  const r = await reg(['query', base]);
  if (!r.ok) return [];
  const out = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !/^HKEY_|^HK(LM|CU|CR|U|CC)\\/i.test(line)) continue;
    if (!line.toUpperCase().startsWith(base.toUpperCase())) continue;
    const rest = line.slice(base.length).replace(/^\\+/, '');
    if (rest) out.push(rest);
  }
  return out;
}

async function exportKey(regPath, file) {
  const r = await reg(['export', toRegPath(regPath), file, '/y']);
  return { ok: r.ok, error: r.ok ? null : r.stderr || r.error };
}

async function importKey(file) {
  const r = await reg(['import', file]);
  return { ok: r.ok, error: r.ok ? null : r.stderr || r.error };
}

async function deleteKey(regPath) {
  const r = await reg(['delete', toRegPath(regPath), '/f']);
  return { ok: r.ok, code: r.code, error: r.ok ? null : r.stderr || r.error };
}

async function deleteValue(regPath, name) {
  const r = await reg(['delete', toRegPath(regPath), '/v', name, '/f']);
  return { ok: r.ok, error: r.ok ? null : r.stderr || r.error };
}

async function writeValue(regPath, name, type, data) {
  const r = await reg(['add', toRegPath(regPath), '/v', name, '/t', type, '/d', String(data), '/f']);
  return { ok: r.ok, error: r.ok ? null : r.stderr || r.error };
}

module.exports = {
  toRegPath,
  toPsPath,
  hiveOf,
  isMachineScope,
  reg,
  keyExists,
  listSubKeys,
  exportKey,
  importKey,
  deleteKey,
  deleteValue,
  writeValue,
};
