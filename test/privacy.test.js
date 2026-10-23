'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const privacy = require('../src/main/privacy/privacy');

const APP_EXP = '\\Microsoft\\Windows\\Application Experience\\';
const CEIP = '\\Microsoft\\Windows\\Customer Experience Improvement Program\\';

test('service catalog exposes only badged telemetry services', () => {
  for (const entry of privacy.SERVICE_CATALOG) {
    assert.match(entry.name, /^[\w.]+$/, 'service name must be a plain service key');
    assert.ok(entry.displayName, 'displayName is required');
    assert.ok(entry.why, 'why is required');
  }
  const names = privacy.SERVICE_CATALOG.map((s) => s.name);
  assert.ok(names.includes('DiagTrack'));
  assert.ok(names.includes('WerSvc'));
});

test('serviceFindings maps live rows and marks optional services unchecked', () => {
  const rows = [
    { name: 'DiagTrack', displayName: 'Connected User Experiences and Telemetry', state: 'Running', startMode: 'Auto' },
    { name: 'WerSvc', displayName: 'Windows Error Reporting Service', state: 'Stopped', startMode: 'Manual' },
    { name: 'Spooler', displayName: 'Print Spooler', state: 'Running' },
  ];
  const findings = privacy.serviceFindings(rows, {});
  assert.equal(findings.length, 2);
  const diag = findings.find((f) => f.name === 'DiagTrack');
  assert.equal(diag.checked, true);
  assert.equal(diag.confidence, 'high');
  assert.equal(diag.admin, true);
  const wer = findings.find((f) => f.name === 'WerSvc');
  assert.equal(wer.optional, true);
  assert.equal(wer.checked, false);
  assert.equal(wer.confidence, 'medium');
});

test('serviceFindings can be switched off by settings', () => {
  assert.deepEqual(privacy.serviceFindings([{ name: 'DiagTrack' }], { includeServices: false }), []);
});

test('taskFindings only reports catalog roots and skips benign tasks', () => {
  const rows = [
    { taskName: 'Microsoft Compatibility Appraiser', taskPath: APP_EXP, target: 'CompatTelRunner.exe' },
    { taskName: 'StartupAppTask', taskPath: APP_EXP },
    { taskName: 'Consolidator', taskPath: CEIP },
    { taskName: 'QueueReporting', taskPath: '\\Microsoft\\Windows\\Windows Error Reporting\\' },
    { taskName: 'Defrag', taskPath: '\\Microsoft\\Windows\\Defrag\\' },
  ];
  const findings = privacy.taskFindings(rows, {});
  const names = findings.map((f) => f.taskName);
  assert.ok(names.includes('Microsoft Compatibility Appraiser'));
  assert.ok(names.includes('Consolidator'));
  assert.ok(names.includes('QueueReporting'));
  assert.ok(!names.includes('StartupAppTask'), 'StartupAppTask is not telemetry');
  assert.ok(!names.includes('Defrag'), 'outside the catalog roots');
  for (const f of findings) {
    assert.equal(f.kind, 'task');
    assert.equal(f.admin, true);
    assert.ok(f.taskPath.startsWith('\\Microsoft\\Windows\\'));
  }
});

test('task path matching is case-insensitive and tolerates a missing backslash', () => {
  assert.ok(privacy.taskMatch('microsoft\\windows\\feedback\\Siuf'));
  assert.ok(privacy.taskMatch('\\Microsoft\\Windows\\Application Experience\\'));
  assert.equal(privacy.taskMatch('\\Microsoft\\Windows\\SystemRestore\\'), null);
  assert.equal(privacy.taskMatch(''), null);
});

test('taskFindings follows the settings toggle', () => {
  const rows = [{ taskName: 'Consolidator', taskPath: CEIP }];
  assert.deepEqual(privacy.taskFindings(rows, { includeTasks: false }), []);
});

test('fileFindings reports existing stores with correct scope flags', () => {
  const base = { localAppData: 'C:\\Users\\u\\AppData\\Local', programData: 'C:\\ProgramData' };
  const existing = new Set([
    'C:\\Users\\u\\AppData\\Local\\ConnectedDevicesPlatform',
    'C:\\ProgramData\\Microsoft\\Windows\\WER',
  ]);
  const findings = privacy.fileFindings(
    base,
    (p) => existing.has(p),
    {},
  );
  const byId = new Map(findings.map((f) => [f.id, f]));
  assert.ok(byId.has('dp:file:cdp'), 'activity history store found');
  assert.ok(byId.has('dp:file:wer-machine'), 'machine WER store found');
  assert.ok(!byId.has('dp:file:siuf'), 'missing store not reported');
  const cdp = byId.get('dp:file:cdp');
  assert.equal(cdp.admin, false);
  assert.equal(cdp.kind, 'file');
  const wer = byId.get('dp:file:wer-machine');
  assert.equal(wer.admin, true);
  assert.equal(wer.path, 'C:\\ProgramData\\Microsoft\\Windows\\WER');
});

test('fileFindings respects the history toggle and is safe on bad exists handlers', () => {
  const base = { localAppData: 'C:\\u\\Local' };
  assert.deepEqual(privacy.fileFindings(base, () => true, { includeHistory: false }), []);
  assert.deepEqual(privacy.fileFindings({ localAppData: undefined }, () => true, {}), []);
  const boom = privacy.fileFindings(base, () => {
    throw new Error('fs error');
  });
  assert.deepEqual(boom, []);
});

test('buildRemovalPayload maps findings onto the cleanup job', () => {
  const payload = privacy.buildRemovalPayload([
    { kind: 'service', name: 'DiagTrack' },
    { kind: 'task', taskName: 'Consolidator', taskPath: CEIP },
    { kind: 'file', path: path.join('C:', 'Users', 'u', 'AppData', 'Local', 'ConnectedDevicesPlatform') },
  ]);
  assert.deepEqual(payload.registryKeys, []);
  assert.deepEqual(payload.files, [
    { path: path.join('C:', 'Users', 'u', 'AppData', 'Local', 'ConnectedDevicesPlatform') },
  ]);
  assert.deepEqual(payload.system, [
    { type: 'service', name: 'DiagTrack' },
    { type: 'task', taskName: 'Consolidator', taskPath: CEIP },
  ]);
});

test('buildRemovalPayload reacts to unsupported kinds and missing identifiers', () => {
  assert.throws(() => privacy.buildRemovalPayload([{ kind: 'mystery', name: 'x' }]));
  assert.throws(() => privacy.buildRemovalPayload([{ kind: 'service', name: '' }]));
  assert.throws(() => privacy.buildRemovalPayload([{ kind: 'task' }]));
  assert.throws(() => privacy.buildRemovalPayload([{ kind: 'file', path: '' }]));
  assert.deepEqual(privacy.buildRemovalPayload([]), { files: [], registryKeys: [], system: [] });
});
