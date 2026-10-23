'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeToDelete, quarantineDestFor, rebaseIntoBatch } = require('../src/main/leftovers/clean');
const { paths, isMachinePath } = require('../src/main/util/paths');
const { buildPlan } = require('../src/main/uninstall/plan');

const QUARANTINE = path.join(paths.appData, 'Uproot', 'quarantine');

test('assertSafeToDelete refuses roots and protected directories', () => {
  assert.throws(() => assertSafeToDelete(paths.systemDrive, QUARANTINE), /drive root/);
  assert.throws(() => assertSafeToDelete(paths.programFiles, QUARANTINE));
  assert.throws(() => assertSafeToDelete(paths.windows, QUARANTINE));
  assert.throws(() => assertSafeToDelete(path.join(QUARANTINE, 'batch-x-1'), QUARANTINE), /quarantine/);
  assert.throws(() => assertSafeToDelete('', QUARANTINE));
});

test('assertSafeToDelete allows an application folder', () => {
  const target = path.join(paths.programFiles, 'Some Vendor', 'Some App');
  assert.equal(assertSafeToDelete(target, QUARANTINE), path.resolve(target));
});

test('quarantine paths are rebased when the data directory moves', () => {
  const oldBatch = path.join('C:\\Users\\u\\AppData\\Roaming\\App Remover\\quarantine', 'batch-abc-1');
  const newBatch = path.join(QUARANTINE, 'batch-abc-1');
  const dest = quarantineDestFor(oldBatch, 'C:\\Program Files\\Foo');
  assert.equal(rebaseIntoBatch(dest, newBatch), path.join(newBatch, 'files', 'C', 'Program Files', 'Foo'));
  assert.equal(rebaseIntoBatch('D:\\elsewhere\\x.reg', newBatch), 'D:\\elsewhere\\x.reg');
});

test('isMachinePath respects directory boundaries', () => {
  assert.equal(isMachinePath(path.join(paths.programFiles, 'Foo')), true);
  assert.equal(isMachinePath(path.join(paths.localAppData, 'Foo')), false);
  assert.equal(isMachinePath(`${paths.programData}Extra\\Foo`), false);
});

test('buildPlan prefers a silent MSI removal', () => {
  const plan = buildPlan({
    id: 'reg:x',
    name: 'Thing',
    registry: [
      { uninstallString: 'MsiExec.exe /X{12345678-1234-1234-1234-1234567890AB}', isMachineScope: true },
    ],
  });
  assert.equal(plan.method, 'msi-silent');
  assert.equal(plan.msiProductCode, '{12345678-1234-1234-1234-1234567890AB}');
  assert.equal(plan.needsAdmin, true);
});

test('buildPlan falls back to the interactive vendor uninstaller', () => {
  const plan = buildPlan({ id: 'reg:y', name: 'Y', registry: [{ uninstallString: '"C:\\Y\\uninstall.exe"' }] });
  assert.equal(plan.method, 'vendor-interactive');
  assert.equal(plan.interactive, true);
});

test('buildPlan reports entries with nothing to run', () => {
  assert.equal(buildPlan({ id: 'z', name: 'Z', registry: [] }).possible, false);
});

test('buildPlan activates force only for MSIX packages', () => {
  const plan = buildPlan(
    { id: 'reg:x', name: 'X', packageFullName: 'Foo.Pkg_1.0_x64__deadbeef', registry: [] },
    { force: true },
  );
  assert.equal(plan.method, 'appx');
  assert.equal(plan.force, true);
  assert.ok(plan.notes.some((n) => /override/i.test(n)), 'the override is explained in the plan notes');
});

test('buildPlan leaves vendor uninstallers untouched by force', () => {
  const plan = buildPlan(
    { id: 'reg:y', name: 'Y', registry: [{ uninstallString: '"C:\\Y\\uninstall.exe"' }] },
    { force: true },
  );
  assert.equal(plan.method, 'vendor-interactive');
  assert.equal(plan.force, false);
});
