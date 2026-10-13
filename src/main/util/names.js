'use strict';

const path = require('node:path');

/**
 * Normalise a product/publisher/folder name so that "Notepad++ (64-bit)",
 * "Notepad++ v8.6.2" and "notepad++" all collapse to the same key.
 */
function normalizeName(input) {
  let s = String(input || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' '); // drop parentheticals
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\bv(?:er(?:sion)?)?\.?\s*\d+(?:\.\d+)*\b/g, ' '); // v1.2.3
  s = s.replace(/\b\d+(?:\.\d+)+\b/g, ' '); // 1.2.3
  s = s.replace(/\b(x64|x86|amd64|arm64|win64|win32|64-?bit|32-?bit)\b/g, ' ');
  s = s.replace(/\b(setup|installer|install|update|updater|client|app|application|desktop|for windows)\b/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Compact form with separators removed, for equality comparisons. */
function compactKey(input) {
  return normalizeName(input).replace(/\s+/g, '');
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+&()'!,@#-]{0,180}$/;

/** Reject anything that is not a plain folder name (no separators or ..). */
function isSafeEntryName(name) {
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  return SAFE_NAME.test(name);
}

function isPathInside(parent, child) {
  if (!parent || !child) return false;
  const p = path.resolve(parent).replace(/[\\/]+$/, '').toLowerCase();
  const c = path.resolve(child).replace(/[\\/]+$/, '').toLowerCase();
  if (p === c) return true;
  return c.startsWith(p + path.sep);
}

/**
 * Score how strongly a candidate name matches a target name.
 * 3 = the two are effectively the same name
 * 2 = candidate extends the target with a word boundary ("Git" -> "Git LFS")
 * 1 = the target appears as a whole token inside the candidate
 * 0 = no relationship (never auto-selected)
 */
function matchScore(target, candidate) {
  const t = compactKey(target);
  const c = compactKey(candidate);
  if (!t || !c) return 0;
  if (t === c) return 3;

  const tn = normalizeName(target);
  const cn = normalizeName(candidate);
  if (tn && cn && tn === cn) return 3;

  if (cn.startsWith(tn + ' ') || cn.endsWith(' ' + tn)) return 2;
  if (tn.startsWith(cn + ' ')) return 2;

  const tTokens = tn.split(' ').filter(Boolean);
  const cTokens = cn.split(' ').filter(Boolean);
  if (!tTokens.length || !cTokens.length) return 0;
  const hit = tTokens.every((tok) => cTokens.includes(tok));
  if (hit && cTokens.length <= tTokens.length + 2) return 2;
  if (cTokens.includes(tn)) return 1;
  return 0;
}

/** Extract plausible executable/file names referenced by a command line. */
function extractPathsFromCommandLine(cmdLine) {
  const out = [];
  if (!cmdLine) return out;
  const re = /"([^"]+)"|([A-Za-z]:\\[^\s"]+)/g;
  let m;
  while ((m = re.exec(String(cmdLine))) !== null) {
    const value = m[1] || m[2];
    if (value) out.push(value);
  }
  return out;
}

/** Bucket a weighted match score into the confidence levels shown in the UI. */
function confidenceOf(score) {
  if (score >= 2.9) return 'high';
  if (score >= 1.6) return 'medium';
  return 'low';
}

module.exports = {
  normalizeName,
  compactKey,
  isSafeEntryName,
  isPathInside,
  matchScore,
  extractPathsFromCommandLine,
  confidenceOf,
};
