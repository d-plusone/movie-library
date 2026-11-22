/**
 * 動画エリア: 表示切替・クイック一括タグ・件数表示・段階描画リスト
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { ipc, queryKeys } from "../api/ipc";
import { useIncrementalRender } from "../lib/hooks";
import { useFilters } from "../state/FilterContext";
import { useNotify } from "../state/NotificationContext";
import { useProgress } from "../state/ProgressContext";
import { useUi } from "../state/UiContext";
import { VideoItem, type VideoSelectionGesture } from "./VideoItem";
import type { Video } from "../types";

const GRID_COLUMN_OPTIONS = [3, 6, 9] as const;
type GridColumnCount = (typeof GRID_COLUMN_OPTIONS)[number];

function readGridColumnCount(): GridColumnCount {
  const stored = Number(localStorage.getItem("gridColumns"));
  return GRID_COLUMN_OPTIONS.includes(stored as GridColumnCount)
    ? (stored as GridColumnCount)
    : 3;
}

export interface VideoAreaProps {
  videos: Video[];
  listRef: RefObject<HTMLDivElement | null>;
}

export function VideoArea({ videos, listRef }: VideoAreaProps) {
  const { view, setView } = useFilters();
  const ui = useUi();
  const qc = useQueryClient();
  const { notify } = useNotify();
  const { entries: progressEntries } = useProgress();
  const tagsQuery = useQuery({
    queryKey: queryKeys.tags,
    queryFn: () => ipc().getTags(),
    staleTime: Infinity,
    enabled: ui.selectedVideoIds.size > 0,
  });

  const [quickTagValue, setQuickTagValue] = useState("");
  const [gridColumns, setGridColumns] = useState<GridColumnCount>(readGridColumnCount);
  const [ratingAction, setRatingAction] = useState("");
  const [tagRemovalAction, setTagRemovalAction] = useState("");
  const [watchAction, setWatchAction] = useState("");
  const [thumbnailRegenerating, setThumbnailRegenerating] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [convertingSelected, setConvertingSelected] = useState(false);
  const [draggingVideoId, setDraggingVideoId] = useState<number | null>(null);
  const [dragOverVideoId, setDragOverVideoId] = useState<number | null>(null);
  const selectionAnchorIndexRef = useRef<number | null>(null);
  const applyingRef = useRef(false);
  const repairingThumbnailIdsRef = useRef<Set<number>>(new Set());

  const { count, sentinelRef, ensure } = useIncrementalRender(videos.length);
  const selectedVisibleVideos = ui.selectedVideoOrder
    .map((videoId) => videos.find((video) => video.id === videoId))
    .filter((video): video is Video => video !== undefined);
  const selectedCount = selectedVisibleVideos.length;
  const selectedConversionCandidateVideos = selectedVisibleVideos.filter(
    (video) => video.internalPlayable === false,
  );
  const allVisibleSelected = videos.length > 0 && selectedCount === videos.length;
  const selectedActionBusy =
    ratingAction !== "" ||
    tagRemovalAction !== "" ||
    watchAction !== "" ||
    thumbnailRegenerating ||
    deletingSelected ||
    convertingSelected;
  const tags = tagsQuery.data ?? [];
  const thumbnailProgress = progressEntries.find(
    (entry) => entry.id === "thumbnail-progress" && !entry.completed,
  );

  // 選択範囲は現在の表示対象に限定する（検索・フィルタ変更時の意図しない操作を防ぐ）。
  useEffect(() => {
    ui.retainVideoSelection(videos.map((video) => video.id));
  }, [videos, ui.retainVideoSelection]);

  useEffect(() => {
    if (ui.selectedVideoIds.size === 0) selectionAnchorIndexRef.current = null;
  }, [ui.selectedVideoIds.size]);

  // キーボードナビゲーション用に App 側へ ensure を公開
  useEffect(() => {
    ui.registerEnsure(ensure);
    return () => ui.registerEnsure(null);
  }, [ensure, ui]);

  const applyQuickBulkTag = async (): Promise<void> => {
    if (applyingRef.current) return;
    const raw = quickTagValue.trim();
    if (!raw) {
      notify("タグ名を入力してください", "warning");
      return;
    }
    const tagNames = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tagNames.length === 0) return;
    const targetVideos = selectedCount > 0 ? selectedVisibleVideos : videos;
    if (targetVideos.length === 0) {
      notify("表示中の動画がありません", "warning");
      return;
    }

    applyingRef.current = true;
    try {
      const targetVideoIds = targetVideos.map((video) => video.id);
      const result = await ipc().addTagsToVideos(targetVideoIds, tagNames);
      const addedCount = result.affected;
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
      ]);
      setQuickTagValue("");

      const tagLabel =
        tagNames.length === 1 ? `「${tagNames[0]}」` : `${tagNames.length}個のタグ`;
      notify(
        addedCount > 0
          ? `${addedCount}件のタグ付与を反映しました（対象: ${targetVideos.length}本、${tagLabel}）`
          : `対象動画は既に${tagLabel}を持っています`,
        addedCount > 0 ? "success" : "info",
      );
    } catch (e) {
      console.error("Error applying quick bulk tag:", e);
      notify(
        `タグの付与に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      applyingRef.current = false;
    }
  };

  const toggleVideoSelection = (
    videoId: number,
    index: number,
    gesture: VideoSelectionGesture,
  ): void => {
    const rangeStart = selectionAnchorIndexRef.current;
    if (gesture.shiftKey && rangeStart !== null) {
      const start = Math.min(rangeStart, index);
      const end = Math.max(rangeStart, index);
      const rangeIds = videos.slice(start, end + 1).map((video) => video.id);
      const nextIds = gesture.ctrlKey || gesture.metaKey
        ? [...ui.selectedVideoOrder, ...rangeIds]
        : rangeIds;
      ui.setVideoSelection(nextIds);
    } else {
      ui.toggleVideoSelection(videoId);
    }
    selectionAnchorIndexRef.current = index;
  };

  const removeSelectedTag = async (tagName: string): Promise<void> => {
    setTagRemovalAction(tagName);
    if (tagName.trim() === "" || selectedVisibleVideos.length === 0) {
      setTagRemovalAction("");
      return;
    }

    try {
      const result = await ipc().removeTagsFromVideos(
        selectedVisibleVideos.map((video) => video.id),
        [tagName],
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
      ]);
      notify(
        result.affected > 0
          ? `「${tagName}」を${result.affected}件の動画から削除しました`
          : `選択動画に「${tagName}」は付与されていません`,
        result.affected > 0 ? "success" : "info",
      );
    } catch (e) {
      notify(
        `タグの一括削除に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      setTagRemovalAction("");
    }
  };

  const applyBulkRating = async (rawRating: string): Promise<void> => {
    setRatingAction(rawRating);
    const rating = Number(rawRating);
    const targetVideoIds = selectedVisibleVideos.map((video) => video.id);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5 || targetVideoIds.length === 0) {
      setRatingAction("");
      return;
    }

    try {
      const results = await Promise.allSettled(
        targetVideoIds.map((videoId) => ipc().updateVideo(videoId, { rating })),
      );
      const failed = results.filter(
        (result) => result.status === "rejected" || (result.status === "fulfilled" && !result.value),
      ).length;
      await qc.invalidateQueries({ queryKey: queryKeys.videos });
      if (failed === 0) {
        notify(`${targetVideoIds.length}件の評価を更新しました`, "success");
      } else {
        notify(`${targetVideoIds.length - failed}件更新しました（${failed}件失敗）`, "warning");
      }
    } catch (e) {
      notify(
        `評価の一括更新に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      setRatingAction("");
    }
  };

  const applyBulkWatchStatus = async (rawStatus: string): Promise<void> => {
    setWatchAction(rawStatus);
    if (rawStatus !== "watched" && rawStatus !== "unwatched") {
      setWatchAction("");
      return;
    }
    const targetVideoIds = selectedVisibleVideos.map((video) => video.id);
    if (targetVideoIds.length === 0) {
      setWatchAction("");
      return;
    }

    const watchedAt = rawStatus === "watched" ? new Date() : null;
    try {
      const results = await Promise.allSettled(
        targetVideoIds.map((videoId) =>
          ipc().updateVideo(videoId, { watchedAt, watchPosition: 0 }),
        ),
      );
      const failed = results.filter(
        (result) => result.status === "rejected" || (result.status === "fulfilled" && !result.value),
      ).length;
      await qc.invalidateQueries({ queryKey: queryKeys.videos });
      if (failed === 0) {
        notify(
          rawStatus === "watched"
            ? `${targetVideoIds.length}件を視聴済みにしました`
            : `${targetVideoIds.length}件を未視聴に戻しました`,
          "success",
        );
      } else {
        notify(`${targetVideoIds.length - failed}件更新しました（${failed}件失敗）`, "warning");
      }
    } catch (e) {
      notify(
        `視聴状態の一括変更に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      setWatchAction("");
    }
  };

  const regenerateSelectedThumbnails = async (): Promise<void> => {
    if (selectedVisibleVideos.length === 0 || thumbnailRegenerating) return;
    if (ui.scanLocked) {
      notify("他のスキャン処理が実行中です。完了までお待ちください", "warning");
      return;
    }

    setThumbnailRegenerating(true);
    try {
      await ui.runScanExclusive(async () => {
        await ipc().regenerateThumbnailsForVideos(
          selectedVisibleVideos.map((video) => video.id),
        );
        await qc.invalidateQueries({ queryKey: queryKeys.videos });
      });
    } catch (e) {
      notify(
        `サムネイルの一括再生成に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      setThumbnailRegenerating(false);
    }
  };

  const playSelectedPlaylist = (): void => {
    if (localStorage.getItem("playbackMode") === "external") {
      notify("プレイリスト再生は内蔵プレーヤーでのみ利用できます", "warning");
      return;
    }
    ui.openPlaylist(selectedVisibleVideos.map((video) => video.id));
  };

  const convertSelectedVideos = async (): Promise<void> => {
    const potentialTargets = selectedConversionCandidateVideos;
    if (potentialTargets.length === 0 || convertingSelected) return;
    if (ui.scanLocked) {
      notify("他のスキャン処理が実行中です。完了までお待ちください", "warning");
      return;
    }

    setConvertingSelected(true);
    try {
      // 拡張子・動画コーデックだけでは音声や字幕ストリームまで判定できないため、
      // 実ファイルを ffprobe で確認してから確認ダイアログと変換対象を確定する。
      const checks = await Promise.all(
        potentialTargets.map(async (video) => ({
          video,
          eligibility: await ipc().getMp4ConversionEligibility(video.id),
        })),
      );
      const targets = checks
        .filter(({ eligibility }) => eligibility.convertible)
        .map(({ video }) => video);
      if (targets.length === 0) {
        notify("選択した動画に MP4 変換できるものはありません", "warning");
        return;
      }
      if (
        !window.confirm(
          `選択中の${targets.length}件を別 MP4 に変換しますか？\n\n` +
            "元ファイルは削除も上書きもせず、一覧からだけ除外します。\n" +
            `無劣化: ${checks.filter(({ eligibility }) => eligibility.convertible && eligibility.mode === "remux").length}件 / 高品質変換: ${checks.filter(({ eligibility }) => eligibility.convertible && eligibility.mode === "transcode").length}件\n` +
            "タイトル・評価・説明・タグ・視聴位置・サムネイルを引き継ぎます。",
        )
      ) {
        return;
      }

      await ui.runScanExclusive(async () => {
        const result = await ipc().convertVideosToMp4(targets.map((video) => video.id));
        await qc.invalidateQueries({ queryKey: queryKeys.videos });
        ui.clearVideoSelection();
        const type = result.failed > 0 ? "warning" : "success";
        notify(
          `MP4 変換が完了しました (成功: ${result.succeeded}件 / 失敗: ${result.failed}件)`,
          type,
        );
      });
    } catch (error) {
      notify(
        `一括変換に失敗しました (${error instanceof Error ? error.message : String(error)})`,
        "error",
      );
    } finally {
      setConvertingSelected(false);
    }
  };

  const deleteSelectedVideos = async (): Promise<void> => {
    const targetVideoIds = selectedVisibleVideos.map((video) => video.id);
    if (targetVideoIds.length === 0 || selectedActionBusy) return;
    if (
      !window.confirm(
        `選択した${targetVideoIds.length}件の動画を削除しますか？\n\n動画ファイルはゴミ箱に移動されます。`,
      )
    ) {
      return;
    }

    setDeletingSelected(true);
    try {
      const result = await ipc().deleteLibraryVideos(targetVideoIds, true);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
      ]);
      ui.clearVideoSelection();
      if (result.failed === 0) {
        notify(`${result.success}件の動画をゴミ箱へ移動しました`, "success");
      } else {
        notify(`${result.success}件削除しました（${result.failed}件失敗）`, "warning");
      }
    } catch (e) {
      console.error("Failed to delete selected videos:", e);
      notify(
        `動画の削除に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      setDeletingSelected(false);
    }
  };

  const handleDragStart = (videoId: number): void => {
    setDraggingVideoId(videoId);
    setDragOverVideoId(null);
  };

  const handleDragOver = (videoId: number): void => {
    if (videoId !== draggingVideoId) setDragOverVideoId(videoId);
  };

  const handleDrop = (videoId: number): void => {
    if (draggingVideoId !== null) {
      ui.reorderVideoSelection(draggingVideoId, videoId);
    }
    setDraggingVideoId(null);
    setDragOverVideoId(null);
  };

  const handleDragEnd = (): void => {
    setDraggingVideoId(null);
    setDragOverVideoId(null);
  };

  const repairThumbnailAfterLoadError = useCallback(
    (videoId: number): void => {
      if (repairingThumbnailIdsRef.current.has(videoId)) return;
      repairingThumbnailIdsRef.current.add(videoId);
      void ipc()
        .repairThumbnail(videoId)
        .then(async (repaired) => {
          if (repaired) {
            await qc.invalidateQueries({ queryKey: queryKeys.videos });
          }
        })
        .catch((error) => {
          console.error("Failed to repair thumbnail after image load error:", error);
        })
        .finally(() => {
          repairingThumbnailIdsRef.current.delete(videoId);
        });
    },
    [qc],
  );

  return (
    <section className="video-list-container">
      <div className="video-list-header">
        <div className="video-list-left-controls">
          <div className="view-controls">
            <button
              type="button"
              id="gridViewBtn"
              className={`view-btn${view === "grid" ? " active" : ""}`}
              aria-label="グリッドビュー"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <span className="icon">⊞</span>
            </button>
            <button
              type="button"
              id="listViewBtn"
              className={`view-btn${view === "list" ? " active" : ""}`}
              aria-label="リストビュー"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <span className="icon">☰</span>
            </button>
          </div>
          <button
            type="button"
            id="selectVisibleVideosBtn"
            className="select-visible-btn"
            disabled={videos.length === 0 || deletingSelected}
            onClick={() => {
              ui.setVideoSelection(allVisibleSelected ? [] : videos.map((video) => video.id));
              selectionAnchorIndexRef.current = null;
            }}
          >
            {allVisibleSelected ? "全解除" : "全選択"}
          </button>
        </div>

        <div className="quick-bulk-tag-container">
          <span className="quick-bulk-tag-icon">🏷️</span>
          <input
            type="text"
            id="quickBulkTagInput"
            className="quick-bulk-tag-input"
            placeholder={selectedCount > 0 ? "選択中の動画にタグを付与..." : "表示中の全動画にタグを付与..."}
            aria-label={selectedCount > 0 ? "選択中の動画に付与するタグ" : "表示中の全動画に付与するタグ"}
            value={quickTagValue}
            onChange={(e) => setQuickTagValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void applyQuickBulkTag();
            }}
          />
          <button
            type="button"
            id="quickBulkTagApplyBtn"
            className="quick-bulk-tag-apply-btn"
            title="表示中の全動画にタグを一括付与"
            onClick={() => void applyQuickBulkTag()}
          >
            追加
          </button>
        </div>

        <div className="video-list-summary">
          <span className="video-count" id="videoCount">{videos.length} 動画</span>
          {view === "grid" && (
            <label className="grid-column-control">
              <span>列数</span>
              <select
                id="gridColumnCount"
                aria-label="グリッドの列数"
                value={gridColumns}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (!GRID_COLUMN_OPTIONS.includes(next as GridColumnCount)) return;
                  const nextColumns = next as GridColumnCount;
                  setGridColumns(nextColumns);
                  localStorage.setItem("gridColumns", String(nextColumns));
                }}
              >
                {GRID_COLUMN_OPTIONS.map((columns) => (
                  <option key={columns} value={columns}>
                    {columns}列
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {selectedCount > 0 && (
        <div className="bulk-selection-toolbar" role="toolbar" aria-label="選択した動画の一括操作">
          <span className="bulk-selection-count">{selectedCount}件選択中</span>
          <span className="bulk-selection-hint">選択カードをドラッグして再生順を変更</span>
          <button
            type="button"
            id="selectedPlaylistPlayBtn"
            className="btn btn-small btn-primary"
            disabled={selectedActionBusy}
            onClick={playSelectedPlaylist}
          >
            ▶ プレイリスト再生
          </button>
          <button
            type="button"
            id="selectedRegenerateThumbnailsBtn"
            className="btn btn-small btn-secondary"
            disabled={selectedActionBusy || ui.scanLocked}
            aria-busy={thumbnailRegenerating}
            onClick={() => void regenerateSelectedThumbnails()}
          >
            {thumbnailRegenerating && (
              <span className="progress-spinner" aria-hidden="true" />
            )}
            {thumbnailRegenerating
              ? `サムネイル生成中${thumbnailProgress ? ` (${thumbnailProgress.current}/${thumbnailProgress.total})` : "..."}`
              : "🖼️ サムネイル再生成"}
          </button>
          <button
            type="button"
            id="selectedBulkTagBtn"
            className="btn btn-small btn-secondary"
            disabled={selectedActionBusy}
            onClick={() => ui.setBulkTagOpen(true)}
          >
            🏷️ タグを編集
          </button>
          <label className="bulk-tag-removal-control">
            <span>タグ削除</span>
            <select
              id="selectedBulkTagRemoval"
              aria-label="選択した動画からタグを一括削除"
              value={tagRemovalAction}
              disabled={selectedActionBusy || tags.length === 0}
              onChange={(e) => void removeSelectedTag(e.target.value)}
            >
              <option value="">タグを選択...</option>
              {tags.map((tag) => (
                <option key={tag.name} value={tag.name}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
          <label className="bulk-watch-control">
            <span>視聴状態</span>
            <select
              id="selectedBulkWatchStatus"
              aria-label="選択した動画の視聴状態を一括変更"
              value={watchAction}
              disabled={selectedActionBusy}
              onChange={(e) => void applyBulkWatchStatus(e.target.value)}
            >
              <option value="">一括変更...</option>
              <option value="watched">視聴済みにする</option>
              <option value="unwatched">未視聴に戻す</option>
            </select>
          </label>
          <label className="bulk-rating-control">
            <span>評価</span>
            <select
              id="selectedBulkRating"
              aria-label="選択した動画の評価を一括変更"
              value={ratingAction}
              disabled={selectedActionBusy}
              onChange={(e) => void applyBulkRating(e.target.value)}
            >
              <option value="">一括変更...</option>
              <option value="0">評価なし</option>
              {[1, 2, 3, 4, 5].map((rating) => (
                <option key={rating} value={rating}>
                  {"⭐".repeat(rating)}
                </option>
              ))}
            </select>
          </label>
          {selectedConversionCandidateVideos.length > 0 && (
            <button
              type="button"
              id="selectedVideosConvertToMp4Btn"
              className="btn btn-small btn-success"
              disabled={selectedActionBusy || ui.scanLocked}
              onClick={() => void convertSelectedVideos()}
            >
              {convertingSelected ? "確認・変換中..." : `MP4 に変換 (${selectedConversionCandidateVideos.length})`}
            </button>
          )}
          <button
            type="button"
            id="selectedVideosDeleteBtn"
            className="btn btn-small btn-danger"
            disabled={selectedActionBusy}
            onClick={() => void deleteSelectedVideos()}
          >
            🗑️ 削除
          </button>
          <button
            type="button"
            id="clearSelectedVideosBtn"
            className="btn btn-small btn-secondary"
            disabled={selectedActionBusy}
            onClick={() => ui.clearVideoSelection()}
          >
            選択解除
          </button>
        </div>
      )}

      <div
        id="videoList"
        ref={listRef}
        className={`video-list ${view}-view`}
        data-grid-columns={view === "grid" ? gridColumns : undefined}
        style={
          view === "grid"
            ? { gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }
            : undefined
        }
      >
        {videos.length === 0 ? (
          <div className="no-videos-message">表示する動画がありません</div>
        ) : (
          <>
            {videos.slice(0, count).map((video, index) => (
              <VideoItem
                key={video.id}
                video={video}
                index={index}
                view={view}
                selected={index === ui.selectedIndex}
                bulkSelected={ui.selectedVideoIds.has(video.id)}
                dragging={draggingVideoId === video.id}
                dragOver={dragOverVideoId === video.id}
                onSelect={(selected) => {
                  ui.setSelectedIndex(index);
                  ui.openDetails(selected.id);
                }}
                onToggleBulkSelection={toggleVideoSelection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onPlay={(selected) => ui.openPlayer(selected.id)}
                onThumbnailLoadError={repairThumbnailAfterLoadError}
              />
            ))}
            {count < videos.length && <div ref={sentinelRef} className="virtual-scroll-sentinel" />}
          </>
        )}
      </div>
    </section>
  );
}
