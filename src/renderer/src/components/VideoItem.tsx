/**
 * 動画アイテム（グリッドカード / リスト行）。
 * グリッドではポインターの横位置をチャプター画像へ直接対応させる。
 */
import { useRef, useState } from "react";
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

export interface VideoSelectionGesture {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface VideoItemProps {
  video: Video;
  index: number;
  view: "grid" | "list";
  selected: boolean;
  bulkSelected: boolean;
  onSelect: (video: Video, index: number) => void;
  onToggleBulkSelection: (videoId: number, index: number, gesture: VideoSelectionGesture) => void;
  dragging: boolean;
  dragOver: boolean;
  onDragStart: (videoId: number) => void;
  onDragOver: (videoId: number) => void;
  onDrop: (videoId: number) => void;
  onDragEnd: () => void;
  onPlay: (video: Video) => void;
  onThumbnailLoadError: (videoId: number) => void;
}

export function VideoItem({
  video,
  index,
  view,
  selected,
  bulkSelected,
  onSelect,
  onToggleBulkSelection,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPlay,
  onThumbnailLoadError,
}: VideoItemProps) {
  const isGrid = view === "grid";
  const chapters = parseChapters(video.chapterThumbnails).slice(0, 5);
  const [activeIndex, setActiveIndex] = useState(0);
  // 初期描画ではメイン画像だけを読む。チャプター画像はカードに触れた時点で
  // 前後分もまとめて読み、ホバー切り替えの体感を維持する。
  const [loadedIndices, setLoadedIndices] = useState<Set<number>>(
    () => new Set([0]),
  );
  const checkboxGestureRef = useRef<VideoSelectionGesture>({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });
  const resolutionLabel = getResolutionLabel(video.width ?? 0, video.height ?? 0);
  const ratingText = "⭐".repeat(video.rating || 0);
  const internalPlaybackUnavailable = video.internalPlayable === false;

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
    const nextIndex = Math.floor(ratio * images.length);
    setActiveIndex(nextIndex);
    setLoadedIndices((current) => {
      const next = new Set(current);
      next.add(nextIndex);
      next.add((nextIndex + 1) % images.length);
      next.add((nextIndex - 1 + images.length) % images.length);
      return next.size === current.size ? current : next;
    });
  };

  return (
    <div
      className={`video-item${selected ? " selected" : ""}${bulkSelected ? " bulk-selected" : ""}${dragging ? " dragging" : ""}${dragOver ? " drag-over" : ""}`}
      data-index={index}
      data-video-id={video.id}
      aria-selected={bulkSelected}
      draggable={bulkSelected}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onToggleBulkSelection(video.id, index, event);
          return;
        }
        onSelect(video, index);
      }}
      onDragStart={(event) => {
        if (!bulkSelected) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(video.id));
        onDragStart(video.id);
      }}
      onDragOver={(event) => {
        if (!bulkSelected) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver(video.id);
      }}
      onDrop={(event) => {
        if (!bulkSelected) return;
        event.preventDefault();
        onDrop(video.id);
      }}
      onDragEnd={onDragEnd}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay(video);
      }}
      role="button"
      tabIndex={-1}
    >
      <label
        className="video-selection-control"
        onClick={(e) => e.stopPropagation()}
        title="一括操作の対象にする"
      >
        <input
          type="checkbox"
          checked={bulkSelected}
          onClick={(event) => {
            event.stopPropagation();
            checkboxGestureRef.current = {
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
            };
          }}
          onChange={() => {
            onToggleBulkSelection(video.id, index, checkboxGestureRef.current);
          }}
          aria-label={`${video.title}を選択`}
        />
      </label>
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
                    onError={() => onThumbnailLoadError(video.id)}
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
          <img
            src={images[0]!.src}
            alt={video.title}
            loading="lazy"
            onError={() => onThumbnailLoadError(video.id)}
          />
        )}

        <div className="video-duration">{formatDuration(video.duration ?? 0)}</div>
        {internalPlaybackUnavailable && (
          <div
            className="video-playback-unavailable-badge"
            title="内蔵プレーヤーでは直接再生できません。外部プレーヤーを利用するか、無劣化変換できる場合は MP4 に変換してください。"
          >
            ⚠ 内蔵再生不可
          </div>
        )}
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
          {internalPlaybackUnavailable && !isGrid && (
            <span className="video-playback-unavailable-inline">内蔵再生不可</span>
          )}
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
