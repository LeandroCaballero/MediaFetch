# Componentes de terceros

El ZIP de Bajalo (`Bajalo-win64.zip`, en los Releases) trae adentro estos programas, sin modificar, para que funcione sin instalar ni bajar nada. No están en el repositorio: [`tools/build.js`](tools/build.js) los baja de sus sitios oficiales y verifica su SHA-256 contra [`tools/dependencies.json`](tools/dependencies.json), donde están las versiones exactas.

| Componente | Para qué | Licencia | Código fuente |
| --- | --- | --- | --- |
| [Node.js](https://nodejs.org) 24.21.0 | Corre la app; yt-dlp lo usa para los desafíos de YouTube | MIT, con las licencias de sus dependencias en `bin/licenses/node-LICENSE.txt` | [github.com/nodejs/node, tag v24.21.0](https://github.com/nodejs/node/tree/v24.21.0) |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) 2026.08.19 (se actualiza solo) | Baja los videos | Unlicense (dominio público); el ejecutable incluye Python y otras bibliotecas con sus propias licencias | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| [FFmpeg](https://ffmpeg.org) 9.0.2, build "essentials" de [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (`ffmpeg.exe` y `ffprobe.exe`) | Convierte, une y etiqueta los archivos | GPL v3, en `bin/licenses/ffmpeg-LICENSE.txt` | [Commit 946fcce07b de FFmpeg](https://github.com/FFmpeg/FFmpeg/commit/946fcce07b) ([ffmpeg-9.0.2.tar.xz](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz)); las bibliotecas que incluye el build y sus versiones están en `bin/licenses/ffmpeg-README.txt` |

Como el ZIP redistribuye FFmpeg, que es GPL v3, cada Release tiene que seguir indicando dónde está su código fuente: es este archivo, que va dentro del ZIP. Si cambia alguna versión en `tools/dependencies.json`, actualizá esta tabla.
