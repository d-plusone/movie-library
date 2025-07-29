# Movie Library - Force Uninstall PowerShell Script
# Run this as Administrator for complete removal

Write-Host "================================================================" -ForegroundColor Yellow
Write-Host "Movie Library - Force Uninstall Script" -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host "This script will completely remove Movie Library and all its data" -ForegroundColor Red
Write-Host "WARNING: This action cannot be undone!" -ForegroundColor Red
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host ""

$confirmation = Read-Host "Are you sure you want to proceed? (Type 'YES' to continue)"
if ($confirmation -ne 'YES') {
    Write-Host "Operation cancelled." -ForegroundColor Green
    exit
}

Write-Host ""
Write-Host "[1/6] Terminating Movie Library processes..." -ForegroundColor Cyan
try {
    Get-Process "Movie Library" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process "movie-library" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process "electron" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*movie-library*" } | Stop-Process -Force
    Write-Host "✓ Process termination completed." -ForegroundColor Green
} catch {
    Write-Host "⚠ Some processes may not have been terminated." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[2/6] Removing application data..." -ForegroundColor Cyan
$appDataPaths = @(
    "$env:APPDATA\Movie Library",
    "$env:APPDATA\movie-library",
    "$env:LOCALAPPDATA\Movie Library",
    "$env:LOCALAPPDATA\movie-library",
    "$env:TEMP\Movie Library",
    "$env:TEMP\movie-library"
)

foreach ($path in $appDataPaths) {
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "✓ Removed: $path" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "[3/6] Removing program files..." -ForegroundColor Cyan
$programPaths = @(
    "${env:ProgramFiles}\Movie Library",
    "$env:LOCALAPPDATA\Programs\Movie Library"
)

foreach ($path in $programPaths) {
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "✓ Removed: $path" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "[4/6] Cleaning registry entries..." -ForegroundColor Cyan
$registryKeys = @(
    "HKCU:\Software\Movie Library",
    "HKCU:\Software\movie-library",
    "HKLM:\Software\Movie Library",
    "HKLM:\Software\movie-library",
    "HKCU:\Software\Classes\Applications\Movie Library.exe",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe"
)

foreach ($key in $registryKeys) {
    try {
        if (Test-Path $key) {
            Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "✓ Removed registry key: $key" -ForegroundColor Green
        }
    } catch {
        Write-Host "⚠ Could not remove registry key: $key" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "[5/6] Removing shortcuts..." -ForegroundColor Cyan
$shortcuts = @(
    "$env:USERPROFILE\Desktop\Movie Library.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Movie Library"
)

foreach ($shortcut in $shortcuts) {
    if (Test-Path $shortcut) {
        Remove-Item $shortcut -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "✓ Removed: $shortcut" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "[6/6] Final cleanup..." -ForegroundColor Cyan
$finalPaths = @(
    "$env:USERPROFILE\.movie-library"
)

foreach ($path in $finalPaths) {
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "✓ Removed: $path" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "Movie Library has been completely removed from your system." -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""

Read-Host "Press Enter to exit"
