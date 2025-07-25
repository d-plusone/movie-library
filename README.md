# Movie Library

Mac/Electron ベースの動画管理アプリケーション。直感的な UI/UX で動画ファイルの整理、サムネイル表示、評価管理などができます。

## 🎬 機能

### 基本機能

- 📁 **フォルダ監視**: 指定したフォルダ内の動画ファイルを自動スキャン（サブディレクトリも含む）
- 🖼️ **自動サムネイル生成**: FFmpeg を使用した高品質なサムネイル自動生成
  - ディレクトリ追加時の自動スキャン → サムネイル生成
  - 再スキャン完了時の自動サムネイル生成
- 🔍 **検索・フィルタ**: タイトル、タグ、評価、フォルダによる動画検索
- ⭐ **評価システム**: 5 段階評価とタグ付け機能
- 🎯 **詳細管理**: タイトル、説明、タグの編集
- 📅 **柔軟なソート**: ファイル名、タイトル、作成日、追加日、評価など

### UI/UX 機能

- 🎭 **ダークテーマ対応**: システム設定に従った自動切り替え
- 📱 **レスポンシブレイアウト**: グリッド/リスト表示の切り替え
- ⌨️ **キーボードナビゲーション**: 矢印キーによる直感的な操作
- 🔄 **サムネイル再生成**: ランダム位置でのメインサムネイル更新
- 📢 **統合通知システム**: 操作結果のリアルタイム表示とプログレス管理
- 🗂️ **ディレクトリフィルタ**: サブフォルダ含む柔軟なフォルダ絞り込み

### 技術仕様

- **プラットフォーム**: macOS (Intel + Apple Silicon), Windows
- **フレームワーク**: Electron 27
- **データベース**: better-sqlite3
- **動画処理**: FFmpeg
- **サポート形式**: MP4, AVI, MOV, MKV, WMV, FLV など（MOV ファイル完全対応）

## 📦 インストール

### リリース版 (推奨)

1. [Releases](https://github.com/iku/movie-library/releases) から最新版をダウンロード
2. お使いのプラットフォーム用のファイルを選択:
   - **macOS**: `Movie Library-x.x.x.dmg` (Universal Binary)
   - **Windows**: `Movie Library Setup x.x.x.exe`

### 開発版

```bash
# リポジトリをクローン
git clone https://github.com/iku/movie-library.git
cd movie-library

# 依存関係をインストール
npm install

# アプリを起動
npm start
```

## 🚀 使い方

### 初期設定

1. アプリを起動
2. 「フォルダを追加」ボタンをクリック
3. 動画ファイルが保存されているフォルダを選択
4. 自動的にスキャンとサムネイル生成が開始されます
   - サブフォルダも自動的にスキャンされます
   - スキャン完了後、自動でサムネイル生成が実行されます

### 基本操作

- **グリッド/リスト表示切り替え**: 右上のビューボタン
- **検索**: 右上の検索バーに入力
- **評価フィルタ**: 左サイドバーの星ボタン
- **フォルダフィルタ**: 左サイドバーのフォルダリスト（サブフォルダ含む）
- **ソート**: ヘッダーのソート選択（デフォルト: 作成日の新しい順）
- **詳細表示**: 動画をクリック
- **再生**: Enter キーまたは「再生」ボタン

### 自動化機能

- **フォルダ追加時**: スキャン → サムネイル生成を自動実行
- **再スキャン実行時**: 全動画再スキャン → サムネイル生成を自動実行
- **プログレス表示**: 長時間の処理は統合プログレスバーで進捗表示

### キーボードショートカット

- `↑↓←→`: 動画選択 (グリッド: 2 次元, リスト: 1 次元)
- `Enter`: 選択した動画を再生
- `Esc`: 詳細パネルを閉じる

## 🛠️ 開発

### 必要環境

- Node.js 18+
- Python 3.8+ (ネイティブモジュールビルド用)
- FFmpeg (自動インストール)

### セットアップ

```bash
# 依存関係をインストール
npm install

# 開発モード (デバッグログ有効)
npm run dev

# TypeScriptコンパイル
npm run build:ts:renderer    # レンダラーのみ
npm run build:ts            # 全てのTypeScript

# ビルド
npm run build:mac    # macOS用
npm run build:win    # Windows用
npm run build:all    # 全プラットフォーム
```

### プロジェクト構造

```
movie-library/
├── main.js              # メインプロセス
├── preload.js           # プリロードスクリプト
├── src/
│   ├── renderer/        # レンダラープロセス (TypeScript)
│   │   ├── app.ts       # メインアプリケーションロジック
│   │   ├── FilterManager.ts    # フィルタ管理
│   │   ├── VideoManager.ts     # 動画データ管理
│   │   ├── UIRenderer.ts       # UI描画
│   │   ├── Utils.ts     # ユーティリティ関数
│   │   ├── styles.css   # スタイルシート
│   │   └── index.html   # UI構造
│   ├── scanner/         # 動画スキャン機能
│   │   └── VideoScanner.ts
│   ├── thumbnail/       # サムネイル生成
│   │   └── ThumbnailGenerator.ts
│   ├── database/        # データベース関連
│   │   └── DatabaseManager.ts
│   ├── config/          # 設定ファイル (TypeScript)
│   └── types/           # 型定義 (TypeScript)
├── dist-ts/             # TypeScriptコンパイル結果
└── .github/workflows/   # CI/CDワークフロー
```

## 🔄 リリース

GitHub での自動リリースが設定されています:

```bash
# バージョンアップ
npm version patch  # or minor, major

# タグをプッシュ（自動ビルド開始）
git push origin --tags
```

詳細は [RELEASE.md](RELEASE.md) を参照してください。

## 🐛 トラブルシューティング

### MOV ファイルが表示されない

- アプリを再起動してディレクトリを再スキャン
- サブフォルダ内の MOV ファイルは自動的に検出されます

### サブフォルダの動画が表示されない

- フォルダフィルタで親フォルダが選択されているか確認
- ディレクトリフィルタを「全て選択」に設定してみる

### 自動サムネイル生成が動作しない

- 設定画面で「全ての動画を再スキャン」を実行
- プログレス表示で処理状況を確認

### アーキテクチャエラー (ARM64/Intel)

```bash
# エラー例: mach-o file, but is an incompatible architecture
# 解決方法: 依存関係を完全に再インストール
rm -rf node_modules package-lock.json
npm install
npm rebuild better-sqlite3
```

### TypeScript コンパイルエラー

```bash
# TypeScriptファイルを手動でコンパイル
npm run build:ts:renderer

# 型エラーの確認
npx tsc --noEmit
```

### ビルドエラー

```bash
# ネイティブモジュールの再ビルド
npm rebuild

# キャッシュクリア
rm -rf node_modules package-lock.json
npm install
```

### サムネイル生成エラー

- FFmpeg が正しくインストールされているか確認
- 動画ファイルの形式がサポートされているか確認
- ファイルパスに特殊文字が含まれていないか確認

### データベースエラー

- アプリを完全に終了して再起動
- `movie-library.db` ファイルを削除（データは失われます）
- better-sqlite3 のネイティブモジュールの再ビルド: `npm run rebuild:electron`

### Windows アンインストールの問題

通常のアンインストールが失敗する場合:

1. **force-uninstall ツールを使用**:

   - `tools/force-uninstall.bat` を管理者権限で実行
   - または `tools/force-uninstall.ps1` (PowerShell 版)

2. **詳細なトラブルシューティング**:
   - [WINDOWS_UNINSTALL_GUIDE.md](WINDOWS_UNINSTALL_GUIDE.md) を参照

## 📁 プロジェクト構造

```
movie-library/
├── src/                    # ソースコード
├── assets/                 # アイコンなどのアセット
├── tools/                  # ユーティリティツール
│   ├── force-uninstall.bat # Windows強制アンインストール(バッチ)
│   ├── force-uninstall.ps1 # Windows強制アンインストール(PowerShell)
│   └── README.md           # ツールの説明
├── installer/              # インストーラースクリプト
│   ├── installer.nsh       # NSIS カスタムスクリプト
│   └── README.md           # インストーラーの説明
└── docs/                   # ドキュメント
```

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) ファイルを参照してください。

## 🤝 貢献

1. このリポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

## 📞 サポート

- 🐛 バグレポート: [Issues](https://github.com/iku/movie-library/issues)
- 💡 機能要望: [Issues](https://github.com/iku/movie-library/issues)
- 📖 ドキュメント: [Wiki](https://github.com/iku/movie-library/wiki)

---

**Movie Library** - 動画管理をもっとシンプルに、もっと楽しく。
