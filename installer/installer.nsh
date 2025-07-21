# Custom NSIS script for Movie Library installer/uninstaller

# アンインストール前の処理
!macro customUnInstallCheck
    # プロセス終了をより確実にするためのスクリプト
    DetailPrint "Terminating running Movie Library processes..."
    
    # taskkillコマンドでプロセスを強制終了
    ExecWait 'cmd /c taskkill /f /im "Movie Library.exe" /t 2>nul' $0
    ExecWait 'cmd /c taskkill /f /im "electron.exe" /t 2>nul' $0
    ExecWait 'cmd /c taskkill /f /im "node.exe" /t 2>nul' $0
    
    # 少し待機
    Sleep 3000
    
    DetailPrint "Process termination completed"
!macroend

# アンインストール後の追加クリーンアップ
!macro customUnInit
    DetailPrint "Performing deep cleanup..."
    
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
    
    DetailPrint "Deep cleanup completed successfully"
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
    RMDir /r "$INSTDIR\logs"
    RMDir /r "$INSTDIR\cache"
    RMDir /r "$INSTDIR\thumbnails"
    RMDir /r "$INSTDIR\temp"
    
    # SQLiteデータベースの削除
    Delete "$INSTDIR\*.db"
    Delete "$INSTDIR\*.db-journal"
    Delete "$INSTDIR\*.db-wal"
    Delete "$INSTDIR\*.db-shm"
    
    DetailPrint "Additional files removed"
!macroend

# カスタムページ：強制削除オプション
Function .onInstSuccess
    DetailPrint "Installation completed successfully"
FunctionEnd

Function un.onInit
    DetailPrint "Starting uninstaller..."
    
    # 管理者権限の確認
    UserInfo::GetAccountType
    Pop $0
    ${If} $0 != "admin"
        MessageBox MB_YESNO|MB_ICONQUESTION "Administrator privileges are recommended for complete uninstallation. Continue anyway?" IDYES +2
        Abort
    ${EndIf}
FunctionEnd
