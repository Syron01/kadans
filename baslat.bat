@echo off
title Kadans
cd /d "%~dp0"
echo [Kadans] Backend baslatiliyor (port 8000)...
start "Kadans API" /min cmd /c "pip install -q -r backend\requirements.txt & python -m uvicorn main:app --port 8000 --app-dir backend"
timeout /t 4 >nul
start "" "http://localhost:8123/?api=http://127.0.0.1:8000"
echo [Kadans] Statik sunucu baslatiliyor (port 8123)...
python -m http.server 8123
