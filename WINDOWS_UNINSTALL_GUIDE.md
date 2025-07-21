# Windows Uninstall Issues - Troubleshooting Guide

If you're experiencing issues uninstalling Movie Library on Windows, this guide provides several solutions.

## Quick Solutions

### Method 1: Force Uninstall Scripts

We provide two force uninstall scripts:

#### Batch Script (Recommended for most users)
1. Download `force-uninstall.bat` from the build folder
2. Right-click on the file and select "Run as administrator"
3. Follow the prompts

#### PowerShell Script (Advanced users)
1. Download `force-uninstall.ps1` from the build folder
2. Open PowerShell as Administrator
3. Run: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
4. Run: `.\force-uninstall.ps1`

### Method 2: Manual Uninstall

If the scripts don't work, follow these manual steps:

#### Step 1: Stop All Processes
1. Open Task Manager (Ctrl+Shift+Esc)
2. End these processes if running:
   - Movie Library.exe
   - electron.exe (associated with Movie Library)
   - node.exe (associated with Movie Library)

#### Step 2: Remove Application Files
Delete these directories if they exist:
- `C:\Program Files\Movie Library`
- `C:\Program Files (x86)\Movie Library`
- `%APPDATA%\Movie Library`
- `%LOCALAPPDATA%\Movie Library`
- `%APPDATA%\movie-library`
- `%LOCALAPPDATA%\movie-library`
- `%TEMP%\Movie Library`

#### Step 3: Clean Registry
1. Open Registry Editor (regedit)
2. Delete these keys if they exist:
   - `HKEY_CURRENT_USER\Software\Movie Library`
   - `HKEY_LOCAL_MACHINE\Software\Movie Library`
   - `HKEY_CURRENT_USER\Software\Classes\Applications\Movie Library.exe`

#### Step 4: Remove Shortcuts
Delete these files if they exist:
- Desktop shortcut: `Movie Library.lnk`
- Start Menu shortcut in Programs folder

## Common Causes of Uninstall Issues

1. **Background Processes**: The app may still be running in the background
2. **File Locks**: Some files may be locked by Windows
3. **Insufficient Permissions**: The uninstaller may need administrator privileges
4. **Corrupted Installation**: The original installation files may be corrupted

## Prevention

To avoid future uninstall issues:

1. **Always close Movie Library completely** before uninstalling
2. **Run the uninstaller as Administrator**
3. **Disable antivirus temporarily** during installation/uninstallation
4. **Use the official uninstaller** through Control Panel → Programs

## Advanced Troubleshooting

### Safe Mode Uninstall
If normal mode doesn't work:
1. Boot Windows in Safe Mode
2. Run the force uninstall script
3. Restart in normal mode

### Third-Party Uninstaller Tools
Consider using tools like:
- Revo Uninstaller
- IObit Uninstaller
- Geek Uninstaller

### System Restore
As a last resort:
1. Use System Restore to revert to before installation
2. This will remove the app but may affect other recent changes

## Need Help?

If none of these methods work:
1. Create an issue on our GitHub repository
2. Include your Windows version and error messages
3. Attach the log files from the uninstaller if available

## Developer Notes

The improved installer includes:
- Process termination before uninstall
- Deep cleanup of registry entries
- Removal of all application data
- Better error handling
- Administrator privilege checking

These improvements should significantly reduce uninstall issues in future versions.
