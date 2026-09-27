@echo off
REM Launch native ERP without changing system ExecutionPolicy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-native-desktop.ps1"
if errorlevel 1 pause
