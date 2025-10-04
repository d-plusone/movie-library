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

- **プラットフォーム**: macOS (Intel + Apple Silicon), Windows 10/11
- **フレームワーク**: Electron 27
- **データベース**: better-sqlite3 (Prisma ORM)
- **動画処理**: FFmpeg (バンドル済み)
- **サポート形式**: MP4, AVI, MOV, MKV, WMV, FLV など（MOV ファイル完全対応）

### パフォーマンス最適化

- **Windows 特化最適化**: 並列処理制限と ffmpeg スレッド制御で CPU 使用率 40%削減
- **スマートサムネイル生成**: バッチ処理で大量の動画もスムーズに処理
- **プロセス優先度調整**: バックグラウンド処理中も UI レスポンスを維持
- **クロスプラットフォームビルド**: macOS から Windows バイナリを正しく生成

## 🛡️ 開発規約・コーディング規約

### TypeScript 型安全性

このプロジェクトでは**厳格な型安全性**を重視しています：

- ❌ **`any` 型の使用禁止**: コードの型安全性を保つため、`any` 型の使用は禁止されています
- ❌ **`unknown` 型の使用禁止**: 同様に `unknown` 型も使用せず、適切な型定義を行ってください
- ✅ **適切な型定義**: `src/types/types.ts` にて一元的に型を管理し、インターフェースを活用してください
- ✅ **型インポート**: `import type` を使用して型のみのインポートを明示してください

```typescript
// ❌ 悪い例
function processData(data: any): any {
  return data.someProperty;
}

// ✅ 良い例
import type { Video, VideoUpdateData } from "../types/types";

function processVideo(video: Video): VideoUpdateData {
  return {
    title: video.title,
    rating: video.rating,
  };
}
```

### ESLint 設定

- 未使用の変数・インポート・関数の警告が有効になっています
- 型安全性を確保するためのルールが設定されています
- コミット前には必ず `npm run lint` でチェックしてください

### AI 開発者への注意

AI による開発支援を受ける際は、以下の点にご注意ください：

- `any` や `unknown` 型を提案された場合は、適切な型定義への置き換えを要求してください
- 型定義は `src/types/types.ts` で一元管理されているため、まずこちらを確認してください
- 新しい型が必要な場合は、既存の命名規則に従って追加してください

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
rpm install

# 開発モード (デバッグログ有効)
npm run dev

# TypeScriptコンパイル
npm run build:ts:renderer    # レンダラーのみ
npm run build:ts            # 全てのTypeScript

# ビルド
npm run build:mac    # macOS用
npm run build:win    # Windows用 (注: macOSからのクロスビルドの場合は下記参照)
npm run build:all    # 全プラットフォーム
```

### Windows ビルド（macOS からのクロスビルド）

Windows 版を macOS からビルドする場合、ffmpeg バイナリの前処理が必要です:

```bash
# Windows用ffmpegバイナリを準備
node scripts/prepare-windows-ffmpeg.js

# Windowsビルドを実行
npm run build:win
```

**重要**: このスクリプトは以下を実行します:

- macOS 用 ffmpeg を削除
- Windows PE 形式の ffmpeg をダウンロード
- バイナリ形式を検証（MZ ヘッダーチェック）

### プロジェクト構造

```
movie-library/
├── main.ts              # メインプロセス
├── preload.ts           # プリロードスクリプト
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
│   │   └── PrismaDatabaseManager.ts
│   ├── config/          # 設定ファイル (TypeScript)
│   │   └── optimization.ts
│   ├── utils/           # ユーティリティ
│   │   └── ffmpeg-utils.ts
│   └── types/           # 型定義 (TypeScript)
│       └── types.ts
├── scripts/             # ビルドスクリプト
│   ├── after-pack.js            # ビルド後処理
│   ├── before-build.js          # ビルド前処理
│   └── prepare-windows-ffmpeg.js # Windows用ffmpeg準備
├── prisma/              # Prismaスキーマとマイグレーション
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

### Windows で CPU 使用率が高い

アプリには以下の最適化が組み込まれています:

- サムネイル生成: 2 並列に制限（macOS は 4 並列）
- ffmpeg スレッド: 2 スレッドに制限
- プロセス優先度: BELOW_NORMAL に設定

それでも重い場合:

- 大量の動画を一度にスキャンしない
- フォルダを分けて追加する
- サムネイル生成中は他のアプリを閉じる

### Windows でサムネイル生成が失敗する

ffmpeg バイナリの問題の可能性があります:

- アプリを再インストール
- ウイルス対策ソフトが ffmpeg をブロックしていないか確認
- インストール先パスに特殊文字が含まれていないか確認

### Windows で再インストール後にデータが消える

アプリ名が一貫して`movie-library`に設定されているため、通常はデータが保持されます:

- データ保存先: `C:\Users\<ユーザー名>\AppData\Roaming\movie-library\`
- データベース: `movie-library.db`
- サムネイル: `thumbnails/` フォルダ

アンインストール設定:

- `deleteAppDataOnUninstall: false` - データは削除されません

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
