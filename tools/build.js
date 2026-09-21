'use strict';
/*
 * Arma MediaFetch portátil: MediaFetch.exe, app/ y bin/ con Node, yt-dlp y FFmpeg adentro, así quien lo
 * baja no tiene que instalar ni descargar nada más.
 *
 *   node tools/build.js        Baja a bin/ lo que falte y compila MediaFetch.exe: después, doble clic en él.
 *   node tools/build.js --zip  Además arma dist/MediaFetch-win64.zip, el que se publica en los Releases.
 *
 * Las versiones, URLs y SHA-256 están en dependencies.json; lo que se baja queda en dist/cache/.
 * MediaFetch.exe se compila con el csc.exe que trae Windows, así que corre en Windows o en WSL.
 * No tiene dependencias: alcanza con Node 22 o más nuevo.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const CACHE_DIR = path.join(ROOT, 'dist', 'cache');
const ZIP_FILE = path.join(ROOT, 'dist', 'MediaFetch-win64.zip');
const EXE = path.join(ROOT, 'MediaFetch.exe');
const LAUNCHER_DIR = path.join(ROOT, 'launcher');
const DEPENDENCIES = require('./dependencies.json');

// Lo que va en el ZIP además de MediaFetch.exe y las dependencias, tal como está en el repo.
const APP_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'app/index.html', 'app/server.js', 'bin/download.bat'];

// El compilador de C# de .NET Framework 4, que viene con Windows 10 y 11. Desde WSL, el de Windows.
const CSC = process.platform === 'win32'
  ? path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  : '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

/** Baja una dependencia (o la toma de dist/cache/) y verifica su SHA-256. */
async function download(dep) {
  const file = path.join(CACHE_DIR, path.basename(new URL(dep.url).pathname));
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file);
    if (sha256(cached) === dep.sha256) return cached;
  }
  console.log(`Bajando ${dep.url}`);
  const res = await fetch(dep.url);
  if (!res.ok) throw new Error(`${dep.url} respondió ${res.status}.`);
  const data = Buffer.from(await res.arrayBuffer());
  if (sha256(data) !== dep.sha256) throw new Error(`El SHA-256 de ${dep.url} no es el de dependencies.json.`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, data);
  return data;
}

/** Los archivos de una dependencia, como { 'ruta dentro de bin/': contenido }. */
async function dependencyFiles(dep) {
  const data = await download(dep);
  const extract = dep.url.endsWith('.zip') ? readZip(data) : () => data;
  return Object.fromEntries(Object.entries(dep.files).map(([source, target]) => [target, extract(source)]));
}

/** Lee un .zip en memoria y devuelve una función que extrae un archivo por su ruta adentro del zip. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (end < 0) throw new Error('No es un archivo .zip.');
  const entries = new Map();
  let p = buffer.readUInt32LE(end + 16);
  for (let count = buffer.readUInt16LE(end + 10); count > 0; count--) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('El .zip está dañado.');
    const nameLength = buffer.readUInt16LE(p + 28);
    entries.set(buffer.toString('utf8', p + 46, p + 46 + nameLength), {
      method: buffer.readUInt16LE(p + 10),
      crc: buffer.readUInt32LE(p + 16),
      size: buffer.readUInt32LE(p + 20),
      offset: buffer.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return name => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`No está ${name} en el .zip.`);
    // Los datos van después del encabezado local, que tiene su propio largo de nombre y de extras.
    const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28);
    const raw = buffer.subarray(start, start + entry.size);
    const data = entry.method === 8 ? zlib.inflateRawSync(raw) : entry.method === 0 ? raw : null;
    if (!data || zlib.crc32(data) !== entry.crc) throw new Error(`No se pudo extraer ${name} del .zip.`);
    return data;
  };
}

/** Escribe un .zip con `files` ({ 'ruta/adentro/del/zip': contenido }). */
function writeZip(file, files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const [name, data] of Object.entries(files)) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const stored = deflated.length >= data.length; // lo que no se achica se guarda tal cual
      const body = stored ? data : deflated;
      const nameBytes = Buffer.from(name);
      // Los campos que comparten el encabezado local y el del directorio central.
      const fields = Buffer.alloc(26);
      fields.writeUInt16LE(20, 0);             // versión necesaria para extraer: 2.0
      fields.writeUInt16LE(0x0800, 2);         // nombres en UTF-8
      fields.writeUInt16LE(stored ? 0 : 8, 4); // sin comprimir o deflate
      fields.writeUInt16LE(time, 6);
      fields.writeUInt16LE(date, 8);
      fields.writeUInt32LE(zlib.crc32(data), 10);
      fields.writeUInt32LE(body.length, 14);
      fields.writeUInt32LE(data.length, 18);
      fields.writeUInt16LE(nameBytes.length, 22);
      for (const part of [uint32(0x04034b50), fields, nameBytes, body]) fs.writeSync(fd, part);
      // Versión con la que se hizo, los campos, comentario/disco/atributos en cero y dónde empieza.
      central.push(Buffer.concat([uint32(0x02014b50), uint16(20), fields, Buffer.alloc(10), uint32(offset), nameBytes]));
      offset += 30 + nameBytes.length + body.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, directory);
    fs.writeSync(fd, end);
  } finally {
    fs.closeSync(fd);
  }
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/** Compila MediaFetch.exe: un programa de ventana, sin consola, con el ícono de la app. */
function compileLauncher() {
  if (!fs.existsSync(CSC)) throw new Error(`No encuentro ${CSC}: MediaFetch.exe se compila en Windows o en WSL.`);
  // csc.exe es un programa de Windows: desde WSL hay que pasarle las rutas como las ve Windows.
  const winPath = file => (process.platform === 'win32' ? file : execFileSync('wslpath', ['-w', file], { encoding: 'utf8' }).trim());
  execFileSync(CSC, [
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001', '/reference:System.Windows.Forms.dll',
    `/win32icon:${winPath(path.join(LAUNCHER_DIR, 'mediafetch.ico'))}`,
    `/out:${winPath(EXE)}`,
    winPath(path.join(LAUNCHER_DIR, 'MediaFetch.cs')),
  ], { stdio: 'inherit' });
}

async function main() {
  const zip = process.argv.includes('--zip');
  const packaged = {};
  for (const [name, dep] of Object.entries(DEPENDENCIES)) {
    // A bin/ solo se agrega lo que falta: yt-dlp.exe se actualiza solo y no hay que volverlo atrás.
    const missing = Object.values(dep.files).filter(target => !fs.existsSync(path.join(BIN_DIR, target)));
    if (!missing.length && !zip) continue;
    const files = await dependencyFiles(dep);
    for (const target of missing) {
      fs.mkdirSync(path.dirname(path.join(BIN_DIR, target)), { recursive: true });
      fs.writeFileSync(path.join(BIN_DIR, target), files[target]);
    }
    // El ZIP lleva siempre las versiones de dependencies.json, aunque las de bin/ se hayan actualizado.
    for (const [target, data] of Object.entries(files)) packaged[`bin/${target}`] = data;
    console.log(`${name} ${dep.version}: listo`);
  }
  compileLauncher();
  console.log(`Listo: ${EXE}`);
  if (!zip) return;

  const files = { 'MediaFetch.exe': fs.readFileSync(EXE) };
  for (const file of APP_FILES) {
    const data = fs.readFileSync(path.join(ROOT, file));
    // cmd.exe necesita saltos de línea de Windows, aunque el repo esté en Linux o WSL.
    files[file] = file.endsWith('.bat') ? Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n')) : data;
  }
  Object.assign(files, packaged);
  writeZip(ZIP_FILE, Object.fromEntries(Object.entries(files).map(([name, data]) => [`MediaFetch/${name}`, data])));
  const hash = sha256(fs.readFileSync(ZIP_FILE));
  fs.writeFileSync(`${ZIP_FILE}.sha256`, `${hash}  ${path.basename(ZIP_FILE)}\n`);
  console.log(`Listo: ${ZIP_FILE}\nSHA-256: ${hash}`);
}

module.exports = { readZip, writeZip };

if (require.main === module) {
  main().catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
