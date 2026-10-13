'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  theme: 'system', // 'dark' | 'light' | 'system'
  hideSystemComponents: true,
  hideFrameworkPackages: true,
  hideUpdates: false,
  defaultCleanupMode: 'quarantine', // 'quarantine' | 'delete'
  confirmBeforeDelete: true,
  scanRegistryReferences: true,
  analyzeRuntimesOnUninstall: true,
  stopRunningProcesses: true,
  checkLeftoversAfterUninstall: true,
  pageSize: 400,
};

let cache = null;

function dataDir() {
  return app.getPath('userData');
}

function quarantineDir() {
  const dir = path.join(dataDir(), 'quarantine');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logsDir() {
  const dir = path.join(dataDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Data the app owns inside userData. Chromium's own files are left alone.
const OWNED_ENTRIES = ['settings.json', 'history.json', 'quarantine', 'logs'];
const LEGACY_DIR_NAMES = ['App Remover'];

/**
 * The app used to ship as "App Remover", so its data lives under a different
 * userData folder. Move our own files across once, so settings, history and
 * — critically — quarantined files stay restorable after the rename.
 */
function migrateLegacyData() {
  const target = dataDir();
  for (const name of LEGACY_DIR_NAMES) {
    const legacy = path.join(app.getPath('appData'), name);
    if (legacy === target || !fs.existsSync(legacy)) continue;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of OWNED_ENTRIES) {
      const from = path.join(legacy, entry);
      const to = path.join(target, entry);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch (e) {
        console.error(`Could not migrate ${from}`, e);
      }
    }
  }
  cache = null;
}

function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

function historyFile() {
  return path.join(dataDir(), 'history.json');
}

function getSettings() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    cache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  cache = next;
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function readHistory() {
  try {
    const raw = fs.readFileSync(historyFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  const history = readHistory();
  history.unshift({ ...entry, at: Date.now() });
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, 500), null, 2), 'utf8');
  return history[0];
}

module.exports = {
  dataDir,
  migrateLegacyData,
  quarantineDir,
  logsDir,
  getSettings,
  setSettings,
  readHistory,
  appendHistory,
  DEFAULT_SETTINGS,
};
