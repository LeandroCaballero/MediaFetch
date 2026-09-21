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

echo.
echo Descargando y convirtiendo a MP3...
echo.

rem Sin un motor de JavaScript YouTube devuelve 403: se usa el Node que viene con Bajalo.
rem Se guarda en Musica\Bajalo, como desde la ventana, y no adentro de la carpeta de Bajalo.
"%~dp0yt-dlp.exe" ^
    --ignore-config ^
    --js-runtimes "node:%~dp0node.exe" ^
    --ffmpeg-location "%~dp0ffmpeg.exe" ^
    --no-playlist ^
    -x ^
    --audio-format mp3 ^
    --audio-quality 0 ^
    --embed-metadata ^
    --embed-thumbnail ^
    --convert-thumbnails jpg ^
    --windows-filenames ^
    --replace-in-metadata "title" "(?i)\s*[\(\[](official\s*(music\s*)?video|official\s*audio|lyrics?|lyric\s*video|audio|visualizer|video\s*oficial|letra|sub\s*espanol|subtitulado|hd|4k)[^\)\]]*[\)\]]\s*" "" ^
    -P "%USERPROFILE%\Music\Bajalo" ^
    -o "%%(title)s.%%(ext)s" ^
    "%URL%"

echo.
if errorlevel 1 (
    echo Hubo un error durante la descarga.
    echo Si faltan archivos, volve a descomprimir el ZIP de Bajalo completo.
) else (
    echo ==========================================
    echo Descarga completada correctamente.
    echo Los MP3 estan en Musica\Bajalo.
    echo ==========================================
)

echo.
pause
