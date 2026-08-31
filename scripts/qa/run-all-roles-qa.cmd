@echo off
setlocal
cd /d "%~dp0..\.."
set NODE_ENV=test
node scripts\qa\run-all-roles-qa.js %*
exit /b %ERRORLEVEL%
