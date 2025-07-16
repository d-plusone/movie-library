# リリースガイド

## 自動リリースの流れ

1. **開発とテスト**
   - `main`または`develop`ブランチにプッシュするとビルドテストが実行されます
   - プルリクエストでもビルドテストが実行されます

2. **リリースの作成**
   ```bash
   # バージョンを更新
   npm version patch  # または minor, major
   
   # タグをプッシュ
   git push origin --tags
   ```

3. **自動ビルドとリリース**
   - タグがプッシュされると自動的にGitHub Actionsが実行されます
   - macOS (Intel + Apple Silicon) とWindows (x64) 向けのビルドが作成されます
   - GitHub Releasesに自動的に公開されます

## 生成されるファイル

### macOS
- `Movie Library-x.x.x.dmg` - インストーラー (Intel + Apple Silicon Universal)
- `Movie Library-x.x.x-mac.zip` - アプリケーションのzipファイル

### Windows
- `Movie Library Setup x.x.x.exe` - インストーラー
- `Movie Library-x.x.x-win.zip` - ポータブル版

## 手動ビルド

ローカルでビルドを実行する場合:

```bash
# 依存関係をインストール
npm ci

# macOS用ビルド
npm run build:mac

# Windows用ビルド (macOS上では動作しません)
npm run build:win

# 両方のプラットフォーム用ビルド
npm run build:all
```

## トラブルシューティング

### ビルドエラー
- ネイティブモジュール（sqlite3）のエラーが発生した場合:
  ```bash
  npm rebuild
  ```

### コード署名エラー (macOS)
- 開発用ビルドでは`CSC_IDENTITY_AUTO_DISCOVERY: false`を設定
- 本格的なリリースではApple Developer証明書が必要

### Windows用ビルドエラー
- Visual Studio Build Toolsが必要
- GitHub Actionsでは自動的にセットアップされます
