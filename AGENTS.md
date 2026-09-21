# AGENTS.md

Guía para agentes y personas que modifiquen Bajalo. Lo que hace la app desde el lado del usuario está en el [README](README.md).

## Qué es

Una app para Windows 10 y 11 que baja música y videos de YouTube con yt-dlp y FFmpeg, saca el audio de videos de la compu y los transcribe con Whisper (vía Groq). Se distribuye como un ZIP portátil en los Releases: `Bajalo.exe` más `app/` y `bin/`, con Node, yt-dlp y FFmpeg adentro. Quien la usa no instala ni baja nada: descomprime y hace doble clic en `Bajalo.exe`, sin consola.

Priorizá cambios chicos y sin dependencias nuevas. No la pases a Electron, a un framework ni a un build de la interfaz sin un motivo concreto.

## Mapa

| Archivo | Qué es |
| --- | --- |
| `launcher/Bajalo.cs` | `Bajalo.exe`: lanzador de ventana (sin consola) en C# 5 para .NET Framework 4, que ya viene con Windows. Corre `bin\node.exe app\server.js` oculto y, si sale con error, muestra su stderr en un cartel. `launcher/bajalo.ico` es el logo de `index.html`. |
| `app/server.js` | Todo el backend: lanzador de Node, servidor HTTP, cola de tareas, yt-dlp, FFmpeg, Groq y diálogos de Windows. |
| `app/index.html` | Toda la interfaz: HTML, CSS y JavaScript sin frameworks. |
| `bin/download.bat` | Versión de consola mínima (link → MP3). |
| `tools/build.js` | Baja a `bin/` lo que falte y compila `Bajalo.exe`; con `--zip` arma `dist/Bajalo-win64.zip`. |
| `tools/dependencies.json` | Versión, URL fija, SHA-256 y qué archivo va adónde, para Node, yt-dlp y FFmpeg. |
| `.github/workflows/release.yml` | Con un tag `v*` arma el ZIP en `windows-latest` y publica el Release. |
| `tests/` | Pruebas con `node:test`, sin paquetes. |
| `THIRD_PARTY_NOTICES.md` | Licencias y código fuente de lo que va en el ZIP (va adentro del ZIP). |

No se versionan, y no pueden terminar en el ZIP: `bin/*` salvo `download.bat`, `Bajalo.exe`, `dist/`, `app/settings.json` (tiene la clave de Groq) y `app/server.log`.

## Cómo se corre

- `node tools/build.js`: prepara el repo como la carpeta portátil (Node 22+, en Windows o WSL). Después, `Bajalo.exe`.
- `node app/server.js`: el lanzador que usa `Bajalo.exe`. Con `--no-window` no abre la ventana; con `--serve` corre el servidor en primer plano, para depurar, en http://127.0.0.1:17865.
- Variables: `BAJALO_PORT` cambia el puerto (para probar sin chocar con una instancia abierta) y `BAJALO_GROQ_API` la URL de Groq (para probar la transcripción contra un servidor falso).

## Arquitectura

- **Arranque.** `Bajalo.exe` corre el lanzador de Node, que hace ping a `/api/ping`. Si responde un servidor con otro `build` (el mtime de `server.js`) y está libre, le pide `/api/quit` y arranca uno nuevo: editar `server.js` alcanza para que la próxima apertura use el código nuevo. El servidor corre desacoplado con `--serve`, con su salida en `server.log`, y la ventana es Edge, Chrome o Brave en modo `--app`.
- **Cierre.** Cuando se corta la última conexión a `/api/events` (la ventana), el servidor espera 3 s por si era una recarga (`RELOAD_GRACE_MS`). Después cancela las tareas, suelta el puerto, espera a que se borren los archivos a medio hacer y a que termine una actualización de yt-dlp en curso (con tope de 30 s) y sale. Al salir mata todos los procesos que arrancó (`spawnChild`). La página pregunta antes de cerrarse si hay tareas en curso (`beforeunload`). Si en 60 s no se abre ninguna ventana, también se cierra.
- **Eventos.** `GET /api/events` (Server-Sent Events) manda `init` (estado completo), `job`, `log`, `remove`, `settings` y `ytdlp`. La página no pide estado: reacciona a los eventos.
- **API.** Todo lo que cambia algo es `POST` con JSON a `/api/*`, resuelto en `handleApi`.
- **Cola.** Una tarea por vez, en orden. Tipos (`job.kind`): `download` (yt-dlp), `convert` (ffmpeg, MP3 de voz) y `transcribe` (ffmpeg en partes de 30 min más Groq). Lo que está en `job._` es interno y nunca va a la página (`publicJob`).

  ```text
  queued -> running -> done | error
  queued -> canceled
  running -> canceling -> canceled
  error | canceled -> queued (reintentar)
  ```

  Una tarea `canceling` no se puede reintentar ni sacar de la lista: su proceso todavía puede tener archivos abiertos.
- **Progreso de yt-dlp.** Se le piden líneas propias con `--progress-template` y `--print` (`@@PROGRESS`, `@@STEP`, `@@VIDEO`, `@@SAVED`; ver `MACHINE_OUTPUT` y `handleTag`). El resto va al log, y `trackFiles` anota los archivos para borrar los restos si la tarea falla o se cancela. El de ffmpeg sale de `-progress pipe:1`.
- **Diálogos de archivos y carpetas.** PowerShell con WinForms (`showDialog`), porque el navegador no da las rutas.

## Reglas

- **Nada que baje y ejecute programas en la PC del usuario.** Una primera versión portátil bajaba Node, yt-dlp y FFmpeg al primer inicio con un script de PowerShell, y Kaspersky lo borró por troyano: es el patrón de un descargador de malware. Todos los ejecutables van dentro del ZIP, que arma la Action. La única excepción es la autoactualización de yt-dlp (`yt-dlp -U`), que es su propio mecanismo. Tampoco ejecutes nada desde `%TEMP%`.
- **Sin dependencias ni build de la app.** Solo módulos `node:` y APIs del navegador; nada de `package.json`, npm ni bundlers. `tools/build.js` tampoco usa paquetes: lee y escribe los .zip con `zlib`.
- **Español rioplatense** (voseo: "Pegá", "tenés") en la interfaz, los errores, los comentarios y la documentación; los nombres del código, en inglés. Los mensajes son para gente no técnica: qué pasó y qué hacer.
- En los `.bat`, nada de tildes ni eñes (cmd.exe los lee con otra página de códigos). Van con CRLF (`.gitattributes`; `tools/build.js` además los convierte al armar el ZIP).
- **Seguridad del servidor local**, no la aflojes: escucha solo en `127.0.0.1`, rechaza otros `Host` (DNS rebinding) y otros `Origin`, solo acepta `POST` con `Content-Type: application/json` y manda cabeceras contra framing y `nosniff`. La clave de Groq nunca sale del servidor (`publicSettings` manda solo `groqKeySet`) ni va a logs o errores. Las opciones que llegan de la página pasan por `mergeOptions`. Los procesos se arrancan con `spawn` y argumentos separados, nunca con `shell: true`.
- **yt-dlp: argumentos que parecen de más y no lo son.**
  - `--js-runtimes node:<process.execPath>`: sin un motor de JavaScript, YouTube responde 403, y yt-dlp solo busca Deno por defecto. Pide Node 22 o más nuevo.
  - `--encoding utf-8`: si no, yt-dlp.exe escribe en cp1252 y se rompen las rutas con tildes que se leen del log.
  - `--ffmpeg-location` apunta al `.exe`, no a la carpeta.
  - `--ignore-config`: que un `yt-dlp.conf` del usuario no cambie la salida que se interpreta.
  - La URL va última, después de `--`.
- **Procesos.** Todo lo que arranca el servidor pasa por `spawnChild`, así se mata al salir; siempre con `windowsHide: true`. Para cancelar se usa `killTree` (`taskkill /T`), porque yt-dlp arranca ffmpeg. `explorer.exe` recibe los argumentos tal cual (`windowsVerbatimArguments`).
- **Archivos del usuario.** Nunca se pisa nada: `freeName()` busca un nombre libre. Las descargas van por defecto a `Música\Bajalo`, fuera de la carpeta de Bajalo (se reemplaza entera al actualizar), y esa carpeta por defecto no se guarda en `settings.json`, así sigue siendo la de cada usuario si Bajalo se copia a otra PC.
- **Opciones nuevas:** en `DEFAULTS` y en `CHOICES` o `FLAGS` de `server.js`, y en `FLAGS` o `QUALITIES` y el HTML de `index.html`.
- **Estados nuevos de tarea:** en el backend, en `ACTIONS` y `statusText()` de la página, y en las condiciones de limpieza y de cierre.
- Si cambia lo que hace la app, actualizá el README (y `docs/captura.png` si cambia la ventana).

## Dependencias y Releases

Para actualizar Node, yt-dlp o FFmpeg, cambiá en `tools/dependencies.json` la versión, la URL (fija, nunca `latest`), el SHA-256 publicado por el proyecto (el `SHASUMS256.txt` de nodejs.org, el `SHA2-256SUMS` del release de yt-dlp, el digest del asset de GyanD en GitHub) y las rutas de `files`, que incluyen la versión. Actualizá también la tabla de `THIRD_PARTY_NOTICES.md` y probá con `node tools/build.js --zip`. El yt-dlp del ZIP no necesita estar al día: la app lo actualiza sola.

Para publicar: `git tag vX.Y.Z && git push origin vX.Y.Z`. La Action corre las pruebas, arma el ZIP, certifica su procedencia (solo si el repo es público) y crea el Release con el ZIP y su SHA-256. **Actions → Release → Run workflow** lo arma sin publicar, como artefacto.

**Firma.** `Bajalo.exe` no está firmado, así que Windows avisa la primera vez ("Windows protegió tu PC"). Si se agrega una firma, va en el workflow entre la compilación y el ZIP, porque `tools/build.js` mete `Bajalo.exe` en el ZIP. Aun firmado, SmartScreen avisa hasta que el editor junta reputación.

## Cómo probar

1. `node --check app/server.js` y `node --check tools/build.js`.
2. `node --test`.
3. `git diff --check`.
4. Lo que depende de Windows (los `.exe`, `taskkill`, `explorer`, PowerShell, el lanzador) se prueba en Windows. Desde WSL, cmd.exe no acepta `\\wsl.localhost\...` como carpeta actual: extraé `dist/Bajalo-win64.zip` en una carpeta de Windows fuera de `%TEMP%` y corré desde ahí con `cmd.exe /c`. Para no abrir ventanas, usá `--serve` con `BAJALO_PORT` y una conexión a `/api/events` que haga de ventana.
5. Videos de prueba: `https://www.youtube.com/watch?v=BaW_jenozKc` (10 s, el de prueba de yt-dlp) y, para cancelar a mitad de una descarga, `https://www.youtube.com/watch?v=aqz-KE-bpKQ` (Big Buck Bunny, largo y de licencia libre). Mandá las descargas de prueba a una carpeta propia con `options.outputDir`, no a la Música del usuario.
6. Antes de publicar, con el ZIP en Windows: bajar un MP3 y un MP4; cancelar y reintentar; los diálogos de **Cambiar…** y **Sacarle el audio a un video…**; y cerrar la ventana con una descarga en curso, que tiene que preguntar y después no dejar `node.exe`, `yt-dlp.exe` ni `ffmpeg.exe` en el Administrador de tareas.
