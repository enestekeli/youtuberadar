@echo off
chcp 65001 >nul
rem  Radar sunucusu (127.0.0.1:5178) + panel (http://localhost:5179).
rem  pnpm kurulu degilse npx ile ayni surumu kullanir.
cd /d "%~dp0"
if not exist "%~dp0node_modules" (
  call npx -y pnpm@11.20.0 install --ignore-scripts
)
start "" http://localhost:5179
call npx -y pnpm@11.20.0 dev:all
