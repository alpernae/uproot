'use strict';

const { run } = require('../util/exec');
const { wingetPath } = require('../util/paths');

// The header row we anchor on. winget always prints these five columns.
const HEADER_RE = /^(Name)(\s+)(Id)(\s+)(Version)(\s+)(Available)(\s+)(Source)\s*$/;

/**
 * `winget list` has no --output json, so we parse its fixed-width table.
 * Columns are left-aligned and each is padded to the width of its widest cell,
 * therefore slicing at the header word offsets is exact for every row -- an
 * empty trailing column simply yields an empty string.
 */
function parseListTable(text) {
  const lines = String(text || '').split(/\r?\n/);
  let headerIndex = -1;
  let cols = null;

  for (let i = 0; i < lines.length; i += 1) {
    const mm = HEADER_RE.exec(lines[i]);
    if (!mm) continue;
    const groups = ['name', 'id', 'version', 'available', 'source'];
    const parts = [mm[1], mm[3], mm[5], mm[7], mm[9]];
    const gaps = [mm[2], mm[4], mm[6], mm[8]];
    const positions = {};
    let cursor = mm.index;
    for (let g = 0; g < groups.length; g += 1) {
      positions[groups[g]] = cursor;
      cursor += parts[g].length;
      if (gaps[g]) cursor += gaps[g].length;
    }
    cols = positions;
    headerIndex = i;
    break;
  }
  if (!cols) return [];

  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^-{5,}\s*$/.test(line.trim())) continue;
    const slice = (from, to) => (to === undefined ? line.slice(from) : line.slice(from, to)).trim();
    const name = slice(cols.name, cols.id);
    if (!name) continue;
    rows.push({
      name,
      wingetId: slice(cols.id, cols.version),
      version: slice(cols.version, cols.available),
      available: slice(cols.available, cols.source),
      source: slice(cols.source),
    });
  }
  return rows;
}

function normalizeRow(row) {
  const isMsix = /^MSIX\\/i.test(row.wingetId);
  const isStore = row.source === 'msstore' || /^[A-Z0-9]{12}$/.test(row.wingetId);
  return {
    id: `winget:${row.wingetId || row.name}`,
    source: 'winget',
    name: row.name,
    version: row.version,
    availableVersion: row.available,
    wingetId: row.wingetId,
    wingetSource: row.source,
    isMsix,
    isStore,
    canUpgrade: Boolean(row.available),
    isMachineScope: false,
  };
}

async function listWingetApps() {
  const res = await run(
    wingetPath(),
    ['list', '--accept-source-agreements', '--disable-interactivity'],
    { timeout: 180000, maxBuffer: 64 * 1024 * 1024 },
  );

  const rows = parseListTable(res.stdout);
  if (!rows.length) {
    const detail = [res.stderr, res.error].filter(Boolean).join(' ').trim();
    return { apps: [], error: res.ok ? 'winget returned no parsable rows' : detail || 'winget failed' };
  }
  return { apps: rows.map(normalizeRow), error: null };
}

module.exports = { listWingetApps, parseListTable, normalizeRow };
