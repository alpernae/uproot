'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, nativeTheme, shell } = require('electron');

const ipc = require('./ipc');
const store = require('./store');
const log = require('./logger');
const { isAdmin } = require('./util/elevate');

const PRODUCT_NAME = 'Uproot';
const isDev = process.argv.includes('--dev');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#080a0e' : '#f5f6f8',
    autoHideMenuBar: true,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
  });

  ipc.setWindow(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

async function start() {
  Menu.setApplicationMenu(null);
  store.migrateLegacyData();
  try {
    log.init(store.logsDir());
  } catch (e) {
    console.error('Logger init failed', e);
  }

  ipc.register();

  // Apply the persisted theme before the window exists so the very first
  // paint (and the native scrollbar/form-control chrome) already matches.
  ipc.applyTheme(store.getSettings().theme);

  createWindow();
  ipc.broadcastTheme();

  const admin = await isAdmin().catch(() => false);
  log.info(`${PRODUCT_NAME} started`, { version: app.getVersion(), admin });
}

if (process.platform !== 'win32') {
  // The tool is Windows-specific, but stay runnable elsewhere for development.
  console.warn(`${PRODUCT_NAME} is designed for Windows. Some scan steps may misbehave here.`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(start);

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
