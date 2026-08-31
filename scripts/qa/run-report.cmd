@echo off
setlocal
cd /d "%~dp0..\.."
node scripts\qa\run-report.js %*
exit /b %ERRORLEVEL%
