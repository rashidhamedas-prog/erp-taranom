@echo off
setlocal
cd /d "%~dp0..\.."
node scripts\qa\run-clean.js %*
exit /b %ERRORLEVEL%
