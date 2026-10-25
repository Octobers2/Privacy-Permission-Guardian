@echo off
rem Double-click: packs the new accurate (4B) model for the browser, re-tests exactly what will ship, and adds it to data\models.
chcp 65001 >nul
setlocal
set "REPO=%USERPROFILE%\ppg-train\Privacy-Permission-Guardian"
cd /d "%REPO%" || ( echo Run start-training.bat first. & pause & exit /b 1 )
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set PYTHONUTF8=1
ml\.venv\Scripts\python.exe ml\ship_model.py --run j4b-v1b --size 4B --tier accurate --replaces run4bmt-rtn4-deq-letter
echo.
if errorlevel 1 ( echo Stopped with an error: see the messages above. ) else ( echo Finished. The new model is in %REPO%\data\models )
pause
