# Custom NSIS script for Movie Library installer/uninstaller

# LogicLibをインクルード (If文を使うために必要)
!include "LogicLib.nsh"
!include "FileFunc.nsh"

# アンインストール前の処理
!macro customUnInstallCheck
    # プロセス終了をより確実にするためのスクリプト
    DetailPrint "Terminating running Movie Library processes..."

    # taskkillコマンドでプロセスを強制終了（出力抑制なし）
    ExecWait 'taskkill /f /im "Movie Library.exe" /t' $0
    ExecWait 'taskkill /f /im "movie-library.exe" /t' $0
    ExecWait 'taskkill /f /im "electron.exe" /t' $0
    ExecWait 'taskkill /f /im "node.exe" /t' $0

    # 少し待機してプロセスが完全に終了するのを待つ
    Sleep 5000

    DetailPrint "Process termination completed"
!macroend

# アンインストール後の徹底的なクリーンアップ
!macro customUnInit
    DetailPrint "Performing comprehensive cleanup..."

    # メインのアプリケーションデータディレクトリの削除
    RMDir /r "$APPDATA\Movie Library"
    RMDir /r "$APPDATA\movie-library"
    RMDir /r "$LOCALAPPDATA\Movie Library"
    RMDir /r "$LOCALAPPDATA\movie-library"

    # プログラム名の変形もチェック
    RMDir /r "$APPDATA\MovieLibrary"
    RMDir /r "$LOCALAPPDATA\MovieLibrary"

    # Electronの一般的なキャッシュディレクトリ
    RMDir /r "$APPDATA\movie-library-updater"
    RMDir /r "$LOCALAPPDATA\movie-library-updater"

    # テンポラリファイルの削除
    RMDir /r "$TEMP\Movie Library"
    RMDir /r "$TEMP\movie-library"
    RMDir /r "$TEMP\MovieLibrary"

    # ユーザー設定とプロファイルディレクトリ
    RMDir /r "$PROFILE\.movie-library"
    RMDir /r "$USERPROFILE\.movie-library"

    # 追加のアプリケーションキャッシュ
    RMDir /r "$LOCALAPPDATA\Programs\Movie Library"
    RMDir /r "$LOCALAPPDATA\Programs\movie-library"

    # データベースファイルとログの個別削除（念のため）
    Delete "$APPDATA\Movie Library\*.db"
    Delete "$APPDATA\Movie Library\*.db-*"
    Delete "$APPDATA\movie-library\*.db"
    Delete "$APPDATA\movie-library\*.db-*"
    Delete "$LOCALAPPDATA\Movie Library\*.db"
    Delete "$LOCALAPPDATA\Movie Library\*.db-*"
    Delete "$LOCALAPPDATA\movie-library\*.db"
    Delete "$LOCALAPPDATA\movie-library\*.db-*"

    # ログファイルの削除
    Delete "$APPDATA\Movie Library\*.log"
    Delete "$APPDATA\movie-library\*.log"
    Delete "$LOCALAPPDATA\Movie Library\*.log"
    Delete "$LOCALAPPDATA\movie-library\*.log"

    # レジストリキーの削除（HKCU）
    DeleteRegKey HKCU "Software\Movie Library"
    DeleteRegKey HKCU "Software\movie-library"
    DeleteRegKey HKCU "Software\MovieLibrary"

    # レジストリキーの削除（HKLM）- 管理者権限がある場合
    DeleteRegKey HKLM "Software\Movie Library"
    DeleteRegKey HKLM "Software\movie-library"
    DeleteRegKey HKLM "Software\MovieLibrary"

    # アプリケーション実行パスのクリーンアップ
    DeleteRegKey HKCU "Software\Classes\Applications\Movie Library.exe"
    DeleteRegKey HKCU "Software\Classes\Applications\movie-library.exe"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Movie Library.exe"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\movie-library.exe"

    # Windowsの「プログラムの追加と削除」関連のクリーンアップ
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Movie Library"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Movie Library"

    # Electronアプリ特有のレジストリエントリ
    DeleteRegKey HKCU "Software\Chromium"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\ApplicationAssociationToasts\movie-library"

    DetailPrint "Comprehensive cleanup completed successfully"
!macroend

# インストール前の処理
!macro preInit
    DetailPrint "Checking for running processes..."

    # 既存のプロセスをチェックして終了
    ExecWait 'tasklist /fi "imagename eq Movie Library.exe"' $0
    IntCmp $0 0 askuser skipcheck skipcheck

    askuser:
        MessageBox MB_YESNO|MB_ICONQUESTION "Movie Library is currently running. Do you want to close it and continue with the installation?" IDYES closeapp
        Abort

    closeapp:
        DetailPrint "Closing running Movie Library..."
        ExecWait 'taskkill /f /im "Movie Library.exe" /t'
        Sleep 2000

    skipcheck:
!macroend

# アンインストーラーのカスタムファイル削除
!macro customRemoveFiles
    DetailPrint "Removing application files and data..."

    # インストールディレクトリ内のアプリケーションファイル
    Delete "$INSTDIR\*.log"
    Delete "$INSTDIR\*.tmp"
    Delete "$INSTDIR\*.db"
    Delete "$INSTDIR\*.db-journal"
    Delete "$INSTDIR\*.db-wal"
    Delete "$INSTDIR\*.db-shm"
    
    # ディレクトリの削除
    RMDir /r "$INSTDIR\logs"
    RMDir /r "$INSTDIR\cache"
    RMDir /r "$INSTDIR\thumbnails"
    RMDir /r "$INSTDIR\chapters"
    RMDir /r "$INSTDIR\temp"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"

    # Node.jsモジュールとElectron関連ファイル
    RMDir /r "$INSTDIR\node_modules"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dll"

    # アプリケーション実行ファイル
    Delete "$INSTDIR\Movie Library.exe"
    Delete "$INSTDIR\movie-library.exe"
    Delete "$INSTDIR\electron.exe"

    # 設定ファイル
    Delete "$INSTDIR\package.json"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\*.config"

    DetailPrint "Application files removed"
!macroend

# アンインストール完了時の確認とユーザーオプション
!macro customUnInstallEnd
    DetailPrint "Uninstall process completed"
    
    # ユーザーにデータ削除について確認
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to completely remove all user data, including video database and thumbnails?$\n$\nThis action cannot be undone." IDNO skip_user_data
    
    # ユーザーがYesを選択した場合、より徹底的な削除を実行
    DetailPrint "Removing all user data..."
    
    # 確実に全てのユーザーデータを削除
    RMDir /r "$APPDATA\Movie Library"
    RMDir /r "$APPDATA\movie-library"
    RMDir /r "$LOCALAPPDATA\Movie Library"
    RMDir /r "$LOCALAPPDATA\movie-library"
    
    # 手動で作成された可能性のあるディレクトリも削除
    RMDir /r "$DOCUMENTS\Movie Library"
    RMDir /r "$PICTURES\Movie Library"
    
    MessageBox MB_OK "All user data has been removed successfully."
    Goto end_cleanup
    
    skip_user_data:
    MessageBox MB_OK "Application removed. User data has been preserved."
    
    end_cleanup:
!macroend

# カスタムページ：強制削除オプション
Function .onInstSuccess
    DetailPrint "Installation completed successfully"
FunctionEnd
