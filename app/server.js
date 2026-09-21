'use strict';
/*
 * Bajalo: interfaz local para bajar música y videos con yt-dlp.
 *
 *   node server.js              Lanzador (lo usa Bajalo.exe): levanta el servidor en
 *                               segundo plano si no está corriendo y abre la ventana.
 *   node server.js --no-window  Igual, pero sin abrir la ventana.
 *   node server.js --serve      Corre el servidor en primer plano (para depurar).
 *
 * Escucha solo en 127.0.0.1, guarda las opciones en settings.json y su log en server.log.
 * Se cierra cuando se cierra la última ventana: cancela lo pendiente y no deja procesos abiertos.
 * No tiene dependencias: alcanza con Node.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BAJALO_PORT) || 17865;
const ORIGIN = `http://${HOST}:${PORT}`;

const APP_DIR = __dirname;
const BIN_DIR = path.resolve(APP_DIR, '..', 'bin');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE = path.join(BIN_DIR, 'ffprobe.exe');
const INDEX_FILE = path.join(APP_DIR, 'index.html');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const LOG_FILE = path.join(APP_DIR, 'server.log');

// Si este archivo cambia, el lanzador reemplaza al servidor viejo que haya quedado corriendo.
const BUILD = String(fs.statSync(__filename).mtimeMs);
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toLocaleTimeString('es-AR'), ...args);
const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Opciones

const DEFAULTS = {
  format: 'mp3',           // mp3 | m4a | mp4
  audioQuality: '0',       // MP3: '0' es VBR de máxima calidad; si no, un bitrate fijo
  videoQuality: '1080',    // MP4: altura máxima, o 'best'
  metadata: true,          // portada y datos (título, artista…) dentro del archivo
  cleanTitle: true,        // sacar "(Official Video)", "[Lyrics]", etc. del título
  playlist: false,         // con links watch?v=…&list=…, bajar la playlist entera
  splitChapters: false,    // además del archivo completo, una pista por capítulo
  // Fuera de la carpeta de Bajalo: así no se pierde nada al reemplazarla por una versión nueva.
  outputDir: path.join(os.homedir(), 'Music', 'Bajalo'),
  autoUpdate: true,        // actualizar yt-dlp (una vez por día) al abrir la app
};
const CHOICES = {
  format: ['mp3', 'm4a', 'mp4'],
  audioQuality: ['0', '320K', '192K', '128K'],
  videoQuality: ['1080', '720', '480', 'best'],
};
const FLAGS = ['metadata', 'cleanTitle', 'playlist', 'splitChapters', 'autoUpdate'];

const isFullPath = dir => /^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)/.test(dir);

/** Devuelve `base` con los valores válidos de `input` aplicados; lo demás se ignora. */
function mergeOptions(base, input) {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;
  for (const [key, allowed] of Object.entries(CHOICES)) if (allowed.includes(input[key])) out[key] = input[key];
  for (const key of FLAGS) if (typeof input[key] === 'boolean') out[key] = input[key];
  if (typeof input.outputDir === 'string') {
    const dir = path.normalize(input.outputDir.trim());
    if (isFullPath(dir)) out.outputDir = dir;
  }
  return out;
}

let lastUpdateCheck = 0;
// La clave de Groq se guarda en settings.json (que no se sube al repo) pero nunca se manda a la página.
let groqKey = '';
let settings = loadSettings();

const publicSettings = () => ({ ...settings, groqKeySet: Boolean(groqKey) });

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    lastUpdateCheck = Number(saved.lastUpdateCheck) || 0;
    groqKey = typeof saved.groqKey === 'string' ? saved.groqKey : '';
    return mergeOptions(DEFAULTS, saved);
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  const saved = { ...settings, lastUpdateCheck, groqKey };
  // La carpeta por defecto no se guarda: si Bajalo se copia a otra PC, sigue siendo la de ese usuario.
  if (saved.outputDir === DEFAULTS.outputDir) delete saved.outputDir;
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(saved, null, 2));
  } catch (e) {
    log(`No se pudieron guardar las opciones: ${e.message}`);
  }
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    log(`No se pudo borrar ${file}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Argumentos de yt-dlp

// Saca del título cosas como "(Official Video)", "[Lyrics]" o "(Video Oficial)".
const CLEAN_TITLE_RE = String.raw`(?i)\s*[(\[](?:official|oficial|video|videoclip|audio|lyrics?|letra|con letra|visuali[sz]er|sub\w*|hd|hq|4k)\b[^)\]]*[)\]]`;

// Líneas "@@..." que yt-dlp imprime para que el servidor siga el progreso (ver handleTag).
const MACHINE_OUTPUT = [
  // No heredar yt-dlp.conf del usuario ni de la carpeta del ejecutable: la interfaz necesita
  // controlar estos argumentos para interpretar correctamente la salida.
  '--ignore-config',
  // yt-dlp.exe ignora PYTHONIOENCODING y escribe en la codificación de la consola (cp1252),
  // lo que rompe las rutas con tildes que leemos del log.
  '--encoding', 'utf-8',
  '--newline', '--color', 'never', '--no-quiet', '--no-simulate', '--progress-delta', '0.25',
  '--progress-template', 'download:@@PROGRESS %(info.vcodec|)s|%(info.acodec|)s|%(progress.{downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta})j',
  '--progress-template', 'postprocess:@@STEP %(progress.{status,postprocessor})j',
  '--print', 'before_dl:@@VIDEO %(.{title,thumbnail,duration,album,chapters,playlist_index,n_entries,playlist_title})j',
  '--print', 'after_move:@@SAVED %(filepath)j',
];

function isPlaylistDownload(url, opts) {
  const hasList = url.searchParams.has('list');
  const isVideo = url.searchParams.has('v') || url.hostname.endsWith('youtu.be') || /^\/(shorts|live)\//.test(url.pathname);
  // Un link de playlist pura se baja entero; el de un video dentro de una lista, solo si se pidió.
  return hasList && (!isVideo || opts.playlist);
}

function buildArgs(job) {
  const { opts } = job;
  const playlist = isPlaylistDownload(new URL(job.url), opts);
  const args = [
    // Sin un motor de JavaScript, YouTube responde 403 al bajar, y yt-dlp solo busca Deno por
    // defecto: le pasamos el mismo Node que corre este servidor.
    '--js-runtimes', `node:${process.execPath}`,
    // La ruta del .exe y no la carpeta: con la carpeta, yt-dlp busca "bin\ffmpeg" sin extensión y
    // se confunde si hay una carpeta con ese nombre.
    '--ffmpeg-location', FFMPEG,
    ...MACHINE_OUTPUT,
    '--windows-filenames',
    '-P', opts.outputDir,
    '-o', playlist ? '%(playlist_title,playlist_id)s/%(playlist_index)s - %(title)s.%(ext)s' : '%(title)s.%(ext)s',
    playlist ? '--yes-playlist' : '--no-playlist',
  ];
  if (opts.format === 'mp4') {
    const res = opts.videoQuality === 'best' ? 'res' : `res:${opts.videoQuality}`;
    // A igual resolución preferimos H.264 + AAC, que se reproducen en cualquier lado.
    args.push('-S', `${res},vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4', '--remux-video', 'mp4');
  } else if (opts.format === 'm4a') {
    // YouTube ya ofrece AAC en m4a: se guarda tal cual, sin recodificar.
    args.push('-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a');
  } else {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', opts.audioQuality);
  }
  if (opts.metadata) args.push('--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg');
  if (opts.cleanTitle) {
    args.push(
      '--replace-in-metadata', 'title', CLEAN_TITLE_RE, '',
      '--replace-in-metadata', 'title', String.raw`^\s+|\s+$`, '',
      '--replace-in-metadata', 'title', String.raw`\s{2,}`, ' ',
    );
  }
  if (opts.splitChapters) args.push('--split-chapters', '-o', 'chapter:%(title)s/%(section_number)02d - %(section_title)s.%(ext)s');
  args.push('--', job.url);
  return args;
}

// ---------------------------------------------------------------------------
// Descargas (de a una por vez, en orden)

const jobs = new Map();   // id → descarga, en orden de creación
let nextId = 1;
let active = null;        // la descarga que está corriendo

const publicJob = ({ _, ...job }) => job;
const busy = () => Boolean(active) || ytdlp.updating || [...jobs.values()].some(j => j.status === 'queued');

/** `fields`: { url, opts } para bajar de YouTube, o { kind: 'convert', source, title } para un archivo local. */
function createJob(fields) {
  const job = { id: String(nextId++), kind: 'download', title: null, thumbnail: null, ...fields };
  resetJob(job);
  jobs.set(job.id, job);
  flush(job);
  processQueue();
  return job;
}

function resetJob(job) {
  Object.assign(job, {
    status: 'queued', stage: null, percent: null, speed: null, eta: null,
    item: null, itemTitle: null, duration: null, files: [], size: 0, tracks: 0,
    already: false, error: null, hint: null,
  });
  // Estado interno: no se manda a la interfaz.
  job._ = {
    proc: null, finished: false, log: [], pendingLog: [], timer: null, temp: new Set(), tracks: [], video: {},
    outTime: 0, lastLine: null,
  };
}

function processQueue() {
  if (active || ytdlp.updating) return;
  const next = [...jobs.values()].find(j => j.status === 'queued');
  if (next) {
    void startJob(next).catch(async e => {
      log(`No se pudo iniciar la tarea ${next.id}: ${e.stack || e}`);
      await finishJob(next, -1, e.message || String(e));
    });
  }
}

async function startJob(job) {
  active = job;
  job.status = 'running';
  if (job.kind === 'convert') return await startConversion(job);
  if (job.kind === 'transcribe') return await startTranscription(job);
  job.stage = 'Buscando el video';
  flush(job);
  try {
    fs.mkdirSync(job.opts.outputDir, { recursive: true });
  } catch (e) {
    return finishJob(job, -1, `No se pudo usar la carpeta ${job.opts.outputDir}: ${e.message}`);
  }
  const args = buildArgs(job);
  log(`Descarga ${job.id}: yt-dlp ${args.join(' ')}`);
  const proc = spawnChild(YTDLP, args, { cwd: BIN_DIR });
  job._.proc = proc;
  readLines(proc.stdout, line => handleLine(job, line));
  readLines(proc.stderr, line => handleLine(job, line));
  proc.on('error', e => finishJob(job, -1, `No se pudo ejecutar yt-dlp: ${e.message}`));
  proc.on('close', code => finishJob(job, code));
}

// Los parámetros del comando de siempre: MP3 mono de 16 kHz y 32 kbps, liviano y claro para voz.
const VOICE_MP3 = ['-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k'];

/** Saca el audio de un video de la compu y lo deja al lado, como MP3 de voz. */
async function startConversion(job) {
  const output = freeName(replaceExt(job.source, '.mp3'));
  job._.temp.add(output);
  job.stage = 'Sacando el audio';
  flush(job);
  const code = await runFfmpeg(job, ['-n', '-i', job.source, ...VOICE_MP3, output]);
  if (code === 0) job.files.push(output);
  else if (job.status !== 'canceling' && job.status !== 'canceled') job.error ??= ffmpegError(job, code);
  finishJob(job, code);
}

/** Corre ffmpeg como paso de una tarea (con progreso y cancelable) y devuelve su código de salida. */
function runFfmpeg(job, args) {
  const fullArgs = ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args];
  log(`Tarea ${job.id}: ffmpeg ${fullArgs.join(' ')}`);
  return new Promise(resolve => {
    const proc = spawnChild(FFMPEG, fullArgs);
    job._.proc = proc;
    readLines(proc.stdout, line => handleConversionLine(job, line));
    readLines(proc.stderr, line => handleConversionLine(job, line));
    proc.on('error', e => {
      job._.proc = null;
      job._.lastLine = `No se pudo ejecutar ffmpeg: ${e.message}`;
      resolve(-1);
    });
    proc.on('close', code => {
      job._.proc = null;
      resolve(code);
    });
  });
}

function ffmpegError(job, code) {
  if (job._.log.some(line => /does not contain any stream|matches no streams/.test(line))) return 'Ese archivo no tiene audio.';
  return job._.lastLine || `ffmpeg terminó con código ${code}.`;
}

function handleConversionLine(job, line) {
  let m;
  if ((m = /^out_time_us=(\d+)$/.exec(line))) {
    job._.outTime = Number(m[1]) / 1e6;
    if (job.duration) job.percent = Math.min(100, (100 * job._.outTime) / job.duration);
  } else if ((m = /^speed=\s*([\d.]+)x$/.exec(line))) {
    const speed = Number(m[1]);
    if (job.duration && speed > 0) job.eta = Math.max(0, (job.duration - job._.outTime) / speed);
  } else if (/^\w+=/.test(line)) {
    return; // el resto del bloque de -progress no nos interesa
  } else if (line.trim()) {
    addLog(job, line);
    job._.lastLine = line.trim();
    if ((m = /^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line))) {
      job.duration ??= Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
  }
  touch(job);
}

const replaceExt = (file, ext) => path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext);

/** `file` si está libre; si no, "nombre (2).ext", "nombre (3).ext", etc. Nunca pisa nada. */
function freeName(file) {
  const ext = path.extname(file);
  let candidate = file;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = replaceExt(file, ` (${i})${ext}`);
  return candidate;
}

// ---------------------------------------------------------------------------
// Transcripción con Groq: Whisper large-v3 en la nube, gratis con límites (console.groq.com)

const GROQ_API = process.env.BAJALO_GROQ_API || 'https://api.groq.com/openai/v1'; // se cambia para pruebas
const GROQ_MODEL = 'whisper-large-v3';   // el más preciso de los que ofrece Groq
const LANGUAGE = 'es';                   // fijarlo evita que Whisper adivine mal el idioma
const PART_SECONDS = 30 * 60;            // partes de 30 min (~7 MB): el límite gratis es 25 MB por archivo

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Whisper a veces inventa texto en los silencios ("Subtítulos realizados por la comunidad de
// Amara.org"): los descartamos con el mismo criterio que usa Whisper para detectar silencio.
const isSilence = segment => segment.no_speech_prob > 0.6 && segment.avg_logprob < -1;

/** Pasa el audio a MP3 de voz en partes, las transcribe con Groq y deja un .txt al lado del archivo. */
async function startTranscription(job) {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajalo-'));
    job._.abort = new AbortController();
    job.stage = 'Preparando el audio';
    flush(job);
    const code = await runFfmpeg(job, [
      '-i', job.source, ...VOICE_MP3,
      '-f', 'segment', '-segment_time', String(PART_SECONDS), '-reset_timestamps', '1', path.join(dir, 'parte%03d.mp3'),
    ]);
    if (job.status === 'canceling' || job.status === 'canceled') return finishJob(job, 1);
    if (code !== 0) return finishJob(job, code, ffmpegError(job, code));

    const parts = fs.readdirSync(dir).sort().map(name => path.join(dir, name));
    const lines = [];
    let offset = 0;
    for (const [i, part] of parts.entries()) {
      Object.assign(job, {
        stage: parts.length > 1 ? `Transcribiendo (parte ${i + 1} de ${parts.length})` : 'Transcribiendo',
        percent: parts.length > 1 ? (100 * i) / parts.length : null,
        eta: null,
      });
      flush(job);
      const result = await transcribePart(job, part);
      for (const segment of result.segments ?? []) {
        const text = (segment.text || '').trim();
        if (text && !isSilence(segment)) lines.push(`[${clock(offset + segment.start)}] ${text}`);
      }
      offset += result.duration ?? PART_SECONDS;
    }
    const output = freeName(replaceExt(job.source, '.txt'));
    fs.writeFileSync(output, `${lines.join('\n')}\n`);
    job.files.push(output);
    finishJob(job, 0);
  } catch (e) {
    finishJob(job, 1, job.status === 'canceling' || job.status === 'canceled' ? null : e.message);
  } finally {
    job._.abort = null;
    if (dir) fs.rm(dir, { recursive: true, force: true }, e => { if (e) log(`No se pudo borrar ${dir}: ${e.message}`); });
  }
}

/** Manda una parte a Groq. Si se llega al límite gratis, espera lo que Groq indica y reintenta. */
async function transcribePart(job, file) {
  const { signal } = job._.abort;
  const stage = job.stage;
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append('file', await fs.openAsBlob(file, { type: 'audio/mpeg' }), path.basename(file));
    form.append('model', GROQ_MODEL);
    form.append('language', LANGUAGE);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    let res;
    try {
      res = await fetch(`${GROQ_API}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${groqKey}` }, body: form, signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error('No me pude conectar con Groq. ¿Hay internet?');
    }
    if (res.ok) return res.json();
    if (res.status === 401) throw new Error('La clave de Groq no es válida: revisala en Opciones.');
    const detail = (await res.json().catch(() => null))?.error?.message || res.statusText;
    if (res.status !== 429 || attempt > 5) throw new Error(`Groq respondió ${res.status}: ${detail}`);
    const seconds = Number(res.headers.get('retry-after')) || 60;
    Object.assign(job, { stage: `Esperando el límite gratis de Groq (${Math.ceil(seconds)} s)`, percent: null });
    flush(job);
    await wait(seconds * 1000, undefined, { signal });
    job.stage = stage;
    flush(job);
  }
}

async function verifyGroqKey(key) {
  let res;
  try {
    res = await fetch(`${GROQ_API}/models`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new HttpError(502, 'No me pude conectar con Groq para verificar la clave. ¿Hay internet?');
  }
  if (res.status === 401) throw new HttpError(400, 'Esa clave no es válida. Copiala de nuevo desde console.groq.com → API Keys.');
  if (!res.ok) throw new HttpError(502, `Groq respondió ${res.status} al verificar la clave.`);
}

function readLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const lines = (buffer + chunk).split(/\r\n|\r|\n/);
    buffer = lines.pop();
    lines.forEach(onLine);
  });
  stream.on('end', () => buffer && onLine(buffer));
}

function handleLine(job, line) {
  if (!line.trim()) return;
  const tagged = /^@@(\w+) (.*)$/.exec(line);
  if (tagged) {
    handleTag(job, tagged[1], tagged[2]);
  } else {
    addLog(job, line);
    trackFiles(job, line);
  }
  touch(job);
}

function handleTag(job, tag, payload) {
  if (tag === 'PROGRESS') {
    const [, vcodec, acodec, json] = /^([^|]*)\|([^|]*)\|(.*)$/.exec(payload) || [];
    const p = parseJson(json);
    if (!p) return;
    const video = vcodec && vcodec !== 'none';
    const audio = acodec && acodec !== 'none';
    const total = p.total_bytes || p.total_bytes_estimate;
    job.stage = video && !audio ? 'Descargando video' : audio && !video ? 'Descargando audio' : 'Descargando';
    job.percent = total && p.downloaded_bytes != null ? Math.min(100, (100 * p.downloaded_bytes) / total) : null;
    job.speed = p.speed ?? null;
    job.eta = p.eta ?? null;
  } else if (tag === 'STEP') {
    const p = parseJson(payload);
    const stage = p?.status === 'started' && stepLabel(p.postprocessor, job.opts);
    if (stage) Object.assign(job, { stage, percent: null, speed: null, eta: null });
  } else if (tag === 'VIDEO') {
    const video = parseJson(payload) || {};
    const inPlaylist = Boolean(video.n_entries);
    job._.video = video;
    job.title = (inPlaylist && video.playlist_title) || video.title || job.title;
    job.itemTitle = inPlaylist ? video.title : null;
    job.item = inPlaylist ? { index: video.playlist_index, count: video.n_entries } : null;
    job.thumbnail = video.thumbnail || job.thumbnail;
    job.duration = inPlaylist ? null : video.duration ?? null;
  } else if (tag === 'SAVED') {
    const file = parseJson(payload);
    if (typeof file === 'string' && !job.files.includes(file)) job.files.push(file);
  }
}

function stepLabel(postprocessor, opts) {
  switch (postprocessor) {
    case 'ExtractAudio': return `Convirtiendo a ${opts.format.toUpperCase()}`;
    case 'Merger': return 'Uniendo video y audio';
    case 'VideoRemuxer':
    case 'VideoConvertor': return 'Pasando a MP4';
    case 'ThumbnailsConvertor': return 'Preparando la portada';
    case 'EmbedThumbnail': return 'Agregando la portada';
    case 'Metadata': return 'Agregando los datos';
    case 'SplitChapters': return 'Separando en pistas';
    case 'MoveFiles': return 'Guardando';
    default: return postprocessor?.startsWith('Fixup') ? 'Acomodando el archivo' : null;
  }
}

/** Anota los archivos que va creando yt-dlp: para limpiar si algo falla y para etiquetar pistas. */
function trackFiles(job, line) {
  const { temp } = job._;
  let m;
  if ((m = /^\[download\] Destination: (.+)$/.exec(line))) temp.add(m[1]);
  else if ((m = /^\[info\] Writing video thumbnail .+ to: (.+)$/.exec(line))) temp.add(m[1]);
  else if ((m = /^\[ThumbnailsConvertor\] Converting thumbnail "(.+)" to (\w+)$/.exec(line))) temp.add(m[1].replace(/\.[^.\\]+$/, `.${m[2]}`));
  else if ((m = /^\[(?:ExtractAudio|VideoRemuxer|VideoConvertor)\] .*Destination: (.+)$/.exec(line))) temp.add(m[1]);
  else if ((m = /^\[Merger\] Merging formats into "(.+)"$/.exec(line))) temp.add(m[1]);
  else if ((m = /^\[SplitChapters\] Chapter (\d+); Destination: (.+)$/.exec(line))) addTrack(job, Number(m[1]), m[2]);
  else if ((m = /^\[download\] (.+) has already been downloaded$/.exec(line))) {
    job.already = true;
    if (!job.files.includes(m[1])) job.files.push(m[1]);
  } else if (line.startsWith('ERROR: ')) job.error ??= line.slice('ERROR: '.length);
}

function addTrack(job, number, file) {
  const { chapters = [], album, title } = job._.video;
  const chapter = chapters[number - 1];
  if (!chapter) return;
  job._.tracks.push({
    file,
    number,
    total: chapters.length,
    title: /^<Untitled Chapter \d+>$/.test(chapter.title) ? `Pista ${number}` : chapter.title,
    album: album || title || '',
  });
}

async function finishJob(job, code, error) {
  if (job._.finished) return;
  job._.finished = true;
  job._.proc = null;
  if (error) job.error ??= error;

  if (job.status === 'canceling' || job.status === 'canceled') {
    await removeLeftovers(job);
    job.status = 'canceled';
  } else if (code === 0) {
    if (job._.tracks.length) {
      Object.assign(job, { stage: 'Etiquetando las pistas', percent: null, speed: null, eta: null });
      flush(job);
      await tagTracks(job);
      job.tracks = job._.tracks.length;
    }
    job.status = 'done';
  } else {
    job.status = 'error';
    job.error ??= `${job.kind === 'download' ? 'yt-dlp' : 'ffmpeg'} terminó con código ${code}.`;
    job.hint = job.kind === 'download' ? hintFor(job.error) : null;
    await removeLeftovers(job);
  }

  job.size = job.files.reduce((sum, file) => sum + fileSize(file), 0);
  Object.assign(job, { stage: null, percent: null, speed: null, eta: null });
  log(`Tarea ${job.id}: ${job.status}${job.error ? ` (${job.error})` : ''}`);
  flush(job);
  if (active === job) active = null;
  processQueue();
}

function hintFor(error) {
  if (/Sign in to confirm|not a bot/i.test(error)) return 'YouTube pide confirmar que no sos un bot. Esperá un rato o probá desde otra red.';
  if (/HTTP Error 403|Requested format is not available|n challenge|nsig|signature|PO Token/i.test(error)) {
    return 'Casi siempre se arregla actualizando yt-dlp (abajo de todo) y reintentando.';
  }
  if (/unavailable|Private video|members-only|removed/i.test(error)) return 'El video no está disponible: es privado, se borró o tiene restricciones.';
  if (/Unable to download webpage|getaddrinfo|timed out|Connection|Network/i.test(error)) return 'Parece un problema de conexión. Revisá internet y reintentá.';
  if (/Unsupported URL/i.test(error)) return 'Ese link no es de un video. Copiá la dirección completa desde el navegador.';
  return null;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Borra los archivos a medio hacer de una descarga que falló o se canceló. */
async function removeLeftovers(job) {
  await sleep(500); // que ffmpeg termine de soltar los archivos
  const saved = new Set(job.files.map(f => f.toLowerCase()));
  for (const file of job._.temp) {
    for (const f of [file, `${file}.part`, `${file}.ytdl`]) {
      if (!saved.has(f.toLowerCase())) removeFile(f);
    }
  }
}

/** yt-dlp deja en cada pista el título del video completo: le ponemos el de su capítulo. */
async function tagTracks(job) {
  for (const track of job._.tracks) {
    const ext = path.extname(track.file);
    const tmp = `${track.file.slice(0, -ext.length)}.tags${ext}`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', track.file, '-map', '0', '-dn', '-c', 'copy',
      '-metadata', `title=${track.title}`,
      '-metadata', `track=${track.number}/${track.total}`,
      '-metadata', `album=${track.album}`,
    ];
    if (ext.toLowerCase() === '.mp3') args.push('-id3v2_version', '3');
    const { code, out } = await run(FFMPEG, [...args, tmp]);
    try {
      if (code !== 0) throw new Error(out.trim());
      fs.renameSync(tmp, track.file);
    } catch (e) {
      removeFile(tmp);
      addLog(job, `No se pudo etiquetar ${path.basename(track.file)}: ${e.message}`);
    }
  }
}

function cancelJob(job) {
  if (job.status === 'queued') {
    job.status = 'canceled';
  } else if (job.status === 'running' && (job._.proc || job._.abort)) {
    // No habilitar reintentar/eliminar hasta que el proceso anterior haya cerrado y limpiado.
    job.status = 'canceling';
    if (job._.proc) killTree(job._.proc.pid);
    job._.abort?.abort();
  }
  flush(job);
}

function jobAction(job, action) {
  switch (action) {
    case 'cancel':
      return cancelJob(job);
    case 'retry':
      if (job.status !== 'error' && job.status !== 'canceled') return;
      resetJob(job);
      flush(job);
      return processQueue();
    case 'remove':
      if (active === job) throw new HttpError(409, 'Esperá a que la tarea termine de cancelarse.');
      jobs.delete(job.id);
      return broadcast('remove', { id: job.id });
    case 'open':
    case 'reveal': {
      const file = [...job.files].reverse().find(f => fs.existsSync(f));
      if (!file) throw new HttpError(404, 'No encuentro el archivo. ¿Lo moviste o lo borraste?');
      return openInExplorer(file, { select: action === 'reveal' });
    }
    default:
      throw new HttpError(400, 'Acción desconocida.');
  }
}

// ---------------------------------------------------------------------------
// yt-dlp: versión y actualización

const ytdlp = { version: null, updating: false, message: '' };

function setYtdlp(patch) {
  Object.assign(ytdlp, patch);
  broadcast('ytdlp', ytdlp);
}

async function refreshVersion() {
  const { code, out } = await run(YTDLP, ['--ignore-config', '--version']);
  setYtdlp({ version: code === 0 ? out.trim() : null });
}

async function updateYtdlp() {
  if (ytdlp.updating || active) return;
  setYtdlp({ updating: true, message: 'Buscando actualizaciones…' });
  const { out } = await run(YTDLP, ['--ignore-config', '-U'], { timeoutMs: 3 * 60_000 });
  const updated = /Updated yt-dlp to (?:\S+@)?(\S+)/.exec(out);
  const lastLine = out.trim().split(/\r?\n/).pop();
  const message = updated ? `Actualizado a ${updated[1]}.`
    : /is up to date/.test(out) ? 'Ya tenés la última versión.'
    : `No se pudo actualizar: ${lastLine}`;
  log(`Actualización de yt-dlp: ${message}`);
  lastUpdateCheck = Date.now();
  saveSettings();
  await refreshVersion();
  setYtdlp({ updating: false, message });
  processQueue();
}

// ---------------------------------------------------------------------------
// Procesos auxiliares

// Los procesos que arranca el servidor (yt-dlp, ffmpeg, PowerShell): al salir se matan los que queden.
const children = new Set();

function spawnChild(file, args, options) {
  const proc = spawn(file, args, { windowsHide: true, ...options });
  children.add(proc);
  proc.on('exit', () => children.delete(proc)).on('error', () => children.delete(proc));
  return proc;
}

function run(file, args, { env, timeoutMs = 60_000 } = {}) {
  return new Promise(resolve => {
    let out = '';
    const proc = spawnChild(file, args, { env: { ...process.env, ...env } });
    const timer = setTimeout(() => killTree(proc.pid), timeoutMs);
    proc.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    proc.stderr.setEncoding('utf8').on('data', chunk => { out += chunk; });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, out: out + e.message });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Mata un proceso y sus hijos (yt-dlp arranca ffmpeg). */
function killTree(pid, { sync = false } = {}) {
  const args = ['/PID', String(pid), '/T', '/F'];
  if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
  else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
}

function openInExplorer(target, { select = false } = {}) {
  // explorer.exe tiene su propia forma de leer argumentos: se los pasamos tal cual.
  const arg = select ? `/select,"${target}"` : `"${target}"`;
  spawn('explorer.exe', [arg], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
}

// Diálogos de Windows (WinForms desde PowerShell): el navegador no da las rutas de los archivos.
const DIALOG_SETUP = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
`;
const PICK_FOLDER_SCRIPT = `
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{
  Description = 'Elegí dónde guardar las descargas'
  ShowNewFolderButton = $true
  SelectedPath = $env:BAJALO_DIR
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }
`;
const PICK_FILES_SCRIPT = `
$dialog = New-Object System.Windows.Forms.OpenFileDialog -Property @{
  Title = $env:BAJALO_TITLE
  Filter = 'Videos y audios|*.wmv;*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.flv;*.mpg;*.mpeg;*.3gp;*.mp3;*.m4a;*.wav;*.wma;*.ogg;*.opus;*.flac|Todos los archivos|*.*'
  Multiselect = $true
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileNames }
`;

let dialogOpen = false;

/** Muestra un diálogo de Windows y devuelve las rutas elegidas (vacío si se canceló). */
async function showDialog(script, env) {
  if (dialogOpen) throw new HttpError(409, 'Ya hay una ventana de Windows abierta: cerrala primero.');
  dialogOpen = true;
  try {
    const encoded = Buffer.from(DIALOG_SETUP + script, 'utf16le').toString('base64');
    const { out } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      env,
      timeoutMs: 60 * 60_000,
    });
    return out.split(/\r?\n/).map(line => line.trim()).filter(isFullPath);
  } finally {
    dialogOpen = false;
  }
}

// ---------------------------------------------------------------------------
// Eventos para la interfaz (Server-Sent Events)

const clients = new Set();
let shutdownTimer = null;
// Al cerrarse la última ventana se espera un poco, por si solo se estaba recargando la página.
const RELOAD_GRACE_MS = 3_000;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function writeHead(res, status, headers) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

/** Agrupa los cambios de una descarga para no mandar un evento por cada línea de yt-dlp. */
function touch(job) {
  job._.timer ??= setTimeout(() => flush(job), 150);
}

function flush(job) {
  clearTimeout(job._.timer);
  job._.timer = null;
  if (!jobs.has(job.id)) return;
  if (job._.pendingLog.length) {
    broadcast('log', { id: job.id, lines: job._.pendingLog });
    job._.pendingLog = [];
  }
  broadcast('job', publicJob(job));
}

function addLog(job, line) {
  const { log: lines } = job._;
  lines.push(line);
  if (lines.length > 500) lines.splice(0, lines.length - 500);
  job._.pendingLog.push(line);
  touch(job);
}

function openEvents(req, res) {
  writeHead(res, 200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  res.write('retry: 1500\n\n');
  send(res, 'init', { settings: publicSettings(), ytdlp, jobs: [...jobs.values()].map(j => ({ ...publicJob(j), log: j._.log })) });
  clients.add(res);
  clearTimeout(shutdownTimer);
  req.on('close', () => {
    clients.delete(res);
    if (!clients.size) scheduleShutdown(RELOAD_GRACE_MS);
  });
}

/** Si dentro de `ms` no hay ninguna ventana abierta, cierra Bajalo. */
function scheduleShutdown(ms) {
  clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => { if (!clients.size) shutdown(); }, ms);
}

/** Cancela lo pendiente y sale. Al salir se matan los procesos que hayan quedado (ver serve). */
async function shutdown() {
  log('No quedan ventanas abiertas: cierro Bajalo.');
  // Soltar el puerto ya: si se vuelve a abrir Bajalo.exe, que arranque un servidor nuevo y no use este.
  httpServer.close();
  for (const job of jobs.values()) cancelJob(job);
  // Que la descarga cancelada borre sus archivos a medio hacer y que yt-dlp.exe no quede a medio
  // actualizar; con un tope, por si algo se colgó.
  const deadline = Date.now() + 30_000;
  while ((active || ytdlp.updating) && Date.now() < deadline) await sleep(100);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// HTTP

function reply(res, status, data) {
  writeHead(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveIndex(res) {
  fs.readFile(INDEX_FILE, (err, html) => {
    if (err) return reply(res, 500, { error: err.message });
    writeHead(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) req.destroy(new HttpError(413, 'Pedido demasiado grande.'));
    });
    req.on('end', () => {
      const data = body ? parseJson(body) : {};
      if (data && typeof data === 'object') resolve(data);
      else reject(new HttpError(400, 'JSON inválido.'));
    });
    req.on('error', reject);
  });
}

function parseUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) && url.hostname.includes('.') ? url : null;
  } catch {
    return null;
  }
}

async function handleApi(pathname, body) {
  switch (pathname) {
    case '/api/jobs': {
      const url = parseUrl(body.url);
      if (!url) throw new HttpError(400, 'Eso no parece un link. Copiá la dirección completa del video.');
      return { id: createJob({ url: url.href, opts: mergeOptions(settings, body.options) }).id };
    }
    case '/api/jobs/action': {
      const job = jobs.get(String(body.id));
      if (!job) throw new HttpError(404, 'Esa descarga ya no está en la lista.');
      jobAction(job, body.action);
      return {};
    }
    case '/api/jobs/clear':
      for (const job of jobs.values()) {
        if (['done', 'error', 'canceled'].includes(job.status)) {
          jobs.delete(job.id);
          broadcast('remove', { id: job.id });
        }
      }
      return {};
    case '/api/settings': {
      if (body.outputDir !== undefined && !isFullPath(path.normalize(String(body.outputDir).trim()))) {
        throw new HttpError(400, 'La carpeta tiene que ser una ruta completa, por ejemplo C:\\Users\\vos\\Music.');
      }
      settings = mergeOptions(settings, body);
      saveSettings();
      broadcast('settings', publicSettings());
      return {};
    }
    case '/api/pick-folder': {
      const [dir] = await showDialog(PICK_FOLDER_SCRIPT, { BAJALO_DIR: settings.outputDir });
      if (dir) {
        settings = mergeOptions(settings, { outputDir: dir });
        saveSettings();
        broadcast('settings', publicSettings());
      }
      return {};
    }
    case '/api/groq-key': {
      const key = String(body.key ?? '').trim();
      if (!key) throw new HttpError(400, 'Pegá la clave primero.');
      await verifyGroqKey(key);
      groqKey = key;
      saveSettings();
      broadcast('settings', publicSettings());
      return {};
    }
    case '/api/convert':
    case '/api/transcribe': {
      const kind = pathname === '/api/convert' ? 'convert' : 'transcribe';
      if (kind === 'transcribe' && !groqKey) throw new HttpError(400, 'Primero pegá tu clave de Groq en Opciones → Transcribir.');
      // Sin `files`, se eligen con el diálogo de Windows.
      const files = Array.isArray(body.files) ? body.files.map(String) : await showDialog(PICK_FILES_SCRIPT, {
        BAJALO_TITLE: kind === 'convert' ? 'Elegí los videos a los que querés sacarles el audio' : 'Elegí los videos o audios a transcribir',
      });
      const missing = files.find(file => !isFullPath(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile());
      if (missing) throw new HttpError(400, `No encuentro el archivo ${missing}.`);
      for (const file of files) createJob({ kind, source: file, title: path.basename(file) });
      return { count: files.length };
    }
    case '/api/open-folder': {
      fs.mkdirSync(settings.outputDir, { recursive: true });
      if (!fs.statSync(settings.outputDir).isDirectory()) throw new HttpError(400, 'La ruta elegida no es una carpeta.');
      openInExplorer(settings.outputDir);
      return {};
    }
    case '/api/update':
      if (active) throw new HttpError(409, 'Esperá a que termine la descarga en curso.');
      updateYtdlp();
      return {};
    case '/api/quit':
      if (busy()) throw new HttpError(409, 'Hay descargas en curso.');
      setTimeout(() => process.exit(0), 100);
      return {};
    default:
      throw new HttpError(404, 'No encontrado.');
  }
}

async function handleRequest(req, res) {
  try {
    // Solo pedidos dirigidos a este servidor local (evita "DNS rebinding").
    if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
      throw new HttpError(403, 'Host no permitido.');
    }
    const { pathname } = new URL(req.url, ORIGIN);
    if (req.method === 'GET') {
      if (pathname === '/') return serveIndex(res);
      if (pathname === '/api/ping') return reply(res, 200, { app: 'bajalo', build: BUILD });
      if (pathname === '/api/events') return openEvents(req, res);
      throw new HttpError(404, 'No encontrado.');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido.');
    // Otra página abierta en el navegador no puede mandar JSON acá ni hacerse pasar por este origen.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Origen no permitido.');
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, 'Se esperaba JSON.');
    reply(res, 200, await handleApi(pathname, await readJson(req)));
  } catch (e) {
    if (!e.status) log(e.stack || e);
    if (!res.headersSent) reply(res, e.status || 500, { error: e.message });
  }
}

let httpServer = null;

function serve() {
  httpServer = http.createServer(handleRequest);
  httpServer.on('error', e => {
    log(e.code === 'EADDRINUSE' ? `El puerto ${PORT} está ocupado por otro programa.` : e.stack);
    process.exit(1);
  });
  httpServer.listen(PORT, HOST, () => log(`Escuchando en ${ORIGIN}`));

  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000);
  scheduleShutdown(60_000); // por si la ventana nunca llega a abrirse

  refreshVersion().then(() => {
    if (settings.autoUpdate && Date.now() - lastUpdateCheck > DAY_MS) updateYtdlp();
  });

  process.on('uncaughtException', e => log(e.stack));
  process.on('unhandledRejection', e => log(e?.stack || e));
  process.on('SIGINT', () => process.exit(0));
  process.on('exit', () => { for (const proc of children) if (proc.pid) killTree(proc.pid, { sync: true }); });
}

// ---------------------------------------------------------------------------
// Lanzador

function request(method, pathname, body) {
  return new Promise(resolve => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const req = http.request({ host: HOST, port: PORT, path: pathname, method, headers, timeout: 1500 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve(res.statusCode === 200 ? parseJson(text) : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

async function ping() {
  const info = await request('GET', '/api/ping');
  return info?.app === 'bajalo' ? info : null;
}

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

async function startServer() {
  const out = fs.openSync(LOG_FILE, 'w');
  const child = spawn(process.execPath, [__filename, '--serve'], { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  let exited = false;
  child.once('exit', () => { exited = true; });
  const deadline = Date.now() + 15_000;
  while (!(await ping())) {
    if (exited || Date.now() > deadline) {
      fail(`No se pudo iniciar el servidor. Detalle (${LOG_FILE}):\n\n${fs.readFileSync(LOG_FILE, 'utf8').trim()}`);
    }
    await sleep(200);
  }
}

const BROWSERS = [
  ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
];

function openWindow(url) {
  // En modo "app" estos navegadores abren una ventana propia, sin pestañas ni barra de direcciones.
  const dirs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browser = BROWSERS.flatMap(parts => dirs.map(dir => path.join(dir, ...parts))).find(file => fs.existsSync(file));
  if (browser) spawn(browser, [`--app=${url}`, '--window-size=720,860'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function launch() {
  const missing = [YTDLP, FFMPEG, FFPROBE].filter(file => !fs.existsSync(file)).map(path.basename);
  if (missing.length) fail(`Faltan ${missing.join(', ')} en ${BIN_DIR}.\n\nVolvé a descomprimir el ZIP de Bajalo completo.`);
  let running = await ping();
  if (running && running.build !== BUILD && (await request('POST', '/api/quit', {}))) {
    // Quedó corriendo una versión anterior del servidor y está libre: la reemplazamos.
    for (let i = 0; i < 25 && running; i++) {
      await sleep(200);
      running = await ping();
    }
  }
  if (!running) await startServer();
  if (process.argv.includes('--no-window')) console.log(`Servidor listo en ${ORIGIN}/`);
  else openWindow(`${ORIGIN}/`);
}

module.exports = { clock, hintFor, isPlaylistDownload, mergeOptions, parseUrl };

if (require.main === module) {
  if (process.argv.includes('--serve')) serve();
  else launch();
}
