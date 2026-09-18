/**
 * 動画エリア: 表示切替・クイック一括タグ・件数表示・段階描画リスト
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { ipc, queryKeys } from "../api/ipc";
import { useIncrementalRender } from "../lib/hooks";
import { useFilters } from "../state/FilterContext";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";
import { VideoItem } from "./VideoItem";
import type { Video } from "../types";

export interface VideoAreaProps {
  videos: Video[];
  listRef: RefObject<HTMLDivElement | null>;
}

export function VideoArea({ videos, listRef }: VideoAreaProps) {
  const { view, setView } = useFilters();
  const ui = useUi();
  const qc = useQueryClient();
  const { notify } = useNotify();

  const [quickTagValue, setQuickTagValue] = useState("");
  const applyingRef = useRef(false);

  const { count, sentinelRef, ensure } = useIncrementalRender(videos.length);
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
    if (videos.length === 0) {
      notify("表示中の動画がありません", "warning");
      return;
    }

    applyingRef.current = true;
    try {
      const targetVideoIds = videos.map((video) => video.id);
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
          ? `${addedCount}件のタグ付与を反映しました（対象: ${videos.length}本、${tagLabel}）`
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

  return (
    <section className="video-list-container">
      <div className="video-list-header">
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

        <div className="quick-bulk-tag-container">
          <span className="quick-bulk-tag-icon">🏷️</span>
          <input
            type="text"
            id="quickBulkTagInput"
            className="quick-bulk-tag-input"
            placeholder="表示中の全動画にタグを付与..."
            aria-label="表示中の全動画に付与するタグ"
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

        <div className="video-count">
          <span id="videoCount">{videos.length} 動画</span>
        </div>
      </div>

      <div
        id="videoList"
        ref={listRef}
        className={`video-list ${view}-view`}
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
                onSelect={(selected) => {
                  ui.setSelectedIndex(index);
                  ui.openDetails(selected.id);
                }}
                onPlay={(selected) => ui.openPlayer(selected.id)}
              />
            ))}
            {count < videos.length && <div ref={sentinelRef} className="virtual-scroll-sentinel" />}
          </>
        )}
      </div>
    </section>
  );
}
