'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseListTable } = require('../src/main/scan/winget');
const { mergeInventories } = require('../src/main/scan/apps');
const { extractJson, asArray } = require('../src/main/util/ps');

test('parseListTable reads the winget fixed-width table', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'winget-list2.txt'), 'utf8');
  const rows = parseListTable(text);
  assert.ok(rows.length > 50, `expected many rows, got ${rows.length}`);
  const appInstaller = rows.find((r) => r.wingetId === 'Microsoft.AppInstaller');
  assert.ok(appInstaller);
  assert.equal(appInstaller.source, 'winget');
  assert.equal(parseListTable('no table here').length, 0);
});

function regRow(keyName, name, extra = {}) {
  return {
    id: `reg:HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${keyName}`,
    regPath: `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${keyName}`,
    keyName,
    name,
    version: '1.0',
    view: '64',
    isMachineScope: true,
    uninstallString: 'C:\\x\\uninst.exe',
    ...extra,
  };
}

test('mergeInventories joins winget ARP rows to their registry key', () => {
  const apps = mergeInventories({
    registry: [regRow('Foo_is1', 'Foo Editor')],
    winget: [{ id: 'winget:ARP\\Machine\\X64\\Foo_is1', name: 'Foo Editor', wingetId: 'ARP\\Machine\\X64\\Foo_is1', version: '1.0' }],
    appx: [],
  });
  assert.equal(apps.length, 1);
  assert.deepEqual(apps[0].sources, ['registry', 'winget']);
});

test('mergeInventories keeps unrelated products apart', () => {
  const apps = mergeInventories({
    registry: [regRow('A', 'Alpha'), regRow('B', 'Beta')],
    winget: [{ id: 'winget:Vendor.Gamma', name: 'Gamma', wingetId: 'Vendor.Gamma', version: '2.0' }],
    appx: [],
  });
  assert.deepEqual(apps.map((a) => a.name), ['Alpha', 'Beta', 'Gamma']);
});

test('extractJson recovers JSON behind a BOM or noise', () => {
  assert.deepEqual(extractJson('\uFEFF[1,2]').value, [1, 2]);
  assert.deepEqual(extractJson('WARNING: x\r\n{"a":1}').value, { a: 1 });
  assert.equal(extractJson('').ok, false);
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray(null), []);
});
