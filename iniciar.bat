@echo off
chcp 65001 >nul
title StraightTalk
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado.
  echo Vou abrir a pagina de download. Instale a versao LTS e rode este arquivo de novo.
  start https://nodejs.org/pt
  pause
  exit /b
)

if not exist node_modules\ws (
  echo Instalando dependencias, so na primeira vez...
  call npm install --omit=dev
)

echo.
echo Abrindo http://localhost:3000 ...
echo Deixe esta janela aberta enquanto estiver usando o app.
start "" http://localhost:3000
call npm start
pause
