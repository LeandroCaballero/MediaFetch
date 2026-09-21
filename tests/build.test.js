'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readZip, writeZip } = require('../tools/build');

test('writeZip arma un .zip que readZip vuelve a leer igual', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajalo-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prueba.zip');
  const files = {
    'Bajalo/texto.txt': Buffer.from('se comprime bien '.repeat(1000)),
    'Bajalo/bin/azar.bin': crypto.randomBytes(4096), // no se achica: va sin comprimir
    'Bajalo/canción ñandú.txt': Buffer.from('nombre con tildes'),
    'Bajalo/vacío.txt': Buffer.alloc(0),
  };
  writeZip(file, files);
  const extract = readZip(fs.readFileSync(file));
  for (const [name, data] of Object.entries(files)) assert.deepEqual(extract(name), data);
  assert.throws(() => extract('Bajalo/no-existe.txt'), /No está/);
});

test('readZip rechaza lo que no es un .zip', () => {
  assert.throws(() => readZip(Buffer.from('esto no es un zip')), /No es un archivo .zip/);
});
