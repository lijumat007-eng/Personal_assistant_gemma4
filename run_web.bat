@echo off
title Jarvis Celestial Server
echo ========================================================
echo               STARTING JARVIS CELESTIAL WEB UI
echo ========================================================
echo.
echo Launching local FastAPI server at http://localhost:8000/
echo The interface will serve directly from the browser.
echo.
echo Press Ctrl+C in this terminal to stop the server.
echo.
python -m uvicorn web_server:app --host 127.0.0.1 --port 8000
pause
