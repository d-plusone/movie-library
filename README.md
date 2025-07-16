# Movie Library

Mac/Electronベースの動画管理アプリケーション。直感的なUI/UXで動画ファイルの整理、サムネイル表示、評価管理などができます。

## 🎬 機能

### 基本機能
- 📁 **フォルダ監視**: 指定したフォルダ内の動画ファイルを自動スキャン
- 🖼️ **サムネイル生成**: FFmpegを使用した高品質なサムネイル自動生成
- 🔍 **検索・フィルタ**: タイトル、タグ、評価による動画検索
- ⭐ **評価システム**: 5段階評価とタグ付け機能
- 🎯 **詳細管理**: タイトル、説明、タグの編集

### UI/UX機能
- 🎭 **ダークテーマ対応**: システム設定に従った自動切り替え
- 📱 **レスポンシブレイアウト**: グリッド/リスト表示の切り替え
- ⌨️ **キーボードナビゲーション**: 矢印キーによる直感的な操作
- 🔄 **サムネイル再生成**: ランダム位置でのメインサムネイル更新
- 📢 **通知システム**: 操作結果のリアルタイム表示

### 技術仕様
- **プラットフォーム**: macOS (Intel + Apple Silicon), Windows
- **フレームワーク**: Electron 27
- **データベース**: SQLite3
- **動画処理**: FFmpeg
- **サポート形式**: MP4, AVI, MOV, MKV, WMV, FLV など

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

### 基本操作
- **グリッド/リスト表示切り替え**: 右上のビューボタン
- **検索**: 右上の検索バーに入力
- **評価フィルタ**: 左サイドバーの星ボタン
- **詳細表示**: 動画をクリック
- **再生**: Enterキーまたは「再生」ボタン

### キーボードショートカット
- `↑↓←→`: 動画選択 (グリッド: 2次元, リスト: 1次元)
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
│   ├── renderer/        # レンダラープロセス
│   │   ├── app.js       # アプリケーションロジック
│   │   ├── styles.css   # スタイルシート
│   │   └── index.html   # UI構造
│   └── thumbnail/       # サムネイル生成
│       └── ThumbnailGenerator.js
├── database/            # データベース関連
└── .github/workflows/   # CI/CDワークフロー
```

## 🔄 リリース

GitHubでの自動リリースが設定されています:

```bash
# バージョンアップ
npm version patch  # or minor, major

# タグをプッシュ（自動ビルド開始）
git push origin --tags
```

詳細は [RELEASE.md](RELEASE.md) を参照してください。

## 🐛 トラブルシューティング

### アーキテクチャエラー (ARM64/Intel)
```bash
# エラー例: mach-o file, but is an incompatible architecture
# 解決方法: 依存関係を完全に再インストール
rm -rf node_modules package-lock.json
npm install
npm rebuild sqlite3
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
- FFmpegが正しくインストールされているか確認
- 動画ファイルの形式がサポートされているか確認
- ファイルパスに特殊文字が含まれていないか確認

### データベースエラー
- アプリを完全に終了して再起動
- `movie-library.db` ファイルを削除（データは失われます）

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
