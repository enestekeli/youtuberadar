@echo off
chcp 65001 >nul
rem  Kanal listesini exports\kanallar-<tarih>.csv ve .html olarak disa aktarir
rem  (bizim sistem kurallari), sonra HTML sayfasini acar. Istek atmaz.
cd /d "%~dp0"
node "%~dp0node_modules\tsx\dist\cli.mjs" apps\server\tools\export-channels.mts
if errorlevel 1 goto :son
for /f "delims=" %%f in ('dir /b /o-d "%~dp0exports\kanallar-*.html" 2^>nul') do (
  start "" "%~dp0exports\%%f"
  goto :son
)
:son
echo.
echo Klasor: %~dp0exports
timeout /t 5 >nul
