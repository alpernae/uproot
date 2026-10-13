'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toRegPath, toPsPath, hiveOf, isMachineScope } = require('../src/main/util/registry');

test('toRegPath canonicalises every path shape we meet', () => {
  const want = 'HKLM\\SOFTWARE\\Vendor';
  assert.equal(toRegPath('HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor'), want);
  assert.equal(toRegPath('HKLM:\\SOFTWARE\\Vendor'), want);
  assert.equal(toRegPath('Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor'), want);
  assert.equal(toRegPath('HKCU'), 'HKCU');
});

test('toPsPath produces a provider path', () => {
  assert.equal(toPsPath('HKEY_CURRENT_USER\\Software\\X'), 'HKCU:\\Software\\X');
});

test('scope helpers', () => {
  assert.equal(hiveOf('HKEY_USERS\\S-1-5-21\\Software'), 'HKU');
  assert.equal(isMachineScope('HKLM\\SOFTWARE'), true);
  assert.equal(isMachineScope('HKCU\\Software'), false);
});
