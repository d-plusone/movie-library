# Movie Library Tools

This directory contains utility tools for Movie Library.

## Uninstall Tools

### force-uninstall.bat
A Windows batch script for forcefully uninstalling Movie Library when the normal uninstaller fails.

**Usage:**
1. Right-click on `force-uninstall.bat`
2. Select "Run as administrator"
3. Follow the prompts

**Features:**
- Force terminates all Movie Library processes
- Removes all application directories
- Cleans registry entries
- Removes shortcuts
- Comprehensive cleanup

### force-uninstall.ps1
A PowerShell script version of the force uninstaller with enhanced error handling.

**Usage:**
1. Open PowerShell as Administrator
2. Set execution policy: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
3. Run: `.\force-uninstall.ps1`

**Features:**
- Same functionality as the batch script
- Better error reporting
- Colored output
- Enhanced admin privilege checking

## When to Use These Tools

Use these tools if:
- Normal uninstallation through Windows "Add or Remove Programs" fails
- You get "Cannot uninstall" errors
- The application appears to be partially installed
- Files or registry entries remain after normal uninstallation

## Safety Notes

- **Always run as Administrator** for complete cleanup
- **Close all Movie Library instances** before running
- These tools will remove ALL Movie Library data including:
  - Application files
  - User settings
  - Database files
  - Thumbnails
  - Registry entries

## Troubleshooting

If the scripts don't work:
1. Restart your computer and try again
2. Run Windows in Safe Mode and execute the script
3. Use third-party uninstaller tools
4. Manually follow the cleanup steps in `WINDOWS_UNINSTALL_GUIDE.md`

## Support

For additional help, see the main project documentation or create an issue on GitHub.
