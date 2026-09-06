@echo off
setlocal
cd /d "%~dp0..\.."
set NODE_ENV=test
node scripts\qa\run-full-erp-qa.js %*
exit /b %ERRORLEVEL%
