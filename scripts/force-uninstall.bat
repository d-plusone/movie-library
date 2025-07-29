@echo off
echo ================================================================
echo Movie Library - Force Uninstall Script
echo ================================================================
echo This script will completely remove Movie Library and all its data
echo WARNING: This action cannot be undone!
echo ================================================================
echo.

pause

echo.
echo [1/6] Terminating Movie Library processes...
taskkill /f /im "Movie Library.exe" /t 2>nul
taskkill /f /im "movie-library.exe" /t 2>nul
taskkill /f /im "electron.exe" /t 2>nul
wmic process where "CommandLine like '%%movie-library%%'" delete 2>nul
echo Process termination completed.

echo.
echo [2/6] Removing application data...
rmdir /s /q "%APPDATA%\Movie Library" 2>nul
rmdir /s /q "%APPDATA%\movie-library" 2>nul
rmdir /s /q "%LOCALAPPDATA%\Movie Library" 2>nul
rmdir /s /q "%LOCALAPPDATA%\movie-library" 2>nul
rmdir /s /q "%TEMP%\Movie Library" 2>nul
rmdir /s /q "%TEMP%\movie-library" 2>nul
echo Application data removed.

echo.
echo [3/6] Removing program files...
rmdir /s /q "%PROGRAMFILES%\Movie Library" 2>nul
rmdir /s /q "%LOCALAPPDATA%\Programs\Movie Library" 2>nul
echo Program files removed.

echo.
echo [4/6] Cleaning registry entries...
reg delete "HKEY_CURRENT_USER\Software\Movie Library" /f 2>nul
reg delete "HKEY_CURRENT_USER\Software\movie-library" /f 2>nul
reg delete "HKEY_LOCAL_MACHINE\Software\Movie Library" /f 2>nul
reg delete "HKEY_LOCAL_MACHINE\Software\movie-library" /f 2>nul
reg delete "HKEY_CURRENT_USER\Software\Classes\Applications\Movie Library.exe" /f 2>nul
reg delete "HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe" /f 2>nul
echo Registry cleanup completed.

echo.
echo [5/6] Removing shortcuts...
del "%USERPROFILE%\Desktop\Movie Library.lnk" 2>nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Movie Library.lnk" 2>nul
rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Movie Library" 2>nul
echo Shortcuts removed.

echo.
echo [6/6] Final cleanup...
rmdir /s /q "%USERPROFILE%\.movie-library" 2>nul
echo Final cleanup completed.

echo.
echo ================================================================
echo Movie Library has been completely removed from your system.
echo ================================================================
echo.

pause
