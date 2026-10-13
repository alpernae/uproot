'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeName,
  compactKey,
  matchScore,
  isSafeEntryName,
  isPathInside,
  extractPathsFromCommandLine,
  confidenceOf,
} = require('../src/main/util/names');

test('normalizeName strips versions, architectures and noise words', () => {
  assert.equal(normalizeName('Notepad++ (64-bit x64)'), 'notepad');
  assert.equal(normalizeName('Notepad++ v8.6.2'), 'notepad');
  assert.equal(compactKey('Git LFS 3.4.1'), 'gitlfs');
});

test('matchScore ranks exact, extension and token matches', () => {
  assert.equal(matchScore('Notepad++', 'notepad++'), 3);
  assert.equal(matchScore('Git', 'Git LFS'), 2);
  assert.equal(matchScore('Zoom', 'Visual Studio Code'), 0);
});

test('isSafeEntryName rejects separators and dot entries', () => {
  assert.equal(isSafeEntryName('Mozilla Firefox'), true);
  assert.equal(isSafeEntryName('..'), false);
  assert.equal(isSafeEntryName('a\\b'), false);
  assert.equal(isSafeEntryName(''), false);
});

test('isPathInside respects path boundaries', () => {
  assert.equal(isPathInside('C:\\Apps\\Foo', 'C:\\Apps\\Foo\\bin\\foo.exe'), true);
  assert.equal(isPathInside('C:\\Apps\\Foo', 'C:\\Apps\\FooBar\\foo.exe'), false);
});

test('extractPathsFromCommandLine finds quoted and bare paths', () => {
  assert.deepEqual(extractPathsFromCommandLine('"C:\\Program Files\\Foo\\unins000.exe" /SILENT'), [
    'C:\\Program Files\\Foo\\unins000.exe',
  ]);
  assert.deepEqual(extractPathsFromCommandLine('C:\\Tools\\x.exe --remove'), ['C:\\Tools\\x.exe']);
  assert.deepEqual(extractPathsFromCommandLine(''), []);
});

test('confidenceOf buckets scores', () => {
  assert.equal(confidenceOf(3), 'high');
  assert.equal(confidenceOf(2), 'medium');
  assert.equal(confidenceOf(1), 'low');
});
