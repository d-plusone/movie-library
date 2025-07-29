# Custom NSIS script for Movie Library installer/uninstaller

# 必要なライブラリをインクルード
!include LogicLib.nsh

# アンインストール後の追加クリーンアップ
!macro customUnInit
    DetailPrint "Performing deep cleanup..."

    # 最終確認メッセージ
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to remove all user data and settings? This action cannot be undone." IDNO skipDeepClean

    # アプリケーションデータディレクトリの削除
    RMDir /r "$APPDATA\Movie Library"
    RMDir /r "$LOCALAPPDATA\Movie Library"

    # 残存するテンポラリファイルの削除
    RMDir /r "$TEMP\Movie Library"

    # Electronアプリケーション用のキャッシュディレクトリ
    RMDir /r "$APPDATA\movie-library"
    RMDir /r "$LOCALAPPDATA\movie-library"

    # ユーザー設定ディレクトリの削除
    RMDir /r "$PROFILE\.movie-library"

    # レジストリキーの削除
    DeleteRegKey HKCU "Software\Movie Library"
    DeleteRegKey HKLM "Software\Movie Library"
    DeleteRegKey HKCU "Software\Classes\Applications\Movie Library.exe"

    # ファイル関連付けのクリーンアップ
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe"

    # Chromiumキャッシュの削除（Electronアプリが使用）
    RMDir /r "$LOCALAPPDATA\movie-library\User Data"
    RMDir /r "$APPDATA\movie-library\User Data"

    DetailPrint "Deep cleanup completed successfully"
    Goto cleanupDone

    skipDeepClean:
    DetailPrint "Skipped deep cleanup as requested"

    cleanupDone:
!macroend

# インストール前の処理
!macro preInit
    DetailPrint "Checking for running processes..."

    # 既存のプロセスをチェックして終了
    ExecWait 'cmd /c tasklist /fi "imagename eq Movie Library.exe" | find "Movie Library.exe" >nul 2>&1' $0
    ${If} $0 == 0
        MessageBox MB_YESNO|MB_ICONQUESTION "Movie Library is currently running. Do you want to close it and continue with the installation?" IDYES +2
        Abort

        DetailPrint "Closing running Movie Library..."
        ExecWait 'cmd /c taskkill /f /im "Movie Library.exe" /t 2>nul'
        Sleep 2000
    ${EndIf}
!macroend

# アンインストーラーのカスタムセクション
!macro customRemoveFiles
    DetailPrint "Removing additional files..."

    # ログファイルとキャッシュの削除
    Delete "$INSTDIR\*.log"
    Delete "$INSTDIR\*.tmp"
    Delete "$INSTDIR\*.old"
    Delete "$INSTDIR\*.bak"
    RMDir /r "$INSTDIR\logs"
    RMDir /r "$INSTDIR\cache"
    RMDir /r "$INSTDIR\thumbnails"
    RMDir /r "$INSTDIR\temp"

    # SQLiteデータベースの削除
    Delete "$INSTDIR\*.db"
    Delete "$INSTDIR\*.db-journal"
    Delete "$INSTDIR\*.db-wal"
    Delete "$INSTDIR\*.db-shm"

    # Node.js関連ファイルの削除
    RMDir /r "$INSTDIR\node_modules"
    Delete "$INSTDIR\package.json"
    Delete "$INSTDIR\package-lock.json"

    # Electron関連ファイルの削除
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.node"
    RMDir /r "$INSTDIR\resources"

    # 設定ファイルとプリズマファイルの削除
    Delete "$INSTDIR\*.env"
    Delete "$INSTDIR\*.env.local"
    RMDir /r "$INSTDIR\prisma"
    RMDir /r "$INSTDIR\generated"

    # TypeScriptビルド成果物の削除
    RMDir /r "$INSTDIR\dist"
    RMDir /r "$INSTDIR\dist-ts"
    RMDir /r "$INSTDIR\build"

    # その他の開発ファイル
    Delete "$INSTDIR\*.map"
    Delete "$INSTDIR\*.ts"
    Delete "$INSTDIR\*.js"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\*.md"
    Delete "$INSTDIR\*.txt"
    Delete "$INSTDIR\*.ico"
    Delete "$INSTDIR\*.png"
    Delete "$INSTDIR\*.icns"
    RMDir /r "$INSTDIR\assets"
    RMDir /r "$INSTDIR\src"
    RMDir /r "$INSTDIR\scripts"

    DetailPrint "Additional files removed"
!macroend

# 完全なアンインストール用のマクロ
!macro customUninstall
    DetailPrint "Performing complete application removal..."

    # インストールディレクトリ全体を強制削除
    RMDir /r "$INSTDIR"

    # Electronアプリケーション用のキャッシュとデータディレクトリ
    RMDir /r "$APPDATA\Movie Library"
    RMDir /r "$LOCALAPPDATA\Movie Library"
    RMDir /r "$APPDATA\movie-library"
    RMDir /r "$LOCALAPPDATA\movie-library"

    # Chromiumキャッシュ（Electronアプリが使用）
    RMDir /r "$LOCALAPPDATA\movie-library\User Data"
    RMDir /r "$APPDATA\movie-library\User Data"

    # 一時ファイルとキャッシュ
    RMDir /r "$TEMP\Movie Library"
    RMDir /r "$TEMP\movie-library"

    # ユーザー設定とプロファイル
    RMDir /r "$PROFILE\.movie-library"
    Delete "$PROFILE\.movie-library-config"

    # レジストリキーの完全削除
    DeleteRegKey HKCU "Software\Movie Library"
    DeleteRegKey HKLM "Software\Movie Library"
    DeleteRegKey HKCU "Software\Classes\Applications\Movie Library.exe"
    DeleteRegKey HKLM "Software\Classes\Applications\Movie Library.exe"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe"

    # アンインストール情報の削除
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

    # スタートメニューとデスクトップショートカットの削除
    Delete "$SMPROGRAMS\Movie Library.lnk"
    Delete "$DESKTOP\Movie Library.lnk"
    Delete "$QUICKLAUNCH\Movie Library.lnk"

    # 関連付けのクリーンアップ
    DeleteRegKey HKCU "Software\Classes\.mp4\OpenWithProgids\Movie Library"
    DeleteRegKey HKCU "Software\Classes\.avi\OpenWithProgids\Movie Library"
    DeleteRegKey HKCU "Software\Classes\.mkv\OpenWithProgids\Movie Library"

    DetailPrint "Complete application removal finished"
!macroend

# カスタムページ：強制削除オプション
Function .onInstSuccess
    DetailPrint "Installation completed successfully"
FunctionEnd

# アンインストール開始時の処理マクロ
!macro customUninstallCheck
    DetailPrint "Starting uninstaller..."

    # アプリケーションプロセスの強制終了
    DetailPrint "Terminating any running Movie Library processes..."
    ExecWait 'cmd /c taskkill /f /im "Movie Library.exe" /t 2>nul' $0
    ExecWait 'cmd /c taskkill /f /im "electron.exe" /t 2>nul' $0
    ExecWait 'cmd /c taskkill /f /im "node.exe" /t 2>nul' $0
    Sleep 2000

    # 最終確認
    MessageBox MB_YESNO|MB_ICONQUESTION "This will completely remove Movie Library and all its associated files. Are you sure you want to continue?" IDYES +2
    Abort
!macroend
