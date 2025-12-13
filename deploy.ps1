# Deploy Turbo 8bit to Google App Engine
# Usage: .\deploy.ps1 [-Project <project-id>] [-Promote] [-Version <version>]

param(
    [string]$Project = "turbo8bit",
    [switch]$Promote = $true,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploying Turbo 8bit to App Engine" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Change to web directory
$webDir = Join-Path $PSScriptRoot "web"
Push-Location $webDir

try {
    # Check if gcloud is installed
    if (-not (Get-Command "gcloud" -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: gcloud CLI is not installed or not in PATH" -ForegroundColor Red
        Write-Host "Install from: https://cloud.google.com/sdk/docs/install" -ForegroundColor Yellow
        exit 1
    }

    # Show current project
    Write-Host "Project: $Project" -ForegroundColor Yellow
    Write-Host "Directory: $webDir" -ForegroundColor Yellow
    Write-Host ""

    # Build deploy command
    $deployArgs = @("app", "deploy", "app.yaml", "--project", $Project, "--quiet")
    
    if ($Version) {
        $deployArgs += "--version"
        $deployArgs += $Version
    }
    
    if (-not $Promote) {
        $deployArgs += "--no-promote"
    }

    Write-Host "Running: gcloud $($deployArgs -join ' ')" -ForegroundColor Gray
    Write-Host ""

    # Deploy
    & gcloud @deployArgs

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  Deployment successful!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "Site: https://$Project.appspot.com" -ForegroundColor Cyan
        Write-Host ""
        
        # Open in browser
        $openBrowser = Read-Host "Open in browser? (Y/n)"
        if ($openBrowser -ne "n" -and $openBrowser -ne "N") {
            Start-Process "https://$Project.appspot.com"
        }
    } else {
        Write-Host ""
        Write-Host "Deployment failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
