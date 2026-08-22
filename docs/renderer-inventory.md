# Renderer 機能インベントリ（React 移行用）

Vite + React への書き直し時に機能を抜けなく移植するための現行挙動の一覧。
移行完了までこのドキュメントをチェックリストとして使う。

- 作成日: 2026-08-23（Phase 0 完了時点のコードベース基準）
- 「→ React 化で解消」欄は、現行実装の負債が新アーキテクチャで自然になくなるかどうか

> **移行ステータス**: Phase 2 で React 実装済み（`src/renderer/src/`）。
> 未移植・簡略化した項目: フォーカストラップ、`hasVideoUpdates` 差分ポーリング、
> 一括タグのバッチ API 化（現状は逐次 IPC）、`confirm()` のカスタムダイアログ化。

---

## 1. データフロー

```
main.ts (IPC handlers) ⇄ preload.ts (window.electronAPI) ⇄ renderer
                            ↑ 型契約: src/types/electron-api.ts (ElectronAPI)
                              イベント: ProgressEvent (kind: "progress" | "done")
```

- renderer は DB を直接触らず、すべて IPC 経由。
- 動画キャッシュは `VideoManager`（配列 + `hasChanges` フラグ）が保持。
  → React 化で解消: TanStack Query 等のサーバ状態管理に一本化。

## 2. 画面構成（index.html のモーダル群）

| 領域 / モーダル ID | 内容 |
|---|---|
| `videoList` | グリッド / リスト表示切替 |
| sidebar | タグ・フォルダ・解像度・コーデックフィルタ、統計 |
| `settingsModal` | サムネイル品質/サイズ、テーマ、フィルタ保存、再生方法、視聴進捗 |
| detailsPanel | 動画詳細（タイトル/説明/評価/タグ/サムネイル操作） |
| `videoPlayerModal` | 内蔵プレーヤー |
| `customThumbnailDialog` | シークバー + プレビューでカスタムサムネイル作成 |
| chapter dialog（動的生成） | メイン + チャプター画像のブラウザ |
| `bulkTagApplyDialog` | 動画×タグのマトリクスで一括タグ編集 |
| `duplicateModal` | 重複検出結果と削除 |
| tagEditDialog（動的生成） | タグ名変更 |
| `unifiedProgressModal`（動的生成） | 複数進捗の統合表示 |

## 3. 動画一覧

- **仮想スクロール**: IntersectionObserver + sentinel で 50 件ずつ追描画（`UIRenderer.renderUntil`）。キーボード移動で未描画 index に来た場合は `ensureIndexRendered` で即描画。
- **グリッドビュー**: ホバーでメイン+チャプター画像を 800ms 間隔で自動巡回、インジケータドットで手動切替。
- **リストビュー**: 単一サムネイル、タグ全件表示。グリッドはタグ先頭 3 件 + `+n` オーバーフロー表示。
- ダブルクリックで再生、クリックで詳細表示。ボタン: 再生 / 詳細 / サムネイル再生成。
- サムネイル URL には `?t=<updatedAt>` キャッシュバスター付き。

## 4. フィルタ / ソート / 検索

- フィルタ種別: 評価（以上）、タグ（OR）、ディレクトリ（OR、サブフォルダ含む・パス境界正確判定）、解像度（ラベルは長辺基準: 4K/1440p/1080p/720p/SD）、コーデック、検索クエリ（title/filename/description/tags 部分・大文字小文字無視）。
- ディレクトリフィルタ: 利用可能ディレクトリが存在する限り常に適用。全解除状態では 0 件表示。
- ソート: filename/title/addedAt/updatedAt/rating/duration/size/createdAt/modifiedAt × ASC/DESC。null 先頭（ASC 時）。Date/bigint/number/string を型別比較。
- 検索入力は 200ms デバウンス。
- **永続化**: 下記 localStorage キー参照。フィルタ状態保存 ON 時のみ復元。
- 解像度・コーデックの選択肢は全動画から件数集計し、0 件バケットは非表示 / コーデックは件数降順。

### localStorage キー一覧

| キー | 内容 |
|---|---|
| `sortField` / `sortOrder` | ソート状態 |
| `filterState` | rating, tags, selectedDirectories, resolutions, codecs |
| `searchQuery` | 検索語（フィルタ保存 ON 時） |
| `availableDirectories` | フィルタ用ディレクトリ一覧 |
| `saveFilterState` | フィルタ永続化の ON/OFF |
| `theme` | light / dark / system |
| `viewMode` | grid / list |
| `playbackMode` | internal / external |
| `saveWatchProgress` | 視聴進捗保存 ON/OFF |
| `screenshotDir` | スクリーンショット保存先 |
| `sidebarCollapsed` | サイドバー開閉 |

## 5. 詳細パネル

- 同一動画の再描画スキップ。Esc で閉じる。
- タイトル・説明の保存、評価 1–5（星ホバー/キーボード対応、クリアボタン）、タグ追加（スペース区切りで複数）/削除。
- メインサムネイル: 再生成（ランダム位置）/ カスタム作成ダイアログ / クリックでチャプターダイアログ。
- ローカルデータ（currentVideo / filteredVideos / VideoManager キャッシュ / DOM img）を 4 箇所手動同期。
  → React 化で解消: 単一ストア更新 + 自動再描画へ。

## 6. 内蔵プレーヤー

- 再生方式: 設定が `external` なら `shell.openPath` で外部再生、既定は内蔵。
- ソースは `file://` 直読み。`backgroundThrottling: false`（main 側 webPreferences）。
- **キーボード**（キャプチャフェーズで KeyboardManager より優先）:
  - Space: 再生/一時停止（keyup も握ってボタン誤発火を防止）
  - ←/→: ±5 秒、Shift+←/→: ±1 秒、Option(Alt)+←/→: フレーム送り（DB の fps、不明時 30fps）
  - ↑/↓: 音量 ±10%
  - Cmd/Ctrl+S: スクリーンショット保存（PNG、ffmpeg -ss 前置きで高速シーク）
- 開閉時に video 要素へフォーカスを戻す（スペースキーのボタン消費防止）。モーダル表示時も focus trap が video に初期フォーカス。
- **視聴進捗**: timeupdate ごとに 5 秒差分で `watchPosition` 保存、ended で 0 リセット、閉じる際に最終位置保存。95% 以上視聴済みなら次回先頭から。保存は設定 OFF なら一切行わない。
- エラー時「コーデック非対応の可能性」通知。

## 7. カスタムサムネイルダイアログ

- シークバー（step 0.1s）+ メインプレビュー + ホバーツールチッププレビュー。
- プレビューは 0.1 秒単位のキャッシュ（Map）。マウス移動は 150ms、変更確定は 300ms デバウンス（キーボード操作は即時）。
- ダイアログ全体で ←/→ を捕捉してシークバーへ転送。
- 閉じる際に全リスナー・タイマー・キャッシュを解放（リーク対策済み）。
- → React 化で解消: 手動リスナー管理が不要になる。

## 8. チャプターダイアログ

- メインサムネイル + チャプター画像を 1 枚ビューアで巡回（←/→ ラップ、Esc で閉じる）。
- chapterThumbnails は配列 / JSON 文字列 / オブジェクトの 3 形態に耐性のあるパース。
- 表示中動画の updatedAt をキャッシュバスターに使用。

## 9. 一括タグ

- ダイアログ: 表示中動画×タグのチェックボックス表。列ヘッダーの select-all（indeterminate 対応）、タグ名フィルタ。
- クイック入力: スペース/カンマ区切りで表示中の全動画へ付与（既存保持分はスキップ）。
- 変更差分だけ確認ダイアログ → 適用（成功/失敗件数を通知）。
- 注意: 現行は動画×タグの回数だけ直列 IPC。大量件数で遅い（Phase 2 でバッチ API 化推奨）。

## 10. 重複検出

- main 側: size+duration+partialHash（先頭/中間/末尾 64KB の MD5）でグルーピング。ハッシュ未計算分は事前計算。
- UI: 解像度降順ソート、先頭を「推奨: 保持」、最低 1 件残す自動ガード（全チェックを防ぐ）、ゴミ箱へ移動削除。
- 進捗は `onDuplicateSearchProgress` / `onDeleteProgress`。

## 11. ディレクトリ管理と監視

- 追加: 複数選択可 → 登録 → 自動スキャン → 新規/更新があればサムネイル自動生成。
- 削除: confirm 後 DB から削除 + watcher 停止。
- 起動時: 存在しないディレクトリは DB から自動除外し通知（renderer のチェック + main の watcher 開始前チェック）。
- chokidar 監視（dotfile 除外）:
  - add → processFile → `video-added` イベント → renderer が 1 秒待機後に再読込（ファイル書き込み安定待ち）
  - unlink/unlinkDir → 3 秒待って実在再確認後 DB 削除（外付けドライブ誤検知対策）→ `video-removed` / `directory-removed`
- スキャン: アクセス不能ディレクトリはスキップし、その配下の動画は削除対象にしない保護あり。

## 12. スキャン / サムネイル生成とプログレス

- main → renderer への進捗は型付き `ProgressEvent`（`kind: "progress" | "done"`）を `sendProgress` ヘルパー経由で送信。
- renderer は `applyProgressEvent` で統一モーダルへ反映:
  - 通常進捗 vs オーナープログレス（`settings-rescan-all`, `settings-thumbnail-regen`, `settings-thumbnail-cleanup`）— オーナープログレスが残る間はモーダルを閉じない。
  - thumbnail-progress は `settings-thumbnail-regen` 進行中ならそちらを優先。
  - done イベント時にプログレス未登録なら一時生成して即完了扱い。
- 起動時: 不完全サムネイル（ファイル欠損・チャプター全欠損）をバックグラウンド補完。
- 同時実行ガード: スキャン系操作は `isScanOperationInProgress` で排他、ボタン無効化。

## 13. 通知 / テーマ / アクセシビリティ

- 通知: 右上トースト最大 3 枚、同メッセージ 1 秒内の重複抑制、5 秒自動消滅、手動閉じ。
- テーマ: light/dark/system。system は `prefers-color-scheme` 追従 + プレースホルダー色の動的調整。`data-theme` 属性 + CSS 変数で実装。
  - 注意: `ThemeManager.applyTheme` と app.ts 側 `applyTheme` の二重実装が残っている（class 付与有無が不一致）。React 移行時は ThemeManager に統一。
- フォーカストラップ: Tab 循環 + モーダル開封時の初期フォーカス（プレーヤーは video 要素優先）。aria-pressed / aria-label 付与済み。
- production ビルドでは logger が debug/log/info を抑制（`isProduction` は preload 経由で取得）。

## 14. React 移行時に自然解消される項目

| 現行の負債 | 解決手段 |
|---|---|
| 4 箇所への手動 state 同期（§5） | 単一ストア + 派生描画 |
| ProgressManager 4 クラス乱立 | 進捗を state として 1 コンポーネントで描画 |
| 動的 DOM 生成とリスナー手動解放（§7, §8, tagEdit） | コンポーネントライフサイクルに委譲 |
| renderer 用ロガーの二重定義 | 1 ファイルに統合可能 |
| `confirm()` / `alert()` の同期ブロック | カスタムダイアログコンポーネントへ |
| escapeHtml 二重エスケープ・pathToFileUrl のエンコード不足 | URL 生成ユーティリティを 1 箇所に集約して修正 |

## 15. 移行時の要注意（壊しやすい暗黙知）

1. プレーヤーの keyup 抑制なしに Space を実装するとボタン再発火バグが再来する（§6）。
2. 視聴進捗の 5 秒間隔保存・95% リセット仕様（§6）。
3. ディレクトリフィルタのパス境界判定（前方一致のみだと `dir2` が `/dir` に誤マッチ）（§4）。
4. サムネイルのキャッシュバスター必須（同パス上書きのため）（§3, §8）。
5. オーナープログレスの生存期間ルール（§12）。設定モーダルを閉じるタイミングと連動。
6. watcher の 3 秒再確認・1 秒書き込み待ち（§11）。即時反映にすると一時的 unlink でデータが消える。
7. `chapterThumbnails` の 3 形態耐性パース（旧 DB 互換）（§8）。
