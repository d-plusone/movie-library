@echo off
REM Movie Library - Force Uninstall Script
REM Run this script as Administrator if normal uninstall fails

echo Movie Library Force Uninstaller
echo ================================
echo This script will forcefully remove Movie Library and all its data
echo.

REM Check for admin privileges
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Running with Administrator privileges
) else (
    echo WARNING: Not running as Administrator. Some cleanup may fail.
    pause
)

echo.
echo Terminating all Movie Library processes...

REM Force kill all related processes
taskkill /f /im "Movie Library.exe" /t 2>nul
taskkill /f /im "electron.exe" /t 2>nul
taskkill /f /im "node.exe" /t 2>nul

echo Waiting for processes to terminate...
timeout /t 3 /nobreak >nul

echo.
echo Removing application directories...

REM Remove application directories
if exist "%PROGRAMFILES%\Movie Library" (
    echo Removing: %PROGRAMFILES%\Movie Library
    rmdir /s /q "%PROGRAMFILES%\Movie Library"
)

if exist "%PROGRAMFILES(X86)%\Movie Library" (
    echo Removing: %PROGRAMFILES(X86)%\Movie Library
    rmdir /s /q "%PROGRAMFILES(X86)%\Movie Library"
)

REM Remove user data
echo Removing user data...
if exist "%APPDATA%\Movie Library" (
    echo Removing: %APPDATA%\Movie Library
    rmdir /s /q "%APPDATA%\Movie Library"
)

if exist "%LOCALAPPDATA%\Movie Library" (
    echo Removing: %LOCALAPPDATA%\Movie Library
    rmdir /s /q "%LOCALAPPDATA%\Movie Library"
)

if exist "%APPDATA%\movie-library" (
    echo Removing: %APPDATA%\movie-library
    rmdir /s /q "%APPDATA%\movie-library"
)

if exist "%LOCALAPPDATA%\movie-library" (
    echo Removing: %LOCALAPPDATA%\movie-library
    rmdir /s /q "%LOCALAPPDATA%\movie-library"
)

REM Remove temp files
if exist "%TEMP%\Movie Library" (
    echo Removing: %TEMP%\Movie Library
    rmdir /s /q "%TEMP%\Movie Library"
)

echo.
echo Removing registry entries...

REM Remove registry entries
reg delete "HKEY_CURRENT_USER\Software\Movie Library" /f 2>nul
reg delete "HKEY_LOCAL_MACHINE\Software\Movie Library" /f 2>nul
reg delete "HKEY_CURRENT_USER\Software\Classes\Applications\Movie Library.exe" /f 2>nul
reg delete "HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe" /f 2>nul

REM Remove uninstaller entry
reg delete "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{insert-app-guid-here}" /f 2>nul
reg delete "HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Movie Library" /f 2>nul

echo.
echo Removing desktop shortcuts...
if exist "%PUBLIC%\Desktop\Movie Library.lnk" del "%PUBLIC%\Desktop\Movie Library.lnk"
if exist "%USERPROFILE%\Desktop\Movie Library.lnk" del "%USERPROFILE%\Desktop\Movie Library.lnk"

echo.
echo Removing start menu shortcuts...
if exist "%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk" del "%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk" del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk"

echo.
echo Force uninstall completed!
echo.
echo If you still experience issues, please:
echo 1. Restart your computer
echo 2. Run this script again as Administrator
echo 3. Manually check the listed directories for any remaining files
echo.
pause
