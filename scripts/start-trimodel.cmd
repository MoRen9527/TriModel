@echo off
cd /d D:\Code\ai\TriModel
if not exist dist\src\server.js (
  echo [start-trimodel] dist missing, aborting >> trimodel.err.log
  exit /b 1
)
C:\nvm4w\nodejs\node.exe dist\src\server.js >> trimodel.log 2>> trimodel.err.log
