@echo off
rem Double-click to train on this PC. Gets (or updates) the accuracy-improvements branch, sets up Python + PyTorch
rem for the RTX 50-series, then runs ml\run_plan.py (steps 1, 5+6, 4). Safe to run again: finished steps are skipped.
rem Leave the window open while it works. Results: ml\reports\plan_summary.md; logs: ml\logs\.
chcp 65001 >nul
setlocal
set "BRANCH=accuracy-improvements"
set "WORK=%USERPROFILE%\ppg-train"
set "REPO=%WORK%\Privacy-Permission-Guardian"
if not exist "%WORK%" mkdir "%WORK%"

rem ---- 1. the code: git if installed, otherwise the branch as a zip from GitHub
where git >nul 2>nul
if %errorlevel%==0 (
  if exist "%REPO%\.git" (
    git -C "%REPO%" fetch origin %BRANCH% && git -C "%REPO%" checkout %BRANCH% && git -C "%REPO%" pull --ff-only origin %BRANCH%
  ) else (
    git clone --branch %BRANCH% https://github.com/Octobers2/Privacy-Permission-Guardian "%REPO%"
  )
) else (
  if not exist "%REPO%\ml\run_plan.py" (
    echo Git is not installed; downloading the branch as a zip instead...
    powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest https://github.com/Octobers2/Privacy-Permission-Guardian/archive/refs/heads/%BRANCH%.zip -OutFile '%WORK%\code.zip'; Expand-Archive -Force '%WORK%\code.zip' '%WORK%'; if (Test-Path '%REPO%') { Remove-Item -Recurse -Force '%REPO%' }; Rename-Item '%WORK%\Privacy-Permission-Guardian-%BRANCH%' 'Privacy-Permission-Guardian'"
  )
)
if not exist "%REPO%\ml\run_plan.py" ( echo Could not get the code. & pause & exit /b 1 )
cd /d "%REPO%"

rem ---- 2. Python: Miniconda/Anaconda in the user folder first (the "python" Windows puts on PATH is often only a
rem      shortcut to the Microsoft Store), else whatever is on PATH. setup.ps1 checks the version (3.11-3.13).
if exist "%USERPROFILE%\anaconda3\python.exe" set "PATH=%USERPROFILE%\anaconda3;%PATH%"
if exist "%USERPROFILE%\miniconda3\python.exe" set "PATH=%USERPROFILE%\miniconda3;%PATH%"

rem ---- 3. Bun (one step of the distillation data uses the extension's own sentence splitter)
where bun >nul 2>nul
if not %errorlevel%==0 if not exist "%USERPROFILE%\.bun\bin\bun.exe" (
  echo Installing Bun...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
)
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

rem ---- 4. environment (first time only), then the plan
if not exist "ml\.venv\Scripts\python.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -File ml\windows\setup.ps1
  if errorlevel 1 ( echo Setup failed: see the messages above. & pause & exit /b 1 )
)
set PYTHONUTF8=1
ml\.venv\Scripts\python.exe ml\run_plan.py %*
echo.
if errorlevel 1 ( echo Stopped with an error: see the messages above and ml\logs\. Double-click again after fixing it to carry on. ) else ( echo Finished. Results: %REPO%\ml\reports\plan_summary.md )
pause
