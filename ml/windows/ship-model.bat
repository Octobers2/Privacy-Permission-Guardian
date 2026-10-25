@echo off
rem Double-click after training: packs the new fast (0.8B) model for the browser, re-tests exactly what will ship,
rem and writes data\models (bundle + kernel + manifest.json). Safe to run again: finished steps are skipped.
chcp 65001 >nul
setlocal
set "REPO=%USERPROFILE%\ppg-train\Privacy-Permission-Guardian"
cd /d "%REPO%" || ( echo Run start-training.bat first. & pause & exit /b 1 )
where git >nul 2>nul && git pull --ff-only origin accuracy-improvements
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set PYTHONUTF8=1
ml\.venv\Scripts\python.exe ml\ship_model.py %*
echo.
if errorlevel 1 ( echo Stopped with an error: see the messages above. ) else ( echo Finished. The new model is in %REPO%\data\models )
pause
