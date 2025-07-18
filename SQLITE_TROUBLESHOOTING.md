# SQLite3 ビルド時のトラブルシューティング

## 現在のエラーの原因

- SQLite3 のネイティブバイナリが ASAR パッケージから除外されていない
- Universal バイナリでのアーキテクチャ検出の問題

## 適用した修正

1. `asarUnpack`に SQLite3 のバイナリパスを追加
2. 個別アーキテクチャビルド（arm64, x64）に変更
3. `nodeGypRebuild: true`を追加

## 代替手段（必要に応じて）

```json
// より包括的なasarUnpack設定
"asarUnpack": [
    "node_modules/ffmpeg-static/**/*",
    "node_modules/ffprobe-static/**/*",
    "node_modules/sqlite3/**/*.node",
    "node_modules/sqlite3/lib/binding/**/*"
]

// SQLite3を完全にASARから除外
"files": [
    "!**/node_modules/sqlite3/**/*"
],
"extraResources": [
    {
        "from": "node_modules/sqlite3",
        "to": "sqlite3",
        "filter": ["**/*"]
    }
]
```

## 検証方法

1. ビルド後、`dist/mac-arm64/Movie Library.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite3/` にバイナリが存在するかチェック
2. Apple Silicon での動作確認
