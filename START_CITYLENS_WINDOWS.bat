@echo off
title CityLens AI
echo ============================================
echo   CityLens AI - Urban Intelligence Platform
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Install Node 18+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)
echo Starting server on http://localhost:4000 ...
start "" http://localhost:4000/app
node server.js
pause
