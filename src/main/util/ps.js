'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { run } = require('./exec');
const { paths, tools } = require('./paths');

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// Windows' command line tops out near 32k characters; -EncodedCommand doubles
// the script size, so anything larger goes through a script file instead.
const MAX_ENCODED_COMMAND = 30000;

/** UTF-16LE base64 is what -EncodedCommand expects. */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function tempFile(ext) {
  fs.mkdirSync(paths.workDir, { recursive: true });
  return path.join(paths.workDir, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`);
}

/**
 * Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page, which
 * mangles any non-ASCII path embedded in the script (e.g. a user profile with
 * an accented name). Always write scripts as UTF-8 *with* a BOM.
 */
function writeScriptFile(file, script) {
  fs.writeFileSync(file, `\uFEFF${script}`, 'utf8');
  return file;
}

/** Literal single-quoted PowerShell string. */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Some PowerShell hosts emit a BOM or a stray blank line ahead of the JSON.
 * Recover the outermost JSON value rather than trusting the raw string.
 */
function extractJson(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) return { value: null, ok: false };
  try {
    return { value: JSON.parse(s), ok: true };
  } catch {
    /* fall through to bracket recovery */
  }
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return { value: null, ok: false };
  const start = Math.min(...starts);
  const close = s[start] === '[' ? ']' : '}';
  const end = s.lastIndexOf(close);
  if (end <= start) return { value: null, ok: false };
  try {
    return { value: JSON.parse(s.slice(start, end + 1)), ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

/** Normalise ConvertTo-Json output, which collapses one-element arrays to a scalar. */
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Run a wrapped script, falling back to a temp .ps1 when it is too long for the command line. */
async function runScript(wrapped, opts) {
  const encoded = encodeCommand(wrapped);
  if (encoded.length <= MAX_ENCODED_COMMAND) {
    return run(tools.powershell, [...PS_FLAGS, '-EncodedCommand', encoded], opts);
  }
  const file = writeScriptFile(tempFile('.ps1'), wrapped);
  try {
    return await run(tools.powershell, [...PS_FLAGS, '-File', file], opts);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Run a PowerShell script body. The body is expected to assign its payload to
 * `$result`; we serialise that to JSON on stdout.
 */
async function psJson(script, opts = {}) {
  const wrapped = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
    script,
    'if ($null -eq $result) { $result = @() }',
    '$result | ConvertTo-Json -Depth 40 -Compress',
  ].join('\n');

  const res = await runScript(wrapped, opts);
  const parsed = extractJson(res.stdout);
  const warnings = (res.stderr || '').trim();
  if (!parsed.ok && !res.ok) {
    return { ok: false, data: null, raw: res.stdout, error: res.error || warnings || 'PowerShell failed' };
  }
  return {
    ok: parsed.ok,
    data: parsed.value,
    raw: res.stdout,
    stderr: warnings,
    error: parsed.ok ? null : 'Could not parse PowerShell output',
  };
}

module.exports = {
  psJson,
  encodeCommand,
  tempFile,
  writeScriptFile,
  psLiteral,
  extractJson,
  asArray,
  PS_FLAGS,
};
