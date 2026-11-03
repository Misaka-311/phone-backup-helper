@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=D:\tool\node\node.exe"
"%NODE_EXE%" --test --test-isolation=none "test/**/*.test.mjs" %* & rd /s /q "_test_out" 2>nul
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
endlocal
exit /b %CODE%
