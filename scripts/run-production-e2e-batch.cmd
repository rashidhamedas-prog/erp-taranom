@echo off
REM Production 0-100 live E2E batch
REM Usage: scripts\run-production-e2e-batch.cmd YOUR_PASSWORD
REM    or: set ERP_ADMIN_PASSWORD=... && scripts\run-production-e2e-batch.cmd

setlocal
cd /d "%~dp0.."
if not "%~1"=="" set ERP_ADMIN_PASSWORD=%~1
if "%ERP_ADMIN_PASSWORD%"=="" (
  echo Password required as arg1 or ERP_ADMIN_PASSWORD
  exit /b 2
)
if "%ERP_BASE_URL%"=="" set ERP_BASE_URL=https://erptaranom.com
if "%ERP_ADMIN_USER%"=="" set ERP_ADMIN_USER=admin

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-production-e2e-batch.ps1" -BaseUrl "%ERP_BASE_URL%" -User "%ERP_ADMIN_USER%" -Password "%ERP_ADMIN_PASSWORD%"
exit /b %ERRORLEVEL%
