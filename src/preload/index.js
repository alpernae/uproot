'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
  apps: {
    list: (payload) => ipcRenderer.invoke('apps:list', payload),
    plan: (appId) => ipcRenderer.invoke('app:plan', { appId }),
    detail: (appId) => ipcRenderer.invoke('app:detail', { appId }),
    footprint: (appId, includeReferences) =>
      ipcRenderer.invoke('app:footprint', { appId, includeReferences }),
  },
  uninstall: {
    run: (payload) => ipcRenderer.invoke('uninstall:run', payload),
  },
  leftovers: {
    find: (appId, includeRegistryReferences) =>
      ipcRenderer.invoke('leftovers:find', { appId, includeRegistryReferences }),
    findByName: (name, publisher, installLocation) =>
      ipcRenderer.invoke('leftovers:findByName', { name, publisher, installLocation }),
    orphaned: () => ipcRenderer.invoke('leftovers:orphaned'),
  },
  clean: {
    execute: (payload) => ipcRenderer.invoke('clean:execute', payload),
  },
  quarantine: {
    list: () => ipcRenderer.invoke('quarantine:list'),
    restore: (id) => ipcRenderer.invoke('quarantine:restore', { id }),
    purge: (id) => ipcRenderer.invoke('quarantine:purge', { id }),
  },
  runtimes: {
    analyze: (force) => ipcRenderer.invoke('runtimes:analyze', { force }),
  },
  icon: {
    get: (payload) => ipcRenderer.invoke('icon:get', payload),
  },
  shell: {
    reveal: (target) => ipcRenderer.invoke('shell:reveal', { target }),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  theme: {
    current: () => ipcRenderer.invoke('theme:current'),
    on: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('theme', listener);
      return () => ipcRenderer.removeListener('theme', listener);
    },
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', { text }),
  },
  log: {
    tail: (count) => ipcRenderer.invoke('log:tail', { count }),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    add: (entry) => ipcRenderer.invoke('history:add', entry),
  },
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);