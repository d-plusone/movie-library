/**
 * 動画詳細パネル: タイトル/説明/評価/タグ編集、サムネイル操作、ファイル情報
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { parseChapters } from "../lib/chapters";
import {
  formatDuration,
  formatFileSize,
  formatFps,
  pathToFileUrl,
} from "../lib/format";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";
import type { Video } from "../types";

const PLACEHOLDER_THUMBNAIL =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";

function thumbUrl(video: Video, path: string): string {
  const version = video.updatedAt instanceof Date ? video.updatedAt.getTime() : 0;
  return `${pathToFileUrl(path)}?t=${version}`;
}

export function DetailsPanel() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();

  const videosQuery = useQuery({
    queryKey: queryKeys.videos,
    queryFn: () => ipc().getVideos(),
    staleTime: Infinity,
    enabled: ui.detailsVideoId !== null,
  });
  const tagsQuery = useQuery({
    queryKey: queryKeys.tags,
    queryFn: () => ipc().getTags(),
    staleTime: Infinity,
  });

  const video =
    videosQuery.data?.find((candidate) => candidate.id === ui.detailsVideoId) ?? null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [hoverRating, setHoverRating] = useState(0);

  // 表示対象が切り替わったら入力欄を同期する
  // video.id のみを依存にする: video オブジェクトはクエリ再取得ごとに新しい参照になるため、
  // 参照を依存にすると編集中の未保存内容が背後の再取得で上書きされてしまう
  useEffect(() => {
    if (!video) return;
    setTitle(video.title);
    setDescription(video.description ?? "");
    setTagInput("");
  }, [video?.id]);

  async function invalidateVideos(): Promise<void> {
    await qc.invalidateQueries({ queryKey: queryKeys.videos });
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      ipc().updateVideo(video?.id ?? 0, { title, description }),
    onSuccess: async () => {
      await invalidateVideos();
      notify("動画情報を更新しました", "success");
    },
    onError: (e) => notify(`動画情報の更新に失敗しました (${e.message})`, "error"),
  });

  const ratingMutation = useMutation({
    mutationFn: (rating: number) => ipc().updateVideo(video?.id ?? 0, { rating }),
    onSuccess: async (_result, rating) => {
      await invalidateVideos();
      notify(
        rating === 0 ? "評価を削除しました" : `評価を${rating}に設定しました`,
        "success",
      );
    },
    onError: (e) => notify(`評価の設定に失敗しました (${e.message})`, "error"),
  });

  const regenerateThumbMutation = useMutation({
    mutationFn: (videoId: number) => ipc().regenerateMainThumbnail(videoId),
    onSuccess: async () => {
      await invalidateVideos();
      notify("メインサムネイルを再生成しました", "success");
    },
    onError: (e) => notify(`サムネイル再生成に失敗しました (${e.message})`, "error"),
  });

  const addTagsMutation = useMutation({
    mutationFn: async (tagNames: string[]) => {
      if (!video) return;
      for (const tagName of tagNames) {
        await ipc().addTagToVideo(video.id, tagName);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
      ]);
      setTagInput("");
    },
    onError: (e) => notify(`タグの追加に失敗しました (${e.message})`, "error"),
  });

  const removeTagMutation = useMutation({
    mutationFn: (tagName: string) => ipc().removeTagFromVideo(video?.id ?? 0, tagName),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
      ]);
    },
    onError: (e) => notify(`タグの削除に失敗しました (${e.message})`, "error"),
  });

  if (ui.detailsVideoId === null || !video) {
    return <aside id="detailsPanel" className="details-panel" style={{ display: "none" }} />;
  }

  const chapters = parseChapters(video.chapterThumbnails).slice(0, 5);
  const displayedRating = hoverRating > 0 ? hoverRating : (video.rating || 0);

  const submitTags = (): void => {
    const tagNames = tagInput
      .split(/\s+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    if (tagNames.length === 0) {
      notify("タグ名を入力してください", "warning");
      return;
    }
    void addTagsMutation.mutateAsync(tagNames);
  };

  return (
    <aside id="detailsPanel" className="details-panel" role="complementary" aria-label="動画詳細">
      <div className="details-header">
        <h3 id="detailsTitle">動画詳細</h3>
        <button
          type="button"
          id="closeDetailsBtn"
          className="btn btn-icon"
          aria-label="詳細を閉じる"
          onClick={() => ui.closeDetails()}
        >
          <span className="icon">✕</span>
        </button>
      </div>

      <div className="details-content">
        <div className="details-thumbnails">
          <div className="main-thumbnail">
            <img
              id="detailsMainThumbnail"
              src={video.thumbnailPath ? thumbUrl(video, video.thumbnailPath) : PLACEHOLDER_THUMBNAIL}
              alt={video.title}
              onClick={() => ui.openChapter({ videoId: video.id, startIndex: 0 })}
            />
            <div className="thumbnail-actions">
              <button
                type="button"
                id="refreshMainThumbnailBtn"
                className="refresh-thumbnail-btn"
                title="メインサムネイルを更新"
                aria-label="メインサムネイルを更新"
                disabled={regenerateThumbMutation.isPending}
                onClick={() => void regenerateThumbMutation.mutateAsync(video.id)}
              >
                <span className="icon">🔄</span>
              </button>
              <button
                type="button"
                id="customThumbnailBtn"
                className="custom-thumbnail-btn"
                title="指定箇所から生成"
                aria-label="指定位置からサムネイルを生成"
                onClick={() => ui.openCustomThumb(video.id)}
              >
                <span className="icon">🎯</span>
              </button>
            </div>
          </div>
          <div className="chapter-thumbnails">
            <div id="detailsChapterThumbnails" className="chapter-grid">
              {chapters.map((chapter, index) => (
                <div
                  key={`${chapter.path}-${index}`}
                  className="chapter-thumbnail"
                  data-timestamp={chapter.timestamp}
                  onClick={() => ui.openChapter({ videoId: video.id, startIndex: index + 1 })}
                >
                  <img src={thumbUrl(video, chapter.path)} alt={`Chapter ${index + 1}`} loading="lazy" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="details-info">
          <div className="info-group">
            <label>タイトル</label>
            <input
              type="text"
              id="detailsTitleInput"
              className="details-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="info-group">
            <label>評価</label>
            <div className="rating-input">
              {/* CSS の .clear-rating-btn はデフォルト display:none のため、
                  評価がある場合のみインラインで表示する（旧実装と同じ挙動） */}
              <button
                type="button"
                className="clear-rating-btn"
                style={{ display: (video.rating || 0) > 0 ? "inline-block" : "none" }}
                title="評価を削除"
                aria-label="評価を削除"
                onClick={() => void ratingMutation.mutateAsync(0)}
              >
                ×
              </button>
              {[1, 2, 3, 4, 5].map((value) => (
                <span
                  key={value}
                  className={`star${value <= displayedRating ? " active" : ""}`}
                  data-rating={value}
                  role="button"
                  tabIndex={0}
                  aria-label={`評価を${value}にする`}
                  aria-pressed={value <= (video.rating || 0) ? "true" : "false"}
                  onClick={() => void ratingMutation.mutateAsync(value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void ratingMutation.mutateAsync(value);
                    }
                  }}
                  onMouseEnter={() => setHoverRating(value)}
                  onMouseLeave={() => setHoverRating(0)}
                >
                  {value <= displayedRating ? "⭐" : "☆"}
                </span>
              ))}
            </div>
          </div>

          <div className="info-group">
            <label>説明</label>
            <textarea
              id="detailsDescriptionInput"
              className="details-textarea"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="info-group">
            <label>タグ</label>
            <div className="tags-input-container">
              <input
                type="text"
                id="tagInput"
                className="tag-input"
                placeholder="タグを追加してEnterキーを押してください (スペース区切りで複数入力可)..."
                list="tagSuggestions"
                aria-label="タグを追加"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitTags();
                  }
                }}
              />
              <datalist id="tagSuggestions">
                {(tagsQuery.data ?? []).map((tag) => (
                  <option key={tag.name} value={tag.name} />
                ))}
              </datalist>
              <div id="detailsTagsList" className="details-tags">
                {(video.tags ?? []).map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                    <button
                      type="button"
                      className="remove-tag"
                      title="タグを削除"
                      aria-label={`タグ「${tag}」を削除`}
                      onClick={() => void removeTagMutation.mutateAsync(tag)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="info-group">
            <label>ファイル情報</label>
            <div className="file-info">
              <div className="info-row">
                <span className="info-label">ファイルパス:</span>
                <span id="detailsFilePath" className="info-value">{video.path}</span>
              </div>
              <div className="info-row">
                <span className="info-label">ファイルサイズ:</span>
                <span id="detailsFileSize" className="info-value">{formatFileSize(video.size ?? 0)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">再生時間:</span>
                <span id="detailsDuration" className="info-value">{formatDuration(video.duration ?? 0)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">解像度:</span>
                <span id="detailsResolution" className="info-value">{video.width ?? 0}x{video.height ?? 0}</span>
              </div>
              <div className="info-row">
                <span className="info-label">フレームレート:</span>
                <span id="detailsFps" className="info-value">{formatFps(video.fps ?? 0)} fps</span>
              </div>
              <div className="info-row">
                <span className="info-label">コーデック:</span>
                <span id="detailsCodec" className="info-value">{video.codec || "不明"}</span>
              </div>
            </div>
          </div>

          <div className="details-actions">
            <button
              type="button"
              id="saveDetailsBtn"
              className="btn btn-primary"
              disabled={saveMutation.isPending}
              onClick={() => void saveMutation.mutateAsync()}
            >
              保存
            </button>
            <button
              type="button"
              id="playVideoBtn"
              className="btn btn-secondary"
              onClick={() => ui.openPlayer(video.id)}
            >
              再生
            </button>
            <button
              type="button"
              id="externalPlayVideoBtn"
              className="btn btn-secondary"
              title="外部プレーヤーで開く"
              onClick={() => void ipc().openVideo(video.path)}
            >
              <span className="icon">↗</span>
              外部プレーヤーで開く
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
