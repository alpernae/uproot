'use strict';

const { execFile, spawn } = require('node:child_process');

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a program and buffer its output as UTF-8. Never rejects: callers get a
 * result object so a failing reg.exe does not blow up a whole scan.
 */
function run(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          windowsHide: opts.windowsHide !== false,
          maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
          encoding: 'utf8',
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          timeout: opts.timeout ?? 0,
        },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) code = typeof err.code === 'number' ? err.code : 1;
          resolve({
            ok: !err,
            code,
            signal: err?.signal ?? null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: err ? (err.killed ? 'Timed out' : err.message) : null,
          });
        },
      );
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e.message });
    }
  });
}

/** Spawn a process, do not buffer output, and wait for it to exit. */
function spawnWait(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        windowsHide: opts.windowsHide ?? true,
        detached: false,
        stdio: opts.stdio ?? 'ignore',
        cwd: opts.cwd,
        env: opts.env ?? process.env,
      });
    } catch (e) {
      resolve({ ok: false, code: -1, error: e.message });
      return;
    }
    const timer =
      opts.timeout > 0
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
          }, opts.timeout)
        : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, error: e.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: true, code: code ?? 0 });
    });
  });
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

module.exports = { run, spawnWait, nextId, DEFAULT_MAX_BUFFER };
