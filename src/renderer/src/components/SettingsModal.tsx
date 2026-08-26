/**
 * 設定モーダル: 監視フォルダ・外観・フィルタ保存・再生・サムネイル・DB 操作
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import {
  addDirectoriesFlow,
  cleanupThumbnailsOp,
  regenerateAllThumbnailsOp,
  rescanAllFlow,
} from "../api/operations";
import { useFilters } from "../state/FilterContext";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useProgress } from "../state/ProgressContext";
import { useTheme, type Theme } from "../state/ThemeContext";
import { useUi } from "../state/UiContext";

const THUMBNAIL_SIZES = ["1280x720", "854x480", "640x360", "320x180"] as const;

export function SettingsModal() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();
  const { theme, setTheme } = useTheme();
  const filtersState = useFilters();
  const { hasOwners, entries } = useProgress();

  const [playbackMode, setPlaybackMode] = useState<"internal" | "external">("internal");
  const [saveWatchProgress, setSaveWatchProgress] = useState(true);
  const [thumbnailQuality, setThumbnailQuality] = useState("1");
  const [thumbnailSize, setThumbnailSize] = useState<string>("1280x720");
  const [screenshotDir, setScreenshotDir] = useState("");

  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, ui.settingsOpen);

  const directoriesQuery = useQuery({
    queryKey: queryKeys.directories,
    queryFn: () => ipc().getDirectories(),
    staleTime: Infinity,
    enabled: ui.settingsOpen,
  });

  // 開くたびに現在の設定を読み込む
  useEffect(() => {
    if (!ui.settingsOpen) return;
    setPlaybackMode(localStorage.getItem("playbackMode") === "external" ? "external" : "internal");
    setSaveWatchProgress(localStorage.getItem("saveWatchProgress") !== "false");
    setThumbnailQuality(localStorage.getItem("thumbnailQuality") ?? "1");
    setThumbnailSize(localStorage.getItem("thumbnailSize") ?? "1280x720");
    const storedDir = localStorage.getItem("screenshotDir")?.trim() ?? "";
    setScreenshotDir(storedDir !== "" ? storedDir : "~/Pictures");
  }, [ui.settingsOpen]);

  // オーナープログレスが進行中はモーダルを閉じられない（旧挙動）。
  // 「全て再生成」「不要な画像を削除」は thumbnail-progress チャネルを他の処理と
  // 共有しており owner フラグだけでは検出できないため、実際にこれら 4 操作
  // （フォルダ追加・全再スキャン・全再生成・クリーンアップ）すべてをラップしている
  // ui.scanLocked も条件に含めて確実にブロックする。
  const ownerLabels = entries
    .filter((entry) => entry.owner && !entry.completed)
    .map((entry) => entry.label);
  const closeBlocked = ui.scanLocked || hasOwners || ownerLabels.length > 0;

  const deps = { qc, notify };

  const addDirectoryMutation = useMutation({
    mutationFn: async () => {
      await ui.runScanExclusive(async () => {
        await addDirectoriesFlow(deps);
      });
    },
  });

  const rescanAllMutation = useMutation({
    mutationFn: async () => {
      await ui.runScanExclusive(async () => {
        await rescanAllFlow(deps);
      });
    },
  });

  const regenerateAllMutation = useMutation({
    mutationFn: async () => {
      await ui.runScanExclusive(async () => {
        await regenerateAllThumbnailsOp(deps);
      });
    },
  });

  const cleanupMutation = useMutation({
    mutationFn: async () => {
      await ui.runScanExclusive(async () => {
        await cleanupThumbnailsOp(deps);
      });
    },
  });

  const removeDirectoryMutation = useMutation({
    mutationFn: (path: string) => ipc().removeDirectory(path),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.directories }),
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
      ]);
      notify("ディレクトリを削除しました", "success");
    },
    onError: (e) => notify(`ディレクトリの削除に失敗しました (${e.message})`, "error"),
  });

  const selectScreenshotDir = async (): Promise<void> => {
    try {
      const selected = await ipc().selectScreenshotDir();
      if (selected === null) return;
      localStorage.setItem("screenshotDir", selected);
      setScreenshotDir(selected);
      notify(`スクリーンショット保存先: ${selected}`, "success");
    } catch (e) {
      notify(
        `フォルダの選択に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    }
  };

  const saveSettings = (): void => {
    if (closeBlocked) return;
    localStorage.setItem("playbackMode", playbackMode);
    localStorage.setItem("saveWatchProgress", String(saveWatchProgress));
    localStorage.setItem("thumbnailQuality", thumbnailQuality);
    localStorage.setItem("thumbnailSize", thumbnailSize);
    filtersState.setSaveEnabled(filtersState.saveEnabled);

    const quality = parseInt(thumbnailQuality, 10);
    const [widthText, heightText] = thumbnailSize.split("x");
    const width = parseInt(widthText ?? "1280", 10);
    const height = parseInt(heightText ?? "720", 10);
    if (!Number.isNaN(quality) && !Number.isNaN(width) && !Number.isNaN(height)) {
      void ipc()
        .updateThumbnailSettings({ quality, width, height })
        .catch((e: Error) =>
          notify(`サムネイル設定の適用に失敗しました (${e.message})`, "warning"),
        );
    }

    setTheme(theme); // 選択されたテーマを確定
    notify("設定を保存しました", "success");
    ui.setSettingsOpen(false);
  };

  if (!ui.settingsOpen) return null;

  const requestClose = (): void => {
    if (closeBlocked) {
      notify(`処理中のため閉じられません (${ownerLabels.join(", ")})`, "warning");
      return;
    }
    ui.setSettingsOpen(false);
  };

  return (
    <div ref={modalRef} id="settingsModal" className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle">
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="settingsModalTitle">設定</h2>
          <button type="button" id="closeSettingsBtn" className="btn btn-icon" aria-label="設定を閉じる" onClick={requestClose}>
            <span className="icon">✕</span>
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section">
            <h3>監視フォルダ</h3>
            <div id="settingsDirectoriesList" className="settings-directories">
              {(directoriesQuery.data ?? []).map((directory) => (
                <div key={directory.path} className="settings-directory-item">
                  <span className="directory-path" title={directory.path}>{directory.path}</span>
                  <button
                    type="button"
                    className="remove-directory-btn"
                    aria-label={`フォルダ「${directory.path}」を削除`}
                    onClick={() => {
                      if (!window.confirm(`ディレクトリ "${directory.path}" をライブラリから削除しますか？`)) return;
                      void removeDirectoryMutation.mutateAsync(directory.path);
                    }}
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              id="addDirectorySettingsBtn"
              className="btn btn-secondary"
              disabled={ui.scanLocked}
              onClick={() => void addDirectoryMutation.mutateAsync()}
            >
              <span className="icon">📁</span> フォルダを追加
            </button>
          </div>

          <div className="settings-section">
            <h3>外観</h3>
            <div className="setting-item">
              <label htmlFor="themeSelect">テーマ</label>
              <select
                id="themeSelect"
                className="setting-select"
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
              >
                <option value="system">システム設定に従う</option>
                <option value="light">ライトモード</option>
                <option value="dark">ダークモード</option>
              </select>
            </div>
          </div>

          <div className="settings-section">
            <h3>フィルター設定</h3>
            <div className="setting-item">
              <label htmlFor="saveFilterState">
                <input
                  type="checkbox"
                  id="saveFilterState"
                  className="setting-checkbox"
                  checked={filtersState.saveEnabled}
                  onChange={(e) => filtersState.setSaveEnabled(e.target.checked)}
                />
                フィルタリング状態を保存する
              </label>
              <div className="setting-description">
                評価、タグ、フォルダフィルターの状態を次回起動時まで保持します
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3>再生</h3>
            <div className="setting-item">
              <label htmlFor="playbackMode">デフォルトの再生方法</label>
              <select
                id="playbackMode"
                className="setting-select"
                value={playbackMode}
                onChange={(e) => setPlaybackMode(e.target.value as "internal" | "external")}
              >
                <option value="internal">内蔵プレーヤー</option>
                <option value="external">外部プレーヤー</option>
              </select>
              <div className="setting-description">
                動画を再生するときの既定の方法を選択します
              </div>
            </div>
            <div className="setting-item">
              <label htmlFor="saveWatchProgress">
                <input
                  type="checkbox"
                  id="saveWatchProgress"
                  className="setting-checkbox"
                  checked={saveWatchProgress}
                  onChange={(e) => setSaveWatchProgress(e.target.checked)}
                />
                視聴進捗を保存する
              </label>
              <div className="setting-description">
                前回の視聴位置を記憶し、内蔵プレーヤーで続きから再生できます
              </div>
            </div>
            <div className="setting-item">
              <label>スクリーンショット保存先</label>
              <div className="screenshot-dir-row">
                <span id="screenshotDirPath" className="screenshot-dir-path">{screenshotDir}</span>
                <button
                  type="button"
                  id="selectScreenshotDirBtn"
                  className="btn btn-small"
                  onClick={() => void selectScreenshotDir()}
                >
                  フォルダを選択
                </button>
              </div>
              <div className="setting-description">
                内蔵プレーヤーのスクリーンショット保存先です。未設定の場合は「ピクチャ」フォルダに保存します
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3>サムネイル設定</h3>
            <div className="setting-item">
              <label htmlFor="thumbnailQuality">サムネイル品質</label>
              <select
                id="thumbnailQuality"
                className="setting-select"
                value={thumbnailQuality}
                onChange={(e) => setThumbnailQuality(e.target.value)}
              >
                <option value="1">最高品質</option>
                <option value="2">高品質</option>
                <option value="3">標準品質</option>
                <option value="5">低品質</option>
              </select>
            </div>
            <div className="setting-item">
              <label htmlFor="thumbnailSize">サムネイルサイズ</label>
              <select
                id="thumbnailSize"
                className="setting-select"
                value={thumbnailSize}
                onChange={(e) => setThumbnailSize(e.target.value)}
              >
                {THUMBNAIL_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size === "1280x720"
                      ? "HD (1280x720)"
                      : size === "854x480"
                        ? "SD (854x480)"
                        : size === "640x360"
                          ? "小 (640x360)"
                          : "極小 (320x180)"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-section">
            <h3>データベース操作</h3>
            <div className="setting-item">
              <label>スキャン操作</label>
              <div className="setting-description">動画ファイルの情報を再読み込みします</div>
              <button
                type="button"
                id="rescanAllBtn"
                className="btn btn-secondary"
                disabled={ui.scanLocked}
                onClick={() => void rescanAllMutation.mutateAsync()}
              >
                <span className="icon">🔄</span> 全ての動画を再スキャン
              </button>
            </div>
            <div className="setting-item">
              <label>サムネイル操作</label>
              <div className="setting-description">サムネイル画像の生成と管理を行います</div>
              <div className="setting-button-group">
                <button
                  type="button"
                  id="regenerateThumbnailsBtn"
                  className="btn btn-secondary"
                  disabled={ui.scanLocked}
                  onClick={() => void regenerateAllMutation.mutateAsync()}
                >
                  <span className="icon">🖼️</span> 全て再生成
                </button>
                <button
                  type="button"
                  id="cleanupThumbnailsBtn"
                  className="btn btn-secondary"
                  disabled={ui.scanLocked}
                  onClick={() => void cleanupMutation.mutateAsync()}
                >
                  <span className="icon">🗑️</span> 不要な画像を削除
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            id="saveSettingsBtn"
            className="btn btn-success"
            disabled={closeBlocked}
            title={closeBlocked ? "処理が完了するまで保存できません" : undefined}
            onClick={saveSettings}
          >
            <span className="icon">💾</span> 保存
          </button>
          <button
            type="button"
            id="cancelSettingsBtn"
            className="btn btn-secondary"
            disabled={closeBlocked}
            onClick={requestClose}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
