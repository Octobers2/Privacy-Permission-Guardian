# One-time setup of the training environment on Windows (RTX 50-series / Blackwell needs CUDA 12.8 builds of PyTorch).
# Run from the repository root in PowerShell:   powershell -ExecutionPolicy Bypass -File ml\windows\setup.ps1
# Creates ml\.venv (not in git). Needs Python 3.11-3.13 on PATH (python.org, or conda's python) and ~25 GB free disk
# for the models. Bun (https://bun.sh) is needed for one step of the distillation data.
$ErrorActionPreference = "Stop"
$ml = Split-Path -Parent $PSScriptRoot
Set-Location $ml

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw "Python is not on PATH. Install Python 3.12 from python.org (tick 'Add to PATH'), then run this again." }
$ver = & $py -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ([version]$ver -lt [version]"3.11" -or [version]$ver -ge [version]"3.14") { throw "Python $ver found; need 3.11, 3.12 or 3.13." }

if (-not (Test-Path ".venv")) { & $py -m venv .venv }
$vpy = Join-Path $ml ".venv\Scripts\python.exe"
& $vpy -m pip install --upgrade pip
# PyTorch with CUDA 12.8 (the first CUDA line that supports RTX 50-series cards)
& $vpy -m pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cu128
# Same versions as ml/env/kev.txt (the Linux environment), minus Linux-only packages such as triton
& $vpy -m pip install transformers==5.17.0 peft==0.21.0 accelerate==1.15.0 numpy==2.5.3 scipy==1.18.1 `
    huggingface_hub safetensors datasets pandas pyarrow scikit-learn faker httpx beautifulsoup4 lxml

Write-Host "`nChecking the GPU..."
& $vpy -c "import torch; assert torch.cuda.is_available(), 'CUDA not available: update the NVIDIA driver'; print('OK:', torch.cuda.get_device_name(0), 'compute', torch.cuda.get_device_capability(0), round(torch.cuda.get_device_properties(0).total_memory/2**30,1), 'GB')"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Write-Warning "Bun is not installed; the distillation step needs it: powershell -c \"irm bun.sh/install.ps1 | iex\"" }
Write-Host "`nDone. Start everything with:   ml\.venv\Scripts\python.exe ml\run_plan.py"
