# Movie Library Installer Scripts

This directory contains scripts used during the build process to create Windows installers.

## Files

### installer.nsh

Custom NSIS (Nullsoft Scriptable Install System) script that enhances the Windows installer with:

- **Process Management**: Automatically terminates running Movie Library processes before installation/uninstallation
- **Deep Cleanup**: Comprehensive removal of application data, registry entries, and temporary files
- **Admin Privilege Handling**: Proper elevation and permission management
- **Error Handling**: Robust error handling during installation and uninstallation

## Usage

These scripts are automatically used by electron-builder during the build process. They are referenced in `package.json` under the `nsis` configuration.

## Build Integration

The installer script is integrated into the build process via:

```json
"nsis": {
  "include": "installer/installer.nsh"
}
```

## Customization

You can modify `installer.nsh` to:

- Add custom installation steps
- Modify cleanup behavior
- Add additional registry entries
- Customize uninstallation process

## NSIS Macros

The script defines several macros:

- `customUnInstallCheck`: Process termination before uninstall
- `customUnInit`: Deep cleanup after uninstall
- `preInit`: Pre-installation checks
- `customRemoveFiles`: Additional file cleanup

## Testing

When testing installer changes:

1. Build the Windows installer: `npm run build:win`
2. Test installation on a clean Windows system
3. Test uninstallation to ensure clean removal
4. Verify all files and registry entries are properly cleaned

## Dependencies

- NSIS installer system
- Windows-specific commands (taskkill, reg, etc.)
- electron-builder for integration
