@echo off
setlocal

echo Starting caption service on port 3001...
start "caption-service" cmd /k "cd /d %~dp0caption-service && npm install && npm start"

echo Starting FastAPI backend on port 8000...
start "backend" cmd /k "cd /d %~dp0backend && python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000"

echo.
echo Local services:
echo   Caption service: http://127.0.0.1:3001/health
echo   Backend API:       http://127.0.0.1:8000/api/health
echo.
echo Start the frontend separately with: cd frontend ^&^& npm run dev
