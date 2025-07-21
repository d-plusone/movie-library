# Movie Library - Force Uninstall PowerShell Script
# Run as Administrator for best results

param(
    [switch]$Force
)

Write-Host "Movie Library Force Uninstaller (PowerShell)" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check for admin privileges
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")

if (-not $isAdmin) {
    Write-Warning "Not running as Administrator. Some cleanup may fail."
    if (-not $Force) {
        $choice = Read-Host "Continue anyway? (y/N)"
        if ($choice -ne 'y' -and $choice -ne 'Y') {
            exit 1
        }
    }
}

Write-Host "Terminating all Movie Library processes..." -ForegroundColor Yellow

# Force kill all related processes
try {
    Get-Process -Name "Movie Library" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*Movie Library*" } | Stop-Process -Force
} catch {
    Write-Host "Some processes could not be terminated: $($_.Exception.Message)" -ForegroundColor Red
}

Start-Sleep -Seconds 3

Write-Host "Removing application directories..." -ForegroundColor Yellow

# Define directories to remove
$directories = @(
    "${env:PROGRAMFILES}\Movie Library",
    "${env:PROGRAMFILES(X86)}\Movie Library",
    "${env:APPDATA}\Movie Library",
    "${env:LOCALAPPDATA}\Movie Library",
    "${env:APPDATA}\movie-library",
    "${env:LOCALAPPDATA}\movie-library",
    "${env:TEMP}\Movie Library"
)

foreach ($dir in $directories) {
    if (Test-Path $dir) {
        Write-Host "Removing: $dir" -ForegroundColor Gray
        try {
            Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
            Write-Host "  Successfully removed" -ForegroundColor Green
        } catch {
            Write-Host "  Failed to remove: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Write-Host "Removing registry entries..." -ForegroundColor Yellow

# Registry paths to clean
$registryPaths = @(
    "HKCU:\Software\Movie Library",
    "HKLM:\Software\Movie Library",
    "HKCU:\Software\Classes\Applications\Movie Library.exe",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe"
)

foreach ($regPath in $registryPaths) {
    try {
        if (Test-Path $regPath) {
            Remove-Item -Path $regPath -Recurse -Force -ErrorAction Stop
            Write-Host "Removed registry key: $regPath" -ForegroundColor Green
        }
    } catch {
        Write-Host "Failed to remove registry key $regPath : $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "Removing shortcuts..." -ForegroundColor Yellow

# Shortcut paths to clean
$shortcuts = @(
    "${env:PUBLIC}\Desktop\Movie Library.lnk",
    "${env:USERPROFILE}\Desktop\Movie Library.lnk",
    "${env:PROGRAMDATA}\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk",
    "${env:APPDATA}\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk"
)

foreach ($shortcut in $shortcuts) {
    if (Test-Path $shortcut) {
        try {
            Remove-Item -Path $shortcut -Force -ErrorAction Stop
            Write-Host "Removed shortcut: $shortcut" -ForegroundColor Green
        } catch {
            Write-Host "Failed to remove shortcut $shortcut : $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "Force uninstall completed!" -ForegroundColor Green
Write-Host ""
Write-Host "If you still experience issues:" -ForegroundColor Yellow
Write-Host "1. Restart your computer" -ForegroundColor White
Write-Host "2. Run this script again as Administrator" -ForegroundColor White
Write-Host "3. Manually check the listed directories for any remaining files" -ForegroundColor White
Write-Host ""

if (-not $Force) {
    Read-Host "Press Enter to exit"
}
