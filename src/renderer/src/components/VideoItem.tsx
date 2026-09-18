/**
 * 動画アイテム（グリッドカード / リスト行）。
 * グリッドではポインターの横位置をチャプター画像へ直接対応させる。
 */
import { useState } from "react";
import {
  formatDate,
  formatDuration,
  formatFileSize,
  getFileExtension,
  getResolutionLabel,
} from "../lib/format";
import { parseChapters } from "../lib/chapters";
import { PLACEHOLDER_THUMBNAIL, thumbnailUrl } from "../lib/thumbnails";
import type { Video } from "../types";

export interface VideoItemProps {
  video: Video;
  index: number;
  view: "grid" | "list";
  selected: boolean;
  onSelect: (video: Video, index: number) => void;
  onPlay: (video: Video) => void;
}

export function VideoItem({ video, index, view, selected, onSelect, onPlay }: VideoItemProps) {
  const isGrid = view === "grid";
  const chapters = parseChapters(video.chapterThumbnails).slice(0, 5);
  const [activeIndex, setActiveIndex] = useState(0);
  const resolutionLabel = getResolutionLabel(video.width ?? 0, video.height ?? 0);
  const ratingText = "⭐".repeat(video.rating || 0);

  const images: Array<{ src: string; label: string }> = [
    {
      src: video.thumbnailPath ? thumbnailUrl(video, video.thumbnailPath) : PLACEHOLDER_THUMBNAIL,
      label: video.thumbnailPath ? "メイン" : "サムネイル生成中",
    },
    ...chapters.map((chapter, chapterIndex) => ({
      src: thumbnailUrl(video, chapter.path),
      label: `チャプター ${chapterIndex + 1}`,
    })),
  ];

  const updateActiveFromPointer = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!isGrid || images.length <= 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(0.999999, Math.max(0, (event.clientX - rect.left) / rect.width));
    setActiveIndex(Math.floor(ratio * images.length));
  };

  const loadedIndices = new Set<number>([
    activeIndex,
    (activeIndex + 1) % images.length,
    (activeIndex - 1 + images.length) % images.length,
  ]);

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
        className={`video-thumbnail${!video.thumbnailPath ? " thumbnail-skeleton" : ""}`}
        onMouseEnter={updateActiveFromPointer}
        onMouseMove={updateActiveFromPointer}
        onMouseLeave={() => setActiveIndex(0)}
      >
        {isGrid ? (
          <>
            <div className="thumbnail-cycle">
              {images.map((image, imageIndex) =>
                loadedIndices.has(imageIndex) ? (
                  <img
                    key={`${image.label}-${imageIndex}`}
                    src={image.src}
                    alt={`${video.title} - ${image.label}`}
                    loading="lazy"
                    className={`thumbnail-image${imageIndex === activeIndex ? " active" : ""}`}
                  />
                ) : null,
              )}
            </div>
            {images.length > 1 && (
              <div className="thumbnail-indicator" aria-label="チャプター位置">
                {images.map((image, imageIndex) => (
                  <div
                    key={imageIndex}
                    className={`indicator-dot${imageIndex === activeIndex ? " active" : ""}`}
                    title={image.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveIndex(imageIndex);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <img src={images[0]!.src} alt={video.title} loading="lazy" />
        )}

        <div className="video-duration">{formatDuration(video.duration ?? 0)}</div>
        {isGrid && ratingText !== "" && <div className="video-rating-overlay">{ratingText}</div>}
        {resolutionLabel && <div className="video-resolution-badge">{resolutionLabel}</div>}
        {(video.watchPosition ?? 0) > 0 && (video.duration ?? 0) > 0 && (
          <div
            className="video-watch-progress"
            style={{ width: `${Math.min(100, ((video.watchPosition ?? 0) / video.duration) * 100)}%` }}
            aria-label="視聴済み進捗"
          />
        )}
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
              <span key={tag} className="video-tag">{tag}</span>
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
