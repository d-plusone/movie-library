/**
 * カスタムサムネイル生成ダイアログ
 * シークバー + プレビュー + ホバーツールチップで位置を指定してメインサムネイルを再生成する。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { formatDuration, pathToFileUrl } from "../lib/format";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

const CHANGE_DEBOUNCE_MS = 300;
const TOOLTIP_DEBOUNCE_MS = 150;

export function CustomThumbnailDialog() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();

  const videosQuery = useQuery({
    queryKey: queryKeys.videos,
    queryFn: () => ipc().getVideos(),
    staleTime: Infinity,
    enabled: ui.customThumbVideoId !== null,
  });
  const video =
    ui.customThumbVideoId === null
      ? null
      : videosQuery.data?.find((candidate) => candidate.id === ui.customThumbVideoId) ?? null;

  const duration = video?.duration ?? 0;
  const [position, setPosition] = useState(0);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ツールチップ側
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipLeft, setTooltipLeft] = useState(0);
  const [tooltipPosition, setTooltipPosition] = useState(0);
  const [tooltipSrc, setTooltipSrc] = useState<string | null>(null);
  const [tooltipLoading, setTooltipLoading] = useState(false);

  const cacheRef = useRef(new Map<number, string>());
  const changeTimerRef = useRef<number | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const seekbarRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, ui.customThumbVideoId !== null);

  // 開くたびに初期化（5% の位置）
  useEffect(() => {
    if (ui.customThumbVideoId === null) return;
    cacheRef.current.clear();
    setPreviewSrc(null);
    setTooltipVisible(false);
    setPosition(duration * 0.05);
    seekbarRef.current?.focus({ preventScroll: true });
    // duration が確定した後にも反映させる
  }, [ui.customThumbVideoId, duration]);

  /** 指定位置のプレビュー URL を取得する（0.1 秒単位キャッシュ） */
  const fetchPreview = useCallback(
    async (timestamp: number): Promise<string | null> => {
      if (video === null) return null;
      const key = Math.round(timestamp * 10) / 10;
      const cached = cacheRef.current.get(key);
      if (cached !== undefined) return cached;
      try {
        const previewPath = await ipc().generatePreviewThumbnail(video.path, timestamp);
        const url = `${pathToFileUrl(previewPath)}?t=${Date.now()}`;
        cacheRef.current.set(key, url);
        return url;
      } catch (e) {
        console.error("Error generating preview:", e);
        notify("プレビューの生成に失敗しました", "error");
        return null;
      }
    },
    [video, notify],
  );

  // メインプレビューの遅延更新
  useEffect(() => {
    if (ui.customThumbVideoId === null) return;
    if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
    changeTimerRef.current = window.setTimeout(() => {
      void (async () => {
        setPreviewLoading(true);
        const url = await fetchPreview(position);
        setPreviewLoading(false);
        setPreviewSrc(url);
      })();
    }, CHANGE_DEBOUNCE_MS);
    return () => {
      if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
    };
  }, [position, ui.customThumbVideoId, fetchPreview]);

  const regenerateMutation = useMutation({
    mutationFn: () => ipc().regenerateMainThumbnailWithTimestamp(video?.id ?? 0, position),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.videos });
      notify("カスタムサムネイルを設定しました", "success");
      ui.closeCustomThumb();
    },
    onError: (e) => notify(`カスタムサムネイルの設定に失敗しました (${e.message})`, "error"),
  });

  if (ui.customThumbVideoId === null || video === null) return null;

  const step = 0.1;

  const onSeekbarMouseMove = (event: React.MouseEvent<HTMLInputElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const raw = ratio * duration;
    const rounded = Math.round(raw / step) * step;

    setTooltipVisible(true);
    setTooltipLeft(event.clientX - rect.left);
    setTooltipPosition(rounded);

    if (tooltipTimerRef.current !== null) window.clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = window.setTimeout(() => {
      void (async () => {
        setTooltipLoading(true);
        const url = await fetchPreview(rounded);
        setTooltipLoading(false);
        setTooltipSrc(url);
      })();
    }, TOOLTIP_DEBOUNCE_MS);
  };

  const onSeekbarMouseLeave = (): void => {
    setTooltipVisible(false);
    if (tooltipTimerRef.current !== null) window.clearTimeout(tooltipTimerRef.current);
  };

  const nudge = (direction: -1 | 1): void => {
    setPosition((current) =>
      Math.max(0, Math.min(duration, Math.round((current + direction * step) * 10) / 10)),
    );
  };

  return (
    <div ref={modalRef} id="customThumbnailDialog" className="modal" role="dialog" aria-modal="true" aria-labelledby="customThumbnailDialogTitle">
      <div className="modal-content custom-thumbnail-modal">
        <div className="modal-header">
          <h2 id="customThumbnailDialogTitle">カスタムサムネイルを生成</h2>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="カスタムサムネイルダイアログを閉じる"
            onClick={() => ui.closeCustomThumb()}
          >
            <span className="icon">✕</span>
          </button>
        </div>

        <div
          className="modal-body"
          onKeyDown={(e) => {
            // ダイアログ全体で方向キーを受け取りシークバーへ反映
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              nudge(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              nudge(1);
            }
          }}
        >
          <div className="custom-thumbnail-container">
            <div className="thumbnail-preview-section">
              <div className="preview-image-container">
                {previewSrc !== null && (
                  <img id="customThumbnailPreview" src={previewSrc} alt="プレビュー" />
                )}
                {previewLoading && (
                  <div id="customThumbnailLoading" className="preview-loading">
                    <div className="spinner" />
                    <p>プレビュー生成中...</p>
                  </div>
                )}
              </div>
              <div className="seekbar-container">
                <div className="seekbar-time-display">
                  <span id="currentTimeDisplay">{formatDuration(position)}</span>
                  <span> / </span>
                  <span id="totalTimeDisplay">{formatDuration(duration)}</span>
                </div>
                <div className="seekbar-wrapper">
                  <input
                    ref={seekbarRef}
                    type="range"
                    id="thumbnailSeekbar"
                    className="thumbnail-seekbar"
                    min={0}
                    max={duration}
                    value={position}
                    step={step}
                    onChange={(e) => setPosition(parseFloat(e.target.value))}
                    onMouseMove={(e) => onSeekbarMouseMove(e)}
                    onMouseLeave={onSeekbarMouseLeave}
                  />
                  {tooltipVisible && (
                    <div className="seekbar-tooltip show" style={{ left: tooltipLeft }}>
                      {tooltipLoading ? (
                        <div className="loading-indicator">
                          <div className="spinner" />
                        </div>
                      ) : (
                        tooltipSrc !== null && (
                          <img src={tooltipSrc} alt="プレビュー" />
                        )
                      )}
                      <div className="seekbar-tooltip-time">{formatDuration(tooltipPosition)}</div>
                    </div>
                  )}
                </div>
                <div className="seekbar-markers">
                  <span>0%</span>
                  <span>25%</span>
                  <span>50%</span>
                  <span>75%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-success"
            disabled={regenerateMutation.isPending}
            onClick={() => void regenerateMutation.mutateAsync()}
          >
            <span className="icon">✓</span>
            このフレームをメインサムネイルに設定
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => ui.closeCustomThumb()}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
