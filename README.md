# Bajalo

Pegá el link de YouTube y bajalo. Una ventana simple para descargar música y videos, hecha sobre [yt-dlp](https://github.com/yt-dlp/yt-dlp) y [FFmpeg](https://ffmpeg.org). Para Windows.

![Bajalo](docs/captura.png)

## Qué hace

- **MP3** (máxima calidad VBR o 320/192/128 kbps), **M4A** sin recodificar o **MP4** (hasta 1080p, 720p, 480p o la máxima).
- Guarda la portada, el título y el artista dentro del archivo.
- Limpia los títulos: saca "(Official Video)", "[Lyrics]", "(Video Oficial)", etc.
- Playlists enteras, en una carpeta y numeradas.
- Álbumes subidos como un solo video: si tiene capítulos, además arma una pista por canción, con su título y número.
- Saca el audio de videos de la compu (.wmv, .mp4, .mkv…) a un MP3 liviano para voz (mono, 16 kHz, 32 kbps). Queda al lado del video.
- Transcribe videos y audios de la compu con Whisper large-v3 (vía Groq, gratis): deja un `.txt` al lado del archivo, con la hora de cada frase.
- Cola de descargas con progreso; se pueden cancelar y reintentar.
- Mantiene yt-dlp actualizado solo (una vez por día), porque YouTube cambia seguido y las versiones viejas dejan de andar.

## Instalación

1. Instalá [Node.js](https://nodejs.org) 22 o más nuevo.
2. Cloná el repo (o bajalo como ZIP).
3. Poné en la carpeta `bin/`:
   - [`yt-dlp.exe`](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe)
   - `ffmpeg.exe` y `ffprobe.exe`, que están en la carpeta `bin/` de [este ZIP](https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip).

## Uso

Doble clic en **`Bajalo.bat`**. Se abre la ventana (con Edge, Chrome o Brave; si no hay ninguno, en el navegador por defecto). Pegá el link y dale a **Descargar**. Los archivos van a `bin/music` o a la carpeta que elijas.

Cuando cerrás la ventana, Bajalo se cierra solo. Si quedaban descargas, antes las termina.

`bin/download.bat` es la versión de consola: pide el link y baja el MP3 a `bin/music`, sin opciones.

## Transcribir

Bajalo transcribe con Whisper large-v3 a través de [Groq](https://console.groq.com), que es gratis con límites (unas 2 horas de audio por hora).

1. Creá una cuenta y una clave en [console.groq.com/keys](https://console.groq.com/keys).
2. Pegala en **Opciones → Transcribir** y tocá **Guardar**.
3. Tocá **Transcribir a texto…** y elegí videos o audios. El `.txt` queda al lado de cada archivo.

La clave se guarda solo en `app/settings.json`, que no se sube al repo. Tené en cuenta que el audio se sube a los servidores de Groq.

## Cómo está hecho

Sin dependencias ni build: alcanza con Node.

- `app/server.js`: servidor local que solo escucha en `127.0.0.1`. Corre yt-dlp, lee su progreso y se lo pasa a la ventana con Server-Sent Events.
- `app/index.html`: la interfaz, en HTML, CSS y JavaScript sin frameworks.
- `app/settings.json` y `app/server.log`: las opciones y el log de cada máquina (no se suben al repo).

Para depurar, `node app/server.js --serve` corre el servidor en primer plano en http://127.0.0.1:17865.

## Si algo falla

- **HTTP Error 403**: casi siempre es yt-dlp desactualizado. Tocá **Actualizar**, abajo de la ventana, y reintentá. Bajalo ya le pasa `--js-runtimes node` a yt-dlp: sin un motor de JavaScript, YouTube también responde 403, y yt-dlp solo busca Deno si no se le indica otro.
- **"Sign in to confirm you're not a bot"**: YouTube está frenando tu conexión. Esperá un rato o probá desde otra red.
- Cada descarga tiene un botón **Detalles** con la salida completa de yt-dlp.

## Aviso

Bajá solo contenido que tengas derecho a descargar, respetando los derechos de autor y los términos de YouTube.

## Licencia

[MIT](LICENSE). yt-dlp y FFmpeg no se incluyen en el repo y tienen sus propias licencias (Unlicense y GPL/LGPL).
