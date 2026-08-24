@echo off
setlocal
cd /d "%~dp0..\.."
set NODE_ENV=test
node scripts\qa\run-admin-qa.js %*
exit /b %ERRORLEVEL%
