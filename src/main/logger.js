'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_MEMORY_LINES = 2000;
const memory = [];
let filePath = null;
let stream = null;

function init(dir) {
  filePath = path.join(dir, `uproot-${new Date().toISOString().slice(0, 10)}.log`);
  try {
    stream = fs.createWriteStream(filePath, { flags: 'a' });
  } catch {
    stream = null;
  }
}

function write(level, message, meta) {
  const line = {
    at: Date.now(),
    level,
    message: String(message),
    meta: meta === undefined ? null : meta,
  };
  memory.push(line);
  if (memory.length > MAX_MEMORY_LINES) memory.splice(0, memory.length - MAX_MEMORY_LINES);
  if (stream) {
    try {
      stream.write(`${new Date(line.at).toISOString()} [${level}] ${line.message}${meta ? ` ${safeJson(meta)}` : ''}\n`);
    } catch {
      /* logging must never throw */
    }
  }
  return line;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const log = {
  init,
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  debug: (m, meta) => write('debug', m, meta),
  tail: (count = 500) => memory.slice(-count),
  file: () => filePath,
};

module.exports = log;
