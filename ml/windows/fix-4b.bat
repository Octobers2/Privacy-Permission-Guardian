@echo off
rem Double-click: retrains the 4B with the new chat/notification pages in its personal-data training (about 2 hours),
rem then scores it and prints a per-page-type table. Safe to run again: finished steps are skipped.
chcp 65001 >nul
setlocal
set "REPO=%USERPROFILE%\ppg-train\Privacy-Permission-Guardian"
cd /d "%REPO%" || ( echo Run start-training.bat first. & pause & exit /b 1 )
where git >nul 2>nul && git pull --ff-only origin accuracy-improvements
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set PYTHONUTF8=1
ml\.venv\Scripts\python.exe ml\run_plan.py --only 4bfix
echo.
if errorlevel 1 ( echo Stopped with an error: see the messages above. Double-click again to carry on. ) else ( echo Finished. Results: %REPO%\ml\reports\plan_summary.md )
pause
