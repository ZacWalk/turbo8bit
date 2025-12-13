$ErrorActionPreference = "Stop"

# Check if venv exists
if (-not (Test-Path "venv")) {
    Write-Host "Virtual environment not found. Please run 'python -m venv venv' and install requirements." -ForegroundColor Yellow
    exit 1
}

# Activate venv
. .\venv\Scripts\Activate.ps1

# Set PYTHONPATH to include the web directory
$env:PYTHONPATH = "$PWD\web"

# Run the server
Write-Host "Starting Turbo8Bit server..." -ForegroundColor Green
python web/main.py
