'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clock, findClouds, hintFor, isInside, isPlaylistDownload, mergeOptions, parseUrl } = require('../app/server');

test('clock muestra duraciones mayores a 24 horas sin reiniciarlas', () => {
  assert.equal(clock(0), '00:00:00');
  assert.equal(clock(3661), '01:01:01');
  assert.equal(clock(25 * 3600 + 61), '25:01:01');
});

test('parseUrl completa HTTPS y rechaza protocolos no HTTP', () => {
  assert.equal(parseUrl('youtu.be/abc123').href, 'https://youtu.be/abc123');
  assert.equal(parseUrl('https://www.youtube.com/watch?v=abc').hostname, 'www.youtube.com');
  assert.equal(parseUrl('file:///C:/video.mp4'), null);
  assert.equal(parseUrl('no-es-un-link'), null);
});

test('isPlaylistDownload distingue una playlist pura de un video dentro de una lista', () => {
  const pure = new URL('https://www.youtube.com/playlist?list=PL123');
  const video = new URL('https://www.youtube.com/watch?v=abc&list=PL123');
  assert.equal(isPlaylistDownload(pure, { playlist: false }), true);
  assert.equal(isPlaylistDownload(video, { playlist: false }), false);
  assert.equal(isPlaylistDownload(video, { playlist: true }), true);
});

test('mergeOptions solo acepta valores y rutas Windows válidos', () => {
  const base = { format: 'mp3', metadata: true, outputDir: 'C:\\Music' };
  assert.deepEqual(
    mergeOptions(base, { format: 'mp4', metadata: false, outputDir: 'D:\\Descargas', unknown: true }),
    { format: 'mp4', metadata: false, outputDir: 'D:\\Descargas' },
  );
  assert.deepEqual(mergeOptions(base, { format: 'wav', metadata: 'no', outputDir: '..\\tmp' }), base);
});

test('hintFor ofrece una ayuda concreta para errores frecuentes', () => {
  assert.match(hintFor('HTTP Error 403: Forbidden'), /actualizando yt-dlp/);
  assert.match(hintFor('Sign in to confirm you are not a bot'), /confirmar/);
  assert.equal(hintFor('fallo desconocido'), null);
});

test('isInside compara rutas de Windows sin mayúsculas y sin confundir prefijos', () => {
  assert.equal(isInside('C:\\Users\\ana\\OneDrive\\MediaFetch', 'c:\\users\\ana\\onedrive'), true);
  assert.equal(isInside('C:\\Users\\ana\\OneDrive', 'C:\\Users\\ana\\OneDrive\\'), true);
  assert.equal(isInside('C:\\Users\\ana\\OneDrive2', 'C:\\Users\\ana\\OneDrive'), false);
});

test('findClouds encuentra OneDrive, Google Drive, Dropbox e iCloud sin repetirlos', () => {
  const existing = new Set([
    'C:\\Users\\ana\\OneDrive', 'C:\\Users\\ana\\OneDrive - Empresa',
    'C:\\Program Files\\Google\\Drive File Stream', 'G:\\Mi unidad',
    'D:\\Dropbox', 'C:\\Users\\ana\\iCloudDrive',
  ]);
  const dropboxInfo = 'C:\\Users\\ana\\AppData\\Local\\Dropbox\\info.json';
  const clouds = findClouds({
    env: {
      OneDrive: 'C:\\Users\\ana\\OneDrive',
      OneDriveConsumer: 'C:\\Users\\ana\\OneDrive',
      OneDriveCommercial: 'C:\\Users\\ana\\OneDrive - Empresa',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
    },
    home: 'C:\\Users\\ana',
    exists: dir => existing.has(dir),
    read: file => (file === dropboxInfo ? JSON.stringify({ personal: { path: 'D:\\Dropbox' } }) : null),
  });
  assert.deepEqual(clouds, [
    { name: 'OneDrive', dir: 'C:\\Users\\ana\\OneDrive' },
    { name: 'OneDrive - Empresa', dir: 'C:\\Users\\ana\\OneDrive - Empresa' },
    { name: 'Google Drive', dir: 'G:\\Mi unidad' },
    { name: 'Dropbox', dir: 'D:\\Dropbox' },
    { name: 'iCloud Drive', dir: 'C:\\Users\\ana\\iCloudDrive' },
  ]);
});

test('findClouds no mira la unidad G: si Google Drive no está instalado', () => {
  const looked = [];
  const clouds = findClouds({
    env: { ProgramFiles: 'C:\\Program Files' },
    home: 'C:\\Users\\ana',
    exists: dir => { looked.push(dir); return false; },
    read: () => '{no es json',
  });
  assert.deepEqual(clouds, []);
  assert.equal(looked.some(dir => dir.startsWith('G:')), false);
});
