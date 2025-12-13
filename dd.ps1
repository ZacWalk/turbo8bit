# Turbo 8bit CLI Tool
# Usage: .\dd.ps1 <command> [options]
#
# Commands:
#   deploy  - Deploy to Google App Engine
#   run     - Run the local development server
#   test    - Run all tests using pytest
#   gen     - Generate cover sheets and update related scripts

param(
    [Parameter(Position=0)]
    [ValidateSet("deploy", "run", "test", "gen", "format", "help", "demo", "crt")]
    [string]$Command = "help",
    
    # Deploy options
    [string]$Project = "turbo8bit",
    [switch]$NoPromote,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot

function Show-Help {
    Write-Host ""
    Write-Host "Turbo 8bit CLI Tool" -ForegroundColor Cyan
    Write-Host "===================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage: .\dd.ps1 <command> [options]" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Commands:" -ForegroundColor Green
    Write-Host "  deploy         - Deploy to Google App Engine"
    Write-Host "  run            - Run the local development server"
    Write-Host "  test           - Run all tests using pytest"
    Write-Host "  gen            - Generate cover sheets and update related scripts"
    Write-Host "  demo           - Build and run the Walker demo"
    Write-Host "  crt            - Deploy CRT files to Cloud Storage"
    Write-Host "  format         - Format Python files with Black"
    Write-Host "  format --check - Check formatting without changes"
    Write-Host "  help           - Show this help message"
    Write-Host ""
    Write-Host "Deploy Options:" -ForegroundColor Green
    Write-Host "  -Project <name>   - GCP project ID (default: turbo8bit)"
    Write-Host "  -NoPromote        - Don't promote the new version"
    Write-Host "  -Version <ver>    - Specific version name"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor Green
    Write-Host "  .\dd.ps1 run"
    Write-Host "  .\dd.ps1 test"
    Write-Host "  .\dd.ps1 deploy"
    Write-Host "  .\dd.ps1 deploy -Project myproject -Version v2"
    Write-Host "  .\dd.ps1 gen"
    Write-Host "  .\dd.ps1 demo"
    Write-Host ""
}

function Get-VenvPath {
    $venvPath = Join-Path $ScriptRoot ".venv"
    if (Test-Path $venvPath) {
        return $venvPath
    }
    return $null
}

function Get-VenvPython {
    $venvPath = Get-VenvPath
    if ($venvPath) {
        return Join-Path $venvPath "Scripts\python.exe"
    }
    return "python"
}

function Invoke-Format {
    $VenvPython = Get-VenvPython
    $checkOnly = $Args -contains "--check"
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Formatting Code" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    
    # Check if black is installed, install if not
    & $VenvPython -m black --version 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Black not found. Installing..." -ForegroundColor Yellow
        & $VenvPython -m pip install black
    }
    
    if ($checkOnly) {
        Write-Host "Checking Python formatting..." -ForegroundColor Yellow
        & $VenvPython -m black --check web/ tools/
    } else {
        Write-Host "Formatting Python files..." -ForegroundColor Yellow
        & $VenvPython -m black web/ tools/
    }
    
    Write-Host ""
    Write-Host "Formatting complete!" -ForegroundColor Green
}

function Invoke-Deploy {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Deploying Turbo 8bit to App Engine" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $webDir = Join-Path $ScriptRoot "web"
    Push-Location $webDir

    try {
        # Check if gcloud is installed
        if (-not (Get-Command "gcloud" -ErrorAction SilentlyContinue)) {
            Write-Host "ERROR: gcloud CLI is not installed or not in PATH" -ForegroundColor Red
            Write-Host "Install from: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
            exit 1
        }

        Write-Host "Project: $Project" -ForegroundColor Yellow
        Write-Host "Directory: $webDir" -ForegroundColor Yellow
        Write-Host ""

        # Build deploy command
        $deployArgs = @("app", "deploy", "app.yaml", "--project", $Project, "--quiet")
        
        if ($Version) {
            $deployArgs += "--version"
            $deployArgs += $Version
        }
        
        if ($NoPromote) {
            $deployArgs += "--no-promote"
        }

        Write-Host "Running: gcloud $($deployArgs -join ' ')" -ForegroundColor Gray
        Write-Host ""

        & gcloud @deployArgs

        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "========================================" -ForegroundColor Green
            Write-Host "  Deployment successful!" -ForegroundColor Green
            Write-Host "========================================" -ForegroundColor Green
            Write-Host ""
            Write-Host "View at: https://$Project.appspot.com" -ForegroundColor Cyan
        } else {
            Write-Host ""
            Write-Host "Deployment failed with exit code: $LASTEXITCODE" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Run {
    param([string]$OpenUrl = "http://localhost:8082")

    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Starting Turbo 8bit Server" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $venvPath = Join-Path $ScriptRoot ".venv"

    if (-not (Test-Path $venvPath)) {
        Write-Host "Virtual environment not found." -ForegroundColor Yellow
        Write-Host "Creating .venv..." -ForegroundColor Yellow
        python -m venv $venvPath
        
        # Install requirements
        $pip = Join-Path $venvPath "Scripts\pip.exe"
        $reqFile = Join-Path $ScriptRoot "web\requirements.txt"
        if (Test-Path $reqFile) {
            Write-Host "Installing requirements..." -ForegroundColor Yellow
            & $pip install -r $reqFile
        }
    }

    # Activate venv
    $activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
    . $activateScript

    # Set PYTHONPATH
    $env:PYTHONPATH = Join-Path $ScriptRoot "web"

    $port = 8082
    
    Write-Host "Starting server at $OpenUrl" -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""

    # Open browser after a short delay
    Start-Job -ScriptBlock { Start-Sleep -Seconds 2; Start-Process $using:OpenUrl } | Out-Null

    python (Join-Path $ScriptRoot "web\main.py")
}

function Invoke-Demo {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Building Walker Demo" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $VenvPython = Get-VenvPython
    $buildScript = Join-Path $ScriptRoot "demo\build.py"
    
    Write-Host "Running build.py..." -ForegroundColor Yellow
    & $VenvPython $buildScript
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build failed!" -ForegroundColor Red
        exit $LASTEXITCODE
    }
    
    Write-Host "Demo built successfully." -ForegroundColor Green
    Write-Host "Starting server..." -ForegroundColor Green
    
    Invoke-Run -OpenUrl "http://localhost:8082/demo"
}

function Invoke-Gen {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Generating Covers and Assets" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $venvPath = Join-Path $ScriptRoot ".venv"

    if (-not (Test-Path $venvPath)) {
        Write-Host "Virtual environment not found." -ForegroundColor Yellow
        Write-Host "Please run 'python -m venv .venv' and install requirements." -ForegroundColor Yellow
        exit 1
    }

    # Activate venv
    $activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
    . $activateScript

    # Set PYTHONPATH
    $env:PYTHONPATH = Join-Path $ScriptRoot "web"

    $buildCovers = Join-Path $ScriptRoot "tools\build_covers.py"
    
    Write-Host "Running build_covers.py..." -ForegroundColor Yellow
    python $buildCovers

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Generation complete!" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "Generation failed with exit code: $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

function Invoke-Test {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Running Turbo 8bit Tests" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $VenvPython = Get-VenvPython
    
    # Check if pytest is installed, install if not
    & $VenvPython -m pytest --version 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "pytest not found. Installing..." -ForegroundColor Yellow
        & $VenvPython -m pip install pytest py_mini_racer
    }
    
    $testsDir = Join-Path $ScriptRoot "tests"
    
    Wdemo"   { Invoke-Demo }
    "rite-Host "Running tests from: $testsDir" -ForegroundColor Yellow
    Write-Host ""
    
    & $VenvPython -m pytest $testsDir -v
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "All tests passed!" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "Some tests failed." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

function Invoke-Crt {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Deploying CRT files to Cloud Storage" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $crtDir = Join-Path $ScriptRoot "crt"
    $bucket = "gs://turbo8bit-crt"

    # Check if gcloud is installed
    if (-not (Get-Command "gcloud" -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: gcloud CLI is not installed or not in PATH" -ForegroundColor Red
        Write-Host "Install from: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
        exit 1
    }

    # Check if crt directory exists
    if (-not (Test-Path $crtDir)) {
        Write-Host "ERROR: CRT directory not found: $crtDir" -ForegroundColor Red
        exit 1
    }

    Write-Host "Source: $crtDir" -ForegroundColor Yellow
    Write-Host "Bucket: $bucket" -ForegroundColor Yellow
    Write-Host ""

    # Create bucket if it doesn't exist
    Write-Host "Ensuring bucket exists..." -ForegroundColor Gray
    & gcloud storage buckets describe $bucket 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Creating bucket $bucket..." -ForegroundColor Yellow
        & gcloud storage buckets create $bucket --project=$Project --location=US --uniform-bucket-level-access
        
        # Set CORS for browser access
        Write-Host "Setting CORS policy..." -ForegroundColor Gray
        $corsFile = Join-Path $env:TEMP "cors.json"
        @'
[
  {
    "origin": ["*"],
    "method": ["GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
'@ | Out-File -FilePath $corsFile -Encoding UTF8
        & gcloud storage buckets update $bucket --cors-file=$corsFile
        Remove-Item $corsFile

        # Make bucket publicly readable
        Write-Host "Setting public access..." -ForegroundColor Gray
        & gcloud storage buckets add-iam-policy-binding $bucket --member=allUsers --role=roles/storage.objectViewer
    }

    # Upload all files
    Write-Host ""
    Write-Host "Uploading CRT files..." -ForegroundColor Yellow
    
    $files = Get-ChildItem -Path $crtDir -File
    foreach ($file in $files) {
        Write-Host "  Uploading: $($file.Name)" -ForegroundColor Gray
        & gcloud storage cp $file.FullName "$bucket/$($file.Name)"
    }

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  CRT files deployed successfully!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "Files available at: https://storage.googleapis.com/turbo8bit-crt/" -ForegroundColor Cyan
    } else {
        Write-Host ""
        Write-Host "Upload failed with exit code: $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

# Main
switch ($Command) {
    "deploy" { Invoke-Deploy }
    "run"    { Invoke-Run }
    "test"   { Invoke-Test }
    "gen"    { Invoke-Gen }
    "demo"   { Invoke-Demo }
    "crt"    { Invoke-Crt }
    "format" { Invoke-Format }
    "help"   { Show-Help }
    default  { Show-Help }
}
