'use strict';

/*
 * Rasterise build/icon.svg (and build/icon-small.svg for tiny sizes) into
 * build/icon.png and a multi-resolution build/icon.ico.
 *
 * Runs inside Electron so Chromium does the SVG rendering — no extra
 * dependencies. Usage: npm run icons
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const SMALL_MAX = 32;
const PNG_SIZE = 512;

function svgDataUrl(file) {
  return `data:image/svg+xml;base64,${fs.readFileSync(path.join(BUILD, file)).toString('base64')}`;
}

async function render(win, svgUrl, size) {
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG failed to load'));
      img.src = ${JSON.stringify(svgUrl)};
    })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');

  const full = svgDataUrl('icon.svg');
  const small = svgDataUrl('icon-small.svg');

  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, png: await render(win, size <= SMALL_MAX ? small : full, size) });
  }
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(images));
  fs.writeFileSync(path.join(BUILD, 'icon.png'), await render(win, full, PNG_SIZE));

  console.log(`Wrote icon.ico (${ICO_SIZES.join(', ')} px) and icon.png (${PNG_SIZE} px)`);
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
