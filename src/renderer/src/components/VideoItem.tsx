/**
 * 動画アイテム（グリッドカード / リスト行）
 * ホバーでチャプターサムネイルを自動巡回する。
 */
import { useEffect, useRef, useState } from "react";
import {
  formatDate,
  formatDuration,
  formatFileSize,
  getFileExtension,
  getResolutionLabel,
  pathToFileUrl,
} from "../lib/format";
import { parseChapters } from "../lib/chapters";
import type { Video } from "../types";

const CYCLE_INTERVAL_MS = 800;

/** サムネイル URL（updatedAt をキャッシュバスターに使う） */
function thumbUrl(video: Video, path: string): string {
  const version = video.updatedAt instanceof Date ? video.updatedAt.getTime() : 0;
  return `${pathToFileUrl(path)}?t=${version}`;
}

export interface VideoItemProps {
  video: Video;
  index: number;
  view: "grid" | "list";
  selected: boolean;
  onSelect: (video: Video, index: number) => void;
  onPlay: (video: Video) => void;
}

export function VideoItem({
  video,
  index,
  view,
  selected,
  onSelect,
  onPlay,
}: VideoItemProps) {
  const isGrid = view === "grid";
  const chapters = parseChapters(video.chapterThumbnails).slice(0, 5);
  const [activeIndex, setActiveIndex] = useState(0);
  const cycleTimer = useRef<number | null>(null);

  const startCycle = (): void => {
    if (chapters.length <= 1) return;
    stopCycle();
    cycleTimer.current = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % (chapters.length + 1));
    }, CYCLE_INTERVAL_MS);
  };
  const stopCycle = (): void => {
    if (cycleTimer.current !== null) {
      window.clearInterval(cycleTimer.current);
      cycleTimer.current = null;
    }
  };

  useEffect(() => stopCycle, []);

  const resolutionLabel = getResolutionLabel(video.width ?? 0, video.height ?? 0);
  const ratingText = "⭐".repeat(video.rating || 0);

  // 表示する画像リスト（0 番はメイン、以降がチャプター）
  const images: Array<{ src: string; label: string }> = [];
  if (video.thumbnailPath) {
    images.push({ src: thumbUrl(video, video.thumbnailPath), label: "メイン" });
  }
  chapters.forEach((chapter, i) => {
    images.push({ src: thumbUrl(video, chapter.path), label: `チャプター ${i + 1}` });
  });

  return (
    <div
      className={`video-item${selected ? " selected" : ""}`}
      data-index={index}
      data-video-id={video.id}
      onClick={() => onSelect(video, index)}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay(video);
      }}
      role="button"
      tabIndex={-1}
    >
      <div
        className="video-thumbnail"
        onMouseEnter={startCycle}
        onMouseLeave={() => {
          stopCycle();
          setActiveIndex(0);
        }}
      >
        {isGrid ? (
          <>
            <div className="thumbnail-cycle">
              {images.map((image, i) => (
                <img
                  key={`${image.label}-${i}`}
                  src={image.src}
                  alt={`${video.title} - ${image.label}`}
                  loading="lazy"
                  className={`thumbnail-image${i === activeIndex ? " active" : ""}`}
                />
              ))}
            </div>
            {images.length > 1 && (
              <div className="thumbnail-indicator">
                {images.map((_, i) => (
                  <div
                    key={i}
                    className={`indicator-dot${i === activeIndex ? " active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveIndex(i);
                      startCycle();
                    }}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          video.thumbnailPath && (
            <img src={thumbUrl(video, video.thumbnailPath)} alt={video.title} loading="lazy" />
          )
        )}

        <div className="video-duration">{formatDuration(video.duration ?? 0)}</div>

        {isGrid && ratingText !== "" && (
          <div className="video-rating-overlay">{ratingText}</div>
        )}
        {resolutionLabel && <div className="video-resolution-badge">{resolutionLabel}</div>}
      </div>

      <div className="video-info">
        <div className="video-title">
          {video.title}
          <span className="video-extension">{getFileExtension(video.filename)}</span>
        </div>
        <div className="video-meta">
          <div className="meta-info">
            <div>サイズ: {formatFileSize(video.size ?? 0)}</div>
            <div>解像度: {video.width ?? 0}x{video.height ?? 0}</div>
            <div>追加日: {formatDate(video.addedAt ?? new Date())}</div>
          </div>
          <div className="video-tags">
            {(video.tags ?? []).slice(0, isGrid ? 3 : undefined).map((tag) => (
              <span key={tag} className="video-tag">
                {tag}
              </span>
            ))}
            {isGrid && (video.tags?.length ?? 0) > 3 && (
              <span className="video-tag-overflow" title={`他のタグ: ${(video.tags ?? []).slice(3).join(", ")}`}>
                +{(video.tags ?? []).length - 3}
              </span>
            )}
          </div>
        </div>
        {!isGrid && ratingText !== "" && <div className="video-rating">{ratingText}</div>}
      </div>
    </div>
  );
}
