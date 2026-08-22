/**
 * チャプターサムネイルビューア（動的オーバーレイ）
 * メインサムネイル + チャプター画像を ←/→ で巡回表示する。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { parseChapters } from "../lib/chapters";
import { formatDuration, pathToFileUrl } from "../lib/format";
import { useFocusTrap } from "../lib/hooks";
import { useUi } from "../state/UiContext";

interface ViewerItem {
  path: string;
  timestamp: number;
  title: string;
}

export function ChapterDialog() {
  const ui = useUi();
  const request = ui.chapterRequest;

  const videosQuery = useQuery({
    queryKey: queryKeys.videos,
    queryFn: () => ipc().getVideos(),
    staleTime: Infinity,
    enabled: request !== null,
  });
  const video =
    request === null
      ? null
      : videosQuery.data?.find((candidate) => candidate.id === request.videoId) ?? null;

  const items: ViewerItem[] = [];
  if (video !== null) {
    if (video.thumbnailPath !== undefined && video.thumbnailPath !== "") {
      items.push({ path: video.thumbnailPath, timestamp: 0, title: "メインサムネイル" });
    }
    parseChapters(video.chapterThumbnails).forEach((chapter, index) => {
      items.push({ path: chapter.path, timestamp: chapter.timestamp, title: `Chapter ${index + 1}` });
    });
  }

  const [index, setIndex] = useState(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(overlayRef, request !== null);

  useEffect(() => {
    if (request === null || items.length === 0) return;
    // request が変化したタイミングでのみ開始位置を初期化する
    setIndex(Math.max(0, Math.min(request.startIndex, items.length - 1)));
  }, [request]);

  const goto = useCallback(
    (next: number) => {
      if (items.length === 0) return;
      setIndex(((next % items.length) + items.length) % items.length);
    },
    [items.length],
  );

  useEffect(() => {
    if (request === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      switch (e.key) {
        case "Escape":
          ui.closeChapter();
          break;
        case "ArrowLeft":
          e.preventDefault();
          goto(index - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          goto(index + 1);
          break;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request, index, goto, ui]);

  if (request === null || video === null || items.length === 0) return null;

  const current = items[Math.max(0, Math.min(index, items.length - 1))];
  const thumbVersion = video.updatedAt instanceof Date ? video.updatedAt.getTime() : 0;

  return (
    <div
      ref={overlayRef}
      className="chapter-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closeChapter();
      }}
    >
      <div id="chapterDialog" className="chapter-dialog" role="dialog" aria-modal="true" aria-label="チャプターサムネイル">
        <div className="chapter-dialog-header">
          <h3>
            {video.title} - {current.title}
          </h3>
          <button
            type="button"
            className="close-chapter-dialog"
            title="閉じる"
            aria-label="チャプターダイアログを閉じる"
            onClick={() => ui.closeChapter()}
          >
            ×
          </button>
        </div>
        <div className="chapter-dialog-content">
          <div className="chapter-viewer">
            <div className="chapter-navigation">
              <button type="button" className="nav-btn prev-btn" title="前のサムネイル (←)" aria-label="前のサムネイル" onClick={() => goto(index - 1)}>
                ‹
              </button>
              <div className="current-chapter">
                <div className="chapter-image-container">
                  <img
                    src={`${pathToFileUrl(current.path)}?t=${thumbVersion}`}
                    alt={current.title}
                  />
                  <div className="chapter-overlay-info">
                    <div className="chapter-counter">{index + 1} / {items.length}</div>
                    <div className="chapter-timestamp">{formatDuration(current.timestamp)}</div>
                  </div>
                </div>
              </div>
              <button type="button" className="nav-btn next-btn" title="次のサムネイル (→)" aria-label="次のサムネイル" onClick={() => goto(index + 1)}>
                ›
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
