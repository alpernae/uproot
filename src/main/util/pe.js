'use strict';

const fs = require('node:fs');

/**
 * Minimal PE reader: extracts the DLL names a binary links against plus whether
 * it carries a CLR header (.NET). Import, delay-import and bound-import tables
 * are all consulted so delay-loaded runtimes are not missed.
 */
function readAt(fd, offset, length) {
  if (offset < 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, length, offset);
  } catch {
    return Buffer.alloc(0);
  }
  return buf.subarray(0, read);
}

function cString(fd, offset, max = 512) {
  if (offset < 0) return '';
  const b = readAt(fd, offset, max);
  const zero = b.indexOf(0);
  return b.toString('latin1', 0, zero < 0 ? b.length : zero);
}

const MACHINE = {
  0x014c: 'x86',
  0x8664: 'x64',
  0x01c0: 'arm',
  0xaa64: 'arm64',
  0x0200: 'ia64',
};

function parse(fd) {
  const dos = readAt(fd, 0, 64);
  if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') {
    return { ok: false, error: 'not a PE image' };
  }
  const peOffset = dos.readUInt32LE(0x3c);
  const coff = readAt(fd, peOffset, 24);
  if (coff.length < 24 || coff.toString('latin1', 0, 4) !== 'PE\u0000\u0000') {
    return { ok: false, error: 'bad PE signature' };
  }

  const machine = coff.readUInt16LE(4);
  const numberOfSections = coff.readUInt16LE(6);
  const sizeOfOptionalHeader = coff.readUInt16LE(20);
  const optionalOffset = peOffset + 24;
  const opt = readAt(fd, optionalOffset, sizeOfOptionalHeader);
  if (opt.length < 2) return { ok: false, error: 'missing optional header' };

  const magic = opt.readUInt16LE(0);
  const is64 = magic === 0x20b;
  const dataDirOffset = is64 ? 112 : 96;
  const numberOfRvaAndSizes = opt.length >= dataDirOffset ? opt.readUInt32LE(dataDirOffset - 4) : 0;

  const readDir = (index) => {
    if (index >= numberOfRvaAndSizes) return { rva: 0, size: 0 };
    const off = dataDirOffset + index * 8;
    if (off + 8 > opt.length) return { rva: 0, size: 0 };
    return { rva: opt.readUInt32LE(off), size: opt.readUInt32LE(off + 4) };
  };

  const sections = [];
  const sectionTableOffset = optionalOffset + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i += 1) {
    const sh = readAt(fd, sectionTableOffset + i * 40, 40);
    if (sh.length < 40) break;
    sections.push({
      virtualAddress: sh.readUInt32LE(12),
      virtualSize: sh.readUInt32LE(8),
      rawSize: sh.readUInt32LE(16),
      rawPointer: sh.readUInt32LE(20),
    });
  }

  const rvaToOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return -1;
  };

  const imports = new Set();

  // 1. Standard import table.
  const importDir = readDir(1);
  if (importDir.rva) {
    let off = rvaToOffset(importDir.rva);
    for (let i = 0; off > 0 && i < 512; i += 1) {
      const desc = readAt(fd, off, 20);
      if (desc.length < 20) break;
      const allZero = desc.every((b) => b === 0);
      if (allZero) break;
      const name = cString(fd, rvaToOffset(desc.readUInt32LE(12)));
      if (name) imports.add(name.toLowerCase());
      off += 20;
    }
  }

  // 2. Delay-load import table (32-byte descriptors, name at +4).
  const delayDir = readDir(13);
  if (delayDir.rva) {
    let off = rvaToOffset(delayDir.rva);
    for (let i = 0; off > 0 && i < 512; i += 1) {
      const desc = readAt(fd, off, 32);
      if (desc.length < 32 || desc.every((b) => b === 0)) break;
      const name = cString(fd, rvaToOffset(desc.readUInt32LE(4)));
      if (name) imports.add(name.toLowerCase());
      off += 32;
    }
  }

  // 3. Bound import table (8-byte entries, name is an offset from table start).
  const boundDir = readDir(11);
  if (boundDir.rva) {
    const tableStart = rvaToOffset(boundDir.rva);
    let off = tableStart;
    for (let i = 0; tableStart > 0 && i < 512; i += 1) {
      const entry = readAt(fd, off, 8);
      if (entry.length < 8 || entry.every((b) => b === 0)) break;
      const nameOffset = entry.readUInt16LE(4);
      const name = cString(fd, tableStart + nameOffset);
      if (name) imports.add(name.toLowerCase());
      off += 8;
    }
  }

  const isDotNet = readDir(14).rva > 0;

  return {
    ok: true,
    machine: MACHINE[machine] || `0x${machine.toString(16)}`,
    is64,
    isDotNet,
    imports: [...imports],
  };
}

function readImports(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    return parse(fd);
  } catch (e) {
    return { ok: false, error: e.message, imports: [], isDotNet: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { readImports };
