@echo off
setlocal
cd /d "%~dp0"

echo.
set /p "URL=Pega la URL de YouTube y presiona Enter: "

if not defined URL (
    echo No ingresaste ninguna URL.
    pause
    exit /b 1
)

if not exist "music" mkdir "music"

echo.
echo Descargando y convirtiendo a MP3...
echo.

rem Sin un motor de JavaScript YouTube devuelve 403; yt-dlp solo busca Deno si no se le indica.
yt-dlp.exe ^
    --js-runtimes node ^
    --no-playlist ^
    -x ^
    --audio-format mp3 ^
    --audio-quality 0 ^
    --embed-metadata ^
    --embed-thumbnail ^
    --convert-thumbnails jpg ^
    --windows-filenames ^
    --replace-in-metadata "title" "(?i)\s*[\(\[](official\s*(music\s*)?video|official\s*audio|lyrics?|lyric\s*video|audio|visualizer|video\s*oficial|letra|sub\s*espanol|subtitulado|hd|4k)[^\)\]]*[\)\]]\s*" "" ^
    -o "music\%%(title)s.%%(ext)s" ^
    "%URL%"

echo.
if errorlevel 1 (
    echo Hubo un error durante la descarga.
    echo Verifica que yt-dlp.exe y ffmpeg.exe esten en esta carpeta.
) else (
    echo ==========================================
    echo Descarga completada correctamente.
    echo Los MP3 estan en la carpeta "music".
    echo ==========================================
)

echo.
pause