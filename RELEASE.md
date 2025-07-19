# リリースガイド

## 最新の主要機能 (v0.0.6+)

### 🔄 自動化ワークフロー
- ディレクトリ追加時の自動スキャン→サムネイル生成
- 再スキャン完了時の自動サムネイル生成
- 統合プログレス管理による処理状況表示

### 📁 サブディレクトリサポート
- 選択フォルダのサブディレクトリも自動スキャン
- フォルダフィルタでサブフォルダ内コンテンツも適切に表示
- MOVファイルの完全サポート

### 🎯 UI/UX改善
- 作成日降順のデフォルトソート
- 統合プログレスバーによる処理状況表示
- TypeScript化による型安全性向上

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
   - タグがプッシュされると自動的に GitHub Actions が実行されます
   - macOS (Intel + Apple Silicon) と Windows (x64) 向けのビルドが作成されます
   - GitHub Releases に自動的に公開されます

## 生成されるファイル

### macOS

- `Movie Library-x.x.x.dmg` - インストーラー (Intel + Apple Silicon Universal)
- `Movie Library-x.x.x-mac.zip` - アプリケーションの zip ファイル

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
- 本格的なリリースでは Apple Developer 証明書が必要

### Windows 用ビルドエラー

- Visual Studio Build Tools が必要
- GitHub Actions では自動的にセットアップされます

# バージョン管理とリリースプロセス

## タグベースのバージョン管理

GitHub Actions はタグ名からバージョンを自動取得し、package.json を更新します。

### 新しいリリースの作成方法

#### 1. 自動バージョンアップとタグ作成（推奨）

```bash
# パッチバージョン (0.0.6 → 0.0.7)
npm run version:patch

# マイナーバージョン (0.0.6 → 0.1.0)
npm run version:minor

# メジャーバージョン (0.0.6 → 1.0.0)
npm run version:major
```

#### 2. 手動でタグを作成

```bash
# package.jsonのバージョンを手動更新後
git add package.json
git commit -m "Bump version to 0.0.7"
git tag v0.0.7
git push origin main --tags
```

## GitHub Actions での自動処理

1. **タグプッシュ検出**: `v*` パターンのタグがプッシュされると自動開始
2. **バージョン抽出**: タグ名（`v0.0.7`）からバージョン（`0.0.7`）を抽出
3. **package.json 同期**: 抽出したバージョンで package.json を更新
4. **ビルド実行**: 更新されたバージョンでアプリをビルド
5. **アーティファクト生成**: バージョン付きファイル名で成果物を作成

## 成果物の命名規則

- **macOS**: `Movie Library-{version}-{arch}.dmg`
- **Windows**: `Movie Library-{version}-{arch}.exe`

例：

- `Movie Library-0.0.7-arm64.dmg` (Apple Silicon)
- `Movie Library-0.0.7-x64.dmg` (Intel Mac)
- `Movie Library-0.0.7-x64.exe` (Windows)
