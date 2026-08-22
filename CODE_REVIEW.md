# コードレビュー結果（CODE_REVIEW.md）

- レビュー日: 2026-08-22
- 対象: main.ts / preload.ts / src 配下すべて（約 21,000 行）+ ビルド設定・CI
- 検証: `pnpm run lint:check` / `pnpm run type-check` は **いずれもパス**することを確認済み
- 表記: `ファイル:行` は現在の HEAD 時点の位置情報

---

## 1. 総評

全体的な品質は高いです。特に以下の点は評価できます。

- **セキュリティ設計が堅実**: `contextIsolation: true` + `nodeIntegration: false`、renderer への露出は preload の明示的 API のみ。ソートキーは DB 層で許可リスト検証（`src/database/PrismaDatabaseManager.ts:62`）。DOM 構築は `textContent` / `replaceChildren()` 中心で innerHTML 不使用、さらに ESLint で innerHTML を警告するルールも導入済み。
- **クラッシュ回避の知見がコメントとして資産化されている**: EPIPE 対策（`main.ts:30-42`）、Prisma WAL フラッシュ後の `process.exit(0)`（`main.ts:1470-1492`）、macOS GPU スイッチの注意書き（`main.ts:60-67`）など。
- **UX の細部への配慮**: watcher の一時的な unlink 誤検知を 3 秒待って再確認（`main.ts:1245`）、アクセス不能ディレクトリの動画を誤削除しない保護（`VideoScanner.ts:164-178`）、モーダルのフォーカストラップ、IntersectionObserver による仮想スクロール。
- **CI ゲート**: lint + type-check を PR で強制。

一方で、**「preload ↔ 型定義 ↔ main 実装」の整合性崩壊**と**大規模なコピペ重複**が最大の技術的負債になっています。以下、重要度順に示します。

---

## 2. 高優先度（正確性・型整合性の問題）

### 2-1. preload ↔ electron.d.ts ↔ main 実装の型不一致・ファントム API 【最重要】

`src/types/electron.d.ts` はレンダラー全体の型付けの根拠ですが、実際の実装（preload.ts）と大きくズレています。

| 項目 | electron.d.ts（宣言） | preload.ts（実装） |
|---|---|---|
| `loadVideos` / `playVideo` | 宣言あり（`:34-35`） | **実装なし**（呼ぶと実行時エラー） |
| `theme` / `progress` プロパティ | 宣言あり（`:119`, `:122`） | **実装なし** |
| `addDirectory` 戻り値 | `Promise<ElectronDirectory[]>` | `Promise<number>` |
| `removeDirectory` | `Promise<void>` | `Promise<boolean>` |
| `updateVideo` | `(data: Partial<ElectronVideo>) => Promise<void>` | `(id, data: VideoUpdateData) => Promise<boolean>` |
| `regenerateMainThumbnailWithTimestamp` | `videoId: number` | `videoId: string`（main 側で `parseInt`） |

さらに `electron.d.ts:127-143` で `ScanProgress` / `ThumbnailProgress` を types.ts とは**別系統で再定義**しており（types.ts の同名型をシャドウ）、global Window 型はそちらを参照します。現状は「たまたま renderer が不一致箇所を呼んでいない」だけで動いています。

**改善案**:
1. preload.ts の `ElectronAPI` インターフェースを唯一の真実源（Single Source of Truth）にする。
2. `electron.d.ts` は宣言を手書きせず `window.electronAPI = typeof electronAPI` の形で導出する（preload から型を export して参照）。
3. 未実装メンバー（`loadVideos` / `playVideo` / `theme` / `progress`）は削除する。

### 2-2. 存在しない IPC チャネルを呼ぶ API が残っている

- preload `getVideo` → `"get-video"`（`preload.ts:131`）、`searchVideos` → `"search-videos"`（`preload.ts:134`）
- しかし main.ts には対応する `ipcMain.handle` が存在しないため、**呼ぶと必ず reject** します。
- renderer からは未使用のためデッド API ですが、「使えるはずの API が壊れている」状態であり、ハンドラ追加するか preload / 型定義から削除すべきです。
- 関連して `PrismaDatabaseManager.searchVideos`（`:509`）も未使用です。

### 2-3. プログレスイベントの型定義と実際のペイロードが不一致

- `types.ts` の `ScanProgress` / `ThumbnailProgress`（`:160-174`）は `file` と `phase` を**必須**で要求。
- 一方 main.ts は進捗中 `{current, total, message, file}`（phase 無し）や完了時 `{message}` 単独を送信（例: `main.ts:428-433`, `472-474`）。
- そのため renderer は `app.ts:147-301` で実ペイロードを防御的に実行時チェックしており、型がまったく機能していません。

**改善案**: 判別可能ユニオンにする。

```ts
export type ScanProgressEvent =
  | { kind: "progress"; current: number; total: number; file?: string }
  | { kind: "done"; message: string };
```

### 2-4. main.ts のサムネイル一括生成ロジックのコピペ 4 箇所（約 400 行）

以下は BATCH_SIZE + `runConcurrent` + プログレス送信 + エラーハンドリングがほぼ同一のコピペです。

| 箇所 | 行 |
|---|---|
| rescan-all-videos 内の自動生成 | `main.ts:548-619` |
| generate-thumbnails | `main.ts:632-693` |
| regenerate-all-thumbnails | `main.ts:696-759` |
| generate-incomplete-thumbnails（亜種） | `main.ts:762-859` |

main.ts（1,513 行）の 4 分の 1 以上がこの重複です。`generateThumbnailsBatch(videos: ProcessedVideo[], label: string)` のようなプライベートメソッドに抽出すれば 100 行程度に圧縮でき、以後の修正漏れ（片だけ直るバグ）も防げます。

### 2-5. IPC ハンドラが ThumbnailGenerator の既存メソッドを再実装

- `ThumbnailGenerator.regenerateMainThumbnail()`（`ThumbnailGenerator.ts:335-408`）にランダムタイムスタンプ生成（10–90%）込みの同一ロジックが存在するのに、`regenerate-main-thumbnail` ハンドラ（`main.ts:946-987`）と `regenerate-main-thumbnail-with-timestamp`（`main.ts:990-1030`）が同処理を手書きしています。
- generator 側メソッドを使うか、使わないなら削除して一本化してください。

### 2-6. テストが皆無

CI は lint / type-check / build のみです。純粋関数・分離容易なロジックが多いので、まず vitest 導入して下記から始めるのが低コストで効果的です。

- `VideoScanner.parseFps / parseDuration / parseBitrate`（分数形式 "30000/1001" 等）
- `PrismaDatabaseManager.mapVideoRecord`（null→optional 変換・JSON パース）
- `FilterManager`（localStorage を mock してフィルタ永続化）
- `FormatUtils` / `Utils.debounce`
- 重複グルーピング部分を切り出した `DuplicateDetector` の判定ロジック

---

## 3. 中優先度（重複・デッドコード・整合性）

### 3-1. 型の二重定義

| 定義 | 場所 | 問題 |
|---|---|---|
| `ThumbnailSettings` | `types.ts:96-101` と `types.ts:134-145` | 同名 interface の declaration merging が発生し、両者がマージされた意図不明な型になる。片方に統一必須 |
| `DuplicateGroup` | `DuplicateDetector.ts:10-23` と `types.ts:334-337` | 同じ内容を二重管理。types.ts に統一 |
| ロガー実装 | `src/utils/logger.ts` と `src/renderer/Utils.ts:14-45` | ビルド上の制約（コメントに理由記載あり）なので許容範囲だが、同期コメントがあるだけので注意 |

### 3-2. VideoScanner 内の重複と細部

- `comprehensiveScan`（`:115-274`）と `forceRescanAllVideos`（`:634-785`）は「ディレクトリアクセスチェック → ファイル列挙 → 削除検出（scannedDirs 保護含む）」の約 80 行が完全に同一。共通化可能です。
- `getVideoMetadata` 内でインライン `require("child_process")`（`:476`）。他ファイルはトップレベル import なので統一を。
- spawn オプションの `priority: 10`（`:492`）は Node.js の `spawn` に存在しないオプションで**静かに無視されます**（死にコード）。削除か、本当に優度を下げたいなら別手段を検討。

### 3-3. PrismaDatabaseManager のマイグレーション実行の重複

`runPrismaDbPush`（`:181-261`）と `runPrismaMigrateDeploy`（`:263-341`）は引数が違うだけの同一 spawn ラッパーが約 80 行 × 2。`runPrismaCli(args: string[])` に共通化できます。

### 3-4. 起動時ディレクトリ存在チェックの二重実装

- main 側 `startWatchingAllDirectories`（`main.ts:1336-1377`）と renderer 側 `checkDirectoriesExistence`（`app.ts:2609-2685`）が**両方とも**存在しないディレクトリを DB から削除しており、責務が二重です。
- どちらか（main 側推奨：DB 操作だから）に集約してください。

### 3-5. デッドコード一覧（確認のうえ削除推奨）

| コード | 場所 | 備考 |
|---|---|---|
| `cleanupOrphanedThumbnails` | `ThumbnailGenerator.ts:274` | `cleanupThumbnails`（`:425`）とほぼ同機能で未使用 |
| `generateHighQualityThumbnail` | `ThumbnailGenerator.ts:233` | 未使用 |
| `deleteThumbnails` | `ThumbnailGenerator.ts:245` | 未使用 |
| `scanDirectory` | `VideoScanner.ts:82` | `comprehensiveScan` が実質置き換え |
| `formatDuration` / `formatFileSize` | `VideoScanner.ts:611, 623` | scanner 内で未使用 |
| `ProgressBarManager` | `Utils.ts:486` | 未使用クラス |
| 関数版 `formatFileSize` / `formatDuration` | `Utils.ts:1034, 1048` | `FormatUtils` の static 版と重複 |
| `PathUtils` / `AnimationUtils` / `ImageLoader` / `highlightText` / `formatRelativeTime` | `Utils.ts` 各所 | 使用形跡なし（要確認） |
| `searchVideos` / `getVideo` / `handleVideoAdded` | `VideoManager.ts:503, 498, 468` | app.ts は自前実装を使用 |
| コメントアウトされた `toggleViewMode` | `app.ts:2779-2800` | 削除（履歴は Git にある） |
| `MovieLibraryApp.cleanup()` | `app.ts:136-141` | 空実装 |
| `loadTags/loadDirectories` の空 if | `VideoManager.ts:89-91, 108-110` | `forceReload` 引数も実質未使用 |
| `loadVideos` の map 処理 | `VideoManager.ts:67-74` | spread して同値を代入しているだけで実質 no-op |
| `// Event listeners` 重複コメント | `preload.ts:210-211` | 細部 |

補足: `tsconfig.json` の `noUnusedLocals` は export された要素には効かないため、この種の死にコードは ESLint/手動での棚卸しが必要です。

### 3-6. get-tags が常に `count: 0` を返す

`main.ts:365`:

```ts
return tags.map((tag) => ({ name: tag.name, count: 0 }));
```

VideoManager が add/remove 時にローカルでカウントを保守しています（`VideoManager.ts:377-385, 404-412`）が、これは初期化タイミング次第でズレる温床です。DB 側で `videoTag.groupBy({ by: ["tagId"], _count: true })` すれば正確な件数が取れ、ローカル推測ロジックごと削除できます。

### 3-7. レンダラー状態の手動 4 箇所同期

サムネイル更新時に `currentVideo` / `filteredVideos` / `VideoManager` キャッシュ / DOM `<img>` を手動で個別更新しています（`app.ts` の `regenerateMainThumbnail` `:1655-`、`applyCustomThumbnail` `:2187-`、`createThumbnailFromPlayer` `:3219-`）。更新漏れが起きやすい構造なので、`updateVideoCaches(videoId, patch)` のようなヘルパーへ集約するか、単一データストア + 再描画の方式に寄せることを推奨します。

また `VideoManager.hasChanges` はあちこちで set されるのに参照者がほぼおらず、`hasDataChanges` / `hasVideoChanges` / `clearChanges` / `resetDataChanges` という同一フラグへの 4 API が乱立しています（`VideoManager.ts:160-167, 518-526`）。整理を。

### 3-8. 小さなバグ・危険箇所

| 問題 | 場所 | 内容 |
|---|---|---|
| escapeHtml の二重エスケープ | `UIRenderer.ts:1729` | `title.textContent = \`${FormatUtils.escapeHtml(video.title)}...\`` — textContent は HTML 解釈しないため、`&` 含むタイトルが `&amp;` と表示される。escapeHtml を外す |
| `pathToFileUrl` のエンコード不足 | `Utils.ts:590-598` | 空白 / `#` / `?` を含むパスで URL が壊れる。`encodeURI(filePath)` ベース（Windows 区切り変換後）に |
| 無効な spawn オプション | `VideoScanner.ts:492` | 前述 3-2 |
| `parseInt` の NaN チェックなし | `main.ts:994` など | `getVideo(NaN)` が Prisma まで到達する。IPC 入口で数値バリデーションを |
| 非推奨 API | `Utils.ts:867` | `mediaQuery.addListener` → `addEventListener("change", ...)` |
| 誤解されやすい戻り値 | `main.ts:858` | `generate-incomplete-thumbnails` が `{ total: generatedVideos, generated }` を返し total==generated が常に成立。total は走査数であるべき |
| テーマ適用の二重実装 | `app.ts:4271-4296` vs `Utils.ts:876-895` | `applyTheme` が 2 系統あり、class 付与有無など挙動が異なる。ThemeManager に統合 |

### 3-9. パフォーマンス

- **全件取得の乱用**: `db.getVideos()`（全件 + videoTags include）が複数個所で呼ばれます（スキャン、クリーンアップ、起動時監視開始など）。動画数千件規模で毎回重くなるため、パスだけ取る `getVideoPaths()` やカウント専用メソッドの追加を推奨。
- **フィルタ再計算**: `applyFiltersAndSort`（`app.ts:510`）がフィルタ変更のたび全動画走査 + サイドバー全面再描画。`getResolutionOptions` / `getCodecOptions` も描画のたび全走査。動画キャッシュに対して件数を memoize すると軽減できます。
- **O(n) 検索の繰り返し**: `handleVideoListClick` 等での `this.filteredVideos.find(...)` はクリック毎に線形探索。`Map<id, Video>` インデックスで O(1) に。
- **一括タグの N×M 直列 IPC**: `applyQuickBulkTag`（`app.ts:4311`）/ `applyBulkTags`（`:4438-4485`）は動画×タグの回数だけ await 直列発行。数百件で顕著に遅くなるため、main 側に一括付与/解除 API（`createMany` / `deleteMany` ベース）を追加するのが根本対策です。

### 3-10. UI/UX 細部

- `confirm()` / `alert()` を多用（`app.ts:1418, 4111, 4901`、`UIRenderer.showErrorDialog :1576`）。Electron の `window.confirm` は同期ブロックであり、既存のカスタムダイアログ（タグ編集等）と UX も不揃いです。
- スキャンエラー時に `dialog.showErrorBox` へ全詳細文字列を渡す（`main.ts:460-469`）。エラー大量時にダイアログが巨大化するため、件数通知 + 詳細はログ/ファイル出力に分離推奨。

---

## 4. 低優先度（改善の余地）

- `main.ts:107` の `watchers` Map が public。private 化を。
- `localStorage` キーが文字列リテラル散在（`"sortField"` 等）。定数モジュール化で typo 防止。
- ProgressManager 系が 4 クラス（`ProgressManager` / `EnhancedProgressManager` / `UnifiedProgressManager` / `ProgressBarManager`）。互換レイヤーが肥大しているので、移行完了後に統合。
- tsconfig の `paths: {"@/*": ...}` と `experimentalDecorators` / `emitDecoratorMetadata` は使用形跡がなく削除候補。
- `package.json` の build 系スクリプトが毎回 `prisma:generate && build:ts` をフル実行。開発体験向上のため watch + electron-reloader 等の整備余地あり。
- ヘルプメニューが `https://electron.js.org` を開くプレースホルダーのまま（`main.ts:345`）。プロジェクトの repo URL へ。
- About パネルの copyright が © 2025 固定（`main.ts:78`）。
- `styles.css` が 5,517 行。テーマ変数は整理されているので緊急ではないが、コンポーネント単位での分割を検討。
- Prisma schema の `fileHash` カラム（`schema.prisma:32`）が未使用（`partialHash` のみ利用）。将来使わないならカラム削除も。
- `.env` / `movie-library.db` は `.gitignore` 済みであることを確認済み（問題なし）。

---

## 5. 推奨アクション（優先順位）

| # | アクション | 対応セクション | 工数目安 |
|---|---|---|---|
| 1 | electron.d.ts を preload 実装から導出する形に改修し、ファントム API・未実装チャネルを削除 | 2-1, 2-2 | 小〜中 |
| 2 | プログレスイベントを判別可能ユニオン化し、送受信両側を整理 | 2-3 | 小 |
| 3 | main.ts のサムネイル一括生成 4 箇所を共通ヘルパーへ抽出 | 2-4, 2-5 | 中 |
| 4 | vitest 導入 + 純粋関数のユニットテスト | 2-6 | 中 |
| 5 | `ThumbnailSettings` 等の型二重定義を統合 | 3-1 | 小 |
| 6 | escapeHtml 二重エスケープ・pathToFileUrl エンコードの修正 | 3-8 | 小 |
| 7 | デッドコード一括削除 | 3-5 | 小 |
| 8 | get-tags の groupBy 化 + VideoManager カウント保守の廃止 | 3-6 | 小 |
| 9 | 一括タグ用のバッチ IPC 追加 | 3-9 | 中 |
| 10 | VideoScanner / マイグレーション runner の重複解消 | 3-2, 3-3 | 小 |

---

## 6. まとめ

- 即座に直すべきは **型定義の信頼性回復（2-1〜2-3）** と **escapeHtml / pathToFileUrl の小バグ（3-8）**。
- 構造改善の最重点は **main.ts の重複排除（2-4, 2-5）**。ここが直ると main.ts は半分以下になり、以後の保守性が大きく上がります。
- テスト導入（2-6）は上記リファクタリングの安全網として先行して用意する価値があります。
