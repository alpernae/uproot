'use strict';

/**
 * Privacy surface.
 *
 * A curated catalog of Windows telemetry / behaviour-tracking items that can be
 * removed through the same machinery as leftover cleanup:
 *   - services   -> stopped, key exported to .reg, then `sc delete`
 *   - tasks      -> exported to .xml, then unregistered
 *   - file stores-> quarantined (or permanently deleted)
 *
 * Nothing is enumerated by guesswork: a live service/task/file only becomes a
 * finding when the exact item already exists in this catalog, so everything the
 * app can remove is reviewable in one place. Enumeration is dynamic only in the
 * sense that tasks inside a listed folder are individually reported.
 */

const fs = require('node:fs');
const path = require('node:path');

const { paths } = require('../util/paths');
const system = require('../system/system');

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Services that collect or ship diagnostic data. `optional` entries are shown
 * unchecked by default because some behaviour (e.g. error reports) is arguably
 * useful.
 */
const SERVICE_CATALOG = [
  {
    name: 'DiagTrack',
    displayName: 'Connected User Experiences and Telemetry',
    why: 'The main Windows telemetry pipeline — collects, processes and uploads diagnostic and usage data.',
    optional: false,
  },
  {
    name: 'dmwappushservice',
    displayName: 'Device Management WAP Push message Routing Service',
    why: 'Relays device-management messages and session/telemetry data to Microsoft endpoints on some builds.',
    optional: false,
  },
  {
    name: 'dmwappushsvc',
    displayName: 'WAP Push Message Routing Service',
    why: 'Older name of the WAP push / telemetry relay service (Windows 10 LTSB era).',
    optional: false,
  },
  {
    name: 'WerSvc',
    displayName: 'Windows Error Reporting Service',
    why: 'Prepares and uploads error reports. Disabling stops automatic error reporting; local crash dialogues keep working.',
    optional: true,
  },
];

/**
 * Scheduled-task folders used as telemetry collection endpoints. Every task in
 * these folders becomes a finding unless it is on the skip list.
 */
const TASK_ROOTS = [
  {
    prefix: '\\Microsoft\\Windows\\Application Experience\\',
    why: 'Compatibility appraiser tasks collect application and system usage data for the telemetry pipeline.',
  },
  {
    prefix: '\\Microsoft\\Windows\\Customer Experience Improvement Program\\',
    why: 'CEIP tasks consolidate and upload usage statistics for the Customer Experience Improvement Program.',
  },
  {
    prefix: '\\Microsoft\\Windows\\Feedback\\',
    why: 'Feedback (Siuf) tasks stage and upload problem-report and feedback data.',
  },
  {
    prefix: '\\Microsoft\\Windows\\Windows Error Reporting\\',
    why: 'Uploads queued Windows Error Reporting payloads to Microsoft.',
  },
  {
    prefix: '\\Microsoft\\Windows\\Device Information\\',
    why: 'Collects device information (make/model, capabilities) for processing.',
  },
  {
    prefix: '\\Microsoft\\Windows\\DiskDiagnostic\\',
    why: 'The disk diagnostic data collector gathers disk/SMART telemetry.',
  },
  {
    prefix: '\\Microsoft\\Windows\\Autochk\\',
    why: 'The Proxy task reports boot-time disk-check results (SQM channel).',
  },
];

/** Tasks inside a listed folder that are not telemetry and must be skipped. */
const TASK_SKIP = new Set([
  'StartupAppTask', // manages startup app notifications
  'AppxDeploymentHosting', // hosts Store app deployment; not telemetry
  'SdbinstMergeFtaTask', // merges compatibility file-type fixes; not telemetry
  'SdbinstMergeDbTask', // merges compatibility database entries; not telemetry
]);

/**
 * File stores holding user activity and report data. Deleting the folder clears
 * the accumulated history; each entry is one finding.
 */
const FILE_TRACES = [
  {
    id: 'cdp',
    dir: ['localAppData', 'ConnectedDevicesPlatform'],
    label: 'Activity history / Timeline data',
    why: 'ConnectedDevicesPlatform holds the Timeline activity history that is synced to the cloud on some setups.',
    machine: false,
  },
  {
    id: 'siuf',
    dir: ['localAppData', 'Siuf'],
    label: 'Feedback & problem reports (Siuf)',
    why: 'Feedback staging data for the Feedback Hub and Siuf report channels.',
    machine: false,
  },
  {
    id: 'wer-user',
    dir: ['localAppData', 'Microsoft', 'Windows', 'WER'],
    label: 'Windows Error Reporting reports (user)',
    why: 'Crash reports queued for upload under the user profile.',
    machine: false,
  },
  {
    id: 'wer-machine',
    dir: ['programData', 'Microsoft', 'Windows', 'WER'],
    label: 'Windows Error Reporting reports (all users)',
    why: 'Crash reports queued for upload machine-wide.',
    machine: true,
  },
];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function taskMatch(taskPath) {
  const lower = String(taskPath || '').toLowerCase();
  if (!lower) return null;
  // Rows come with a leading backslash; make matching robust either way.
  const normalized = lower.startsWith('\\') ? lower : `\\${lower}`;
  const root = TASK_ROOTS.find((r) => normalized.toLowerCase().startsWith(r.prefix.toLowerCase()));
  if (!root) return null;
  return root;
}

/** Map a live service row onto a privacy finding; null when not in the catalog. */
function serviceFinding(row, catalogEntry) {
  return {
    id: `dp:service:${slug(catalogEntry.name)}`,
    kind: 'service',
    name: catalogEntry.name,
    displayName: row.displayName || catalogEntry.displayName,
    state: row.state || '',
    startMode: row.startMode || '',
    target: row.target || '',
    why: catalogEntry.why,
    optional: catalogEntry.optional === true,
    admin: true,
    confidence: catalogEntry.optional ? 'medium' : 'high',
    checked: !catalogEntry.optional,
    conflict: null,
    matchedOn: catalogEntry.displayName,
    note: catalogEntry.why,
  };
}

/** Build findings from live service rows against the catalog. */
function serviceFindings(rows, opts = {}) {
  const include = (opts.includeServices !== undefined ? opts.includeServices : true);
  if (!include) return [];
  const out = [];
  const byName = new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.name).toLowerCase(), r]));
  for (const entry of SERVICE_CATALOG) {
    const row = byName.get(entry.name.toLowerCase());
    if (row) out.push(serviceFinding(row, entry));
  }
  return out;
}

/** Build findings from live scheduled-task rows against the catalog. */
function taskFindings(rows, opts = {}) {
  const include = (opts.includeTasks !== undefined ? opts.includeTasks : true);
  if (!include) return [];
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (TASK_SKIP.has(row.taskName)) continue;
    const root = taskMatch(row.taskPath);
    if (!root) continue;
    out.push({
      id: `dp:task:${slug(`${row.taskPath || '\\'}${row.taskName}`)}`,
      kind: 'task',
      name: row.taskName,
      taskName: row.taskName,
      taskPath: row.taskPath || '\\',
      displayName: row.taskName,
      state: row.state || '',
      target: row.target || '',
      why: root.why,
      optional: false,
      admin: true,
      confidence: 'high',
      checked: true,
      conflict: null,
      matchedOn: root.prefix,
      note: root.why,
    });
  }
  return out.sort((a, b) => (a.taskPath + a.taskName).localeCompare(b.taskPath + b.taskName));
}

/** Build file-store findings from configured base paths. */
function fileFindings(basePaths, exists = fs.existsSync, opts = {}) {
  const include = (opts.includeHistory !== undefined ? opts.includeHistory : true);
  if (!include) return [];
  const out = [];
  for (const entry of FILE_TRACES) {
    const base = basePaths[entry.dir[0]];
    if (!base) continue;
    const dir = path.join(base, ...entry.dir.slice(1));
    // WER stores live under a protected parent; deleting the child folder is
    // allowed by the cleanup safety model, so only prune what exists.
    let present = false;
    try {
      present = exists(dir);
    } catch {
      present = false;
    }
    if (!present) continue;
    out.push({
      id: `dp:file:${entry.id}`,
      kind: 'file',
      name: entry.label,
      displayName: entry.label,
      path: dir,
      why: entry.why,
      optional: false,
      admin: entry.machine === true,
      confidence: 'high',
      checked: true,
      conflict: null,
      matchedOn: 'present on disk',
      note: entry.why,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live scan
// ---------------------------------------------------------------------------

async function scanPrivacy(settings = {}) {
  const errors = [];
  const [services, tasks] = await Promise.all([system.listServices(), system.listScheduledTasks()]);

  if (services.error) errors.push(`services: ${services.error}`);
  if (tasks.error) errors.push(`tasks: ${tasks.error}`);

  const findings = [
    ...serviceFindings(services.items, { includeServices: settings.privacyIncludeServices !== false }),
    ...taskFindings(tasks.items, { includeTasks: settings.privacyIncludeTasks !== false }),
    ...fileFindings(paths, fs.existsSync, { includeHistory: settings.privacyIncludeHistory !== false }),
  ];

  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { findings, errors, scannedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Removal mapping
// ---------------------------------------------------------------------------

/**
 * Turn selected findings into the payload shape clean.executeCleanup consumes.
 * Services and tasks are exported before removal; files follow the chosen mode
 * (quarantine or permanent delete).
 */
function buildRemovalPayload(selected) {
  const files = [];
  const registryKeys = [];
  const systemItems = [];

  for (const item of Array.isArray(selected) ? selected : []) {
    if (!item || !item.kind) continue;
    if (item.kind === 'service') {
      const name = String(item.name || '').trim();
      if (!name) throw new Error('Privacy service finding has no name.');
      systemItems.push({ type: 'service', name });
    } else if (item.kind === 'task') {
      const taskName = String(item.taskName || item.name || '').trim();
      if (!taskName) throw new Error('Privacy task finding has no name.');
      systemItems.push({ type: 'task', taskName, taskPath: item.taskPath || '\\' });
    } else if (item.kind === 'file') {
      if (!item.path) throw new Error('Privacy file finding has no path.');
      files.push({ path: item.path });
    } else {
      throw new Error(`Unsupported privacy removal kind: ${item.kind}`);
    }
  }

  return { files, registryKeys, system: systemItems };
}

module.exports = {
  SERVICE_CATALOG,
  TASK_ROOTS,
  TASK_SKIP,
  FILE_TRACES,
  serviceFinding,
  serviceFindings,
  taskFindings,
  taskMatch,
  fileFindings,
  slug,
  scanPrivacy,
  buildRemovalPayload,
};
