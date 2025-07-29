# Windows アンインストールガイド - Movie Library

## 完全アンインストール

Movie Library バージョン 0.0.6 以降では、すべてのアプリケーションデータを自動的に削除する改良されたアンインストール機能が含まれています。ただし、手動でクリーンアップを行う必要がある場合や問題が発生した場合は、このガイドに従ってください。

## 自動アンインストール（推奨）

1. **Windows設定** → **アプリ** → **アプリと機能** に移動します
2. "Movie Library" を検索します
3. **Movie Library** をクリックして **アンインストール** を選択します
4. 確認画面で、動画データベースとサムネイルを含むすべてのユーザーデータを削除するために **"はい"** を選択します
5. アンインストーラーが自動的に以下を実行します：
   - 実行中のMovie Libraryプロセスの終了
   - アプリケーションファイルの削除
   - `%APPDATA%\Movie Library` のユーザーデータ削除
   - レジストリエントリのクリーンアップ
   - 一時ファイルの削除

## 手動クリーンアップ（必要な場合）

自動アンインストーラーですべてが削除されない場合は、以下の手順に従ってください：

### ステップ1: プロセスの終了
1. **タスクマネージャー**を開きます（Ctrl+Shift+Esc）
2. 以下の名前のプロセスを終了します：
   - Movie Library.exe
   - electron.exe（Movie Library関連）
   - node.exe（Movie Library関連）

### ステップ2: アプリケーションファイルの削除
以下のフォルダが存在する場合は、移動して削除してください：
```
C:\Users\[ユーザー名]\AppData\Roaming\Movie Library
C:\Users\[ユーザー名]\AppData\Local\Movie Library
C:\Users\[ユーザー名]\AppData\Roaming\movie-library
C:\Users\[ユーザー名]\AppData\Local\movie-library
```

### ステップ3: プログラムファイルの削除
インストールディレクトリを削除します（通常は以下の場所）：
```
C:\Program Files\Movie Library
C:\Users\[ユーザー名]\AppData\Local\Programs\Movie Library
```Issues - Troubleshooting Guide

If you're experiencing issues uninstalling Movie Library on Windows, this guide provides several solutions.

## クイック解決方法

### 方法1: 強制アンインストールスクリプト

2つの強制アンインストールスクリプトを提供しています：

#### バッチスクリプト（ほとんどのユーザーに推奨）

1. ビルドフォルダから `force-uninstall.bat` をダウンロードします
2. ファイルを右クリックして「管理者として実行」を選択します
3. プロンプトに従って操作してください

#### PowerShellスクリプト（上級ユーザー向け）

1. ビルドフォルダから `force-uninstall.ps1` をダウンロードします
2. PowerShellを管理者として開きます
3. 実行: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
4. 実行: `.\force-uninstall.ps1`

### 方法2: 手動アンインストール

スクリプトが動作しない場合は、以下の手動手順に従ってください：

#### ステップ1: すべてのプロセスを停止

1. タスクマネージャーを開きます（Ctrl+Shift+Esc）
2. 実行中の場合は以下のプロセスを終了します：
   - Movie Library.exe
   - electron.exe（Movie Libraryに関連付けられたもの）
   - node.exe（Movie Libraryに関連付けられたもの）

#### ステップ2: アプリケーションファイルの削除

以下のディレクトリが存在する場合は削除してください：

- `C:\Program Files\Movie Library`
- `C:\Program Files (x86)\Movie Library`
- `%APPDATA%\Movie Library`
- `%LOCALAPPDATA%\Movie Library`
- `%APPDATA%\movie-library`
- `%LOCALAPPDATA%\movie-library`
- `%TEMP%\Movie Library`

#### ステップ3: レジストリのクリーンアップ

1. レジストリエディター（regedit）を開きます
2. 以下のキーが存在する場合は削除してください：
   - `HKEY_CURRENT_USER\Software\Movie Library`
   - `HKEY_LOCAL_MACHINE\Software\Movie Library`
   - `HKEY_CURRENT_USER\Software\Classes\Applications\Movie Library.exe`

#### ステップ4: ショートカットの削除

以下のファイルが存在する場合は削除してください：

- デスクトップショートカット: `Movie Library.lnk`
- プログラムフォルダ内のスタートメニューショートカット

## アンインストール問題の一般的な原因

1. **バックグラウンドプロセス**: アプリがバックグラウンドで実行中の可能性があります
2. **ファイルロック**: 一部のファイルがWindowsによってロックされている可能性があります
3. **権限不足**: アンインストーラーに管理者権限が必要な場合があります
4. **破損したインストール**: 元のインストールファイルが破損している可能性があります

## 予防策

将来のアンインストール問題を避けるために：

1. **アンインストール前にMovie Libraryを完全に終了**してください
2. **アンインストーラーを管理者として実行**してください
3. **インストール/アンインストール中は一時的にアンチウイルスを無効化**してください
4. **コントロールパネル → プログラムから公式アンインストーラーを使用**してください

## 高度なトラブルシューティング

### セーフモードでのアンインストール

通常モードで動作しない場合：

1. Windowsをセーフモードで起動します
2. 強制アンインストールスクリプトを実行します
3. 通常モードで再起動します

### サードパーティアンインストールツール

以下のようなツールの使用を検討してください：

- Revo Uninstaller
- IObit Uninstaller
- Geek Uninstaller

### システムの復元

最後の手段として：

1. システムの復元を使用してインストール前の状態に戻します
2. これによりアプリは削除されますが、他の最近の変更にも影響する可能性があります

## ヘルプが必要な場合

これらの方法がいずれも機能しない場合：

1. GitHubリポジトリでIssueを作成してください
2. Windowsバージョンとエラーメッセージを含めてください
3. 利用可能な場合はアンインストーラーのログファイルを添付してください

## 開発者向けメモ

改良されたインストーラーには以下が含まれています：

- アンインストール前のプロセス終了
- レジストリエントリの詳細クリーンアップ
- すべてのアプリケーションデータの削除
- より良いエラーハンドリング
- 管理者権限のチェック

これらの改良により、将来のバージョンでアンインストール問題が大幅に削減されるはずです。
