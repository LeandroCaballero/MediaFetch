'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clock, hintFor, isPlaylistDownload, mergeOptions, parseUrl } = require('../app/server');

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
