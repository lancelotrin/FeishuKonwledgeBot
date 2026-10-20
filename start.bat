@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then retry.
  pause
  exit /b 1
)
if not exist bot.config.json copy bot.config.example.json bot.config.json >nul
if not exist .env (
  copy .env.example .env >nul
  echo Fill in .env and bot.config.json, save them, then run start.bat again.
  notepad .env
  notepad bot.config.json
  exit /b 0
)
if not exist node_modules\@larksuiteoapi\node-sdk\package.json (
  call npm ci --ignore-scripts
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node --env-file=.env bot.mjs --check
if errorlevel 1 (
  pause
  exit /b 1
)
node --env-file=.env bot.mjs
pause
