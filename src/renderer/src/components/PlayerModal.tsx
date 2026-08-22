/**
 * 内蔵プレーヤーモーダル
 * キーボード操作・視聴進捗の保存・スクリーンショット・フレームからサムネイル作成を担う。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { formatDuration, pathToFileUrl } from "../lib/format";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

const WATCH_SAVE_INTERVAL_SEC = 5;
/** 動画長の 95% 以上まで視聴済みなら次回は先頭から再生する */
const RESUME_SKIP_THRESHOLD = 0.95;

export function PlayerModal() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();

  const videosQuery = useQuery({
    queryKey: queryKeys.videos,
    queryFn: () => ipc().getVideos(),
    staleTime: Infinity,
    enabled: ui.playerVideoId !== null,
  });
  const video =
    videosQuery.data?.find((candidate) => candidate.id === ui.playerVideoId) ?? null;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedRef = useRef(0);
  const [progressText, setProgressText] = useState("");
  /** 外部プレーヤーへのフォールバックを 1 開始あたり 1 回だけ行うためのフラグ */
  const fallbackTriggeredRef = useRef(false);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const saveWatchEnabled = useCallback(
    (): boolean => localStorage.getItem("saveWatchProgress") !== "false",
    [],
  );

  const updateProgressText = useCallback((position: number, duration: number): void => {
    if (duration > 0) {
      const percentValue = Math.min(100, Math.round((position / duration) * 100));
      setProgressText(
        `${formatDuration(position)} / ${formatDuration(duration)} (${percentValue}%)`,
      );
    } else {
      setProgressText(formatDuration(position));
    }
  }, []);

  /**
   * 内蔵プレーヤーで再生できない場合の外部プレーヤーへのフォールバック。
   * 1 回の再生開始につき 1 回だけ発火する（error イベントと play() 失敗の二重発火防止）。
   */
  const triggerExternalFallback = useCallback((): void => {
    if (fallbackTriggeredRef.current || video === null) return;
    fallbackTriggeredRef.current = true;

    notify(
      "内蔵プレーヤーで再生できなかったため、外部プレーヤーで開きます",
      "warning",
    );
    ui.closePlayer();
    // 内蔵プレーヤーのソース解放（クリーンアップ）を待ってから外部アプリを起動する
    window.setTimeout(() => {
      void ipc()
        .openVideo(video.path)
        .catch((e: Error) =>
          console.error("Failed to open external player:", e),
        );
    }, 150);
  }, [notify, ui, video]);

  // 開閉時の初期化
  useEffect(() => {
    if (ui.playerVideoId === null || !video) return;
    const element = videoRef.current;
    if (!element) return;

    lastSavedRef.current = 0;
    fallbackTriggeredRef.current = false;
    setProgressText(formatDuration(0));

    element.src = pathToFileUrl(video.path);
    element.load();

    const saved = video.watchPosition ?? 0;
    if (saveWatchEnabled() && saved > 0) {
      const onLoadedMetadata = (): void => {
        if (element.duration > 0 && saved < element.duration * RESUME_SKIP_THRESHOLD) {
          element.currentTime = saved;
        }
      };
      element.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    }

    if (saveWatchEnabled()) {
      void ipc()
        .updateVideo(video.id, { watchedAt: new Date() })
        .catch((e: Error) => console.error("Failed to record watchedAt:", e));
    }

    const onTimeUpdate = (): void => {
      const position = Math.floor(element.currentTime) || 0;
      const duration = element.duration || video.duration || 0;
      updateProgressText(position, duration);

      if (!saveWatchEnabled()) return;
      if (Math.abs(position - lastSavedRef.current) >= WATCH_SAVE_INTERVAL_SEC) {
        lastSavedRef.current = position;
        void ipc()
          .updateVideo(video.id, { watchPosition: position })
          .catch((e: Error) => console.error("Failed to save watch position:", e));
      }
    };

    const onEnded = (): void => {
      if (saveWatchEnabled()) {
        void ipc()
          .updateVideo(video.id, { watchPosition: 0 })
          .catch((e: Error) => console.error("Failed to reset watch position:", e));
      }
      updateProgressText(0, 0);
    };

    const onError = (): void => {
      notify("動画を再生できませんでした（コーデック非対応の可能性があります）", "error");
      triggerExternalFallback();
    };

    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onError);
    void element.play().catch((e: DOMException) => {
      console.error("Failed to start playback:", e);
      notify("動画を再生できませんでした（コーデック非対応の可能性があります）", "error");
      triggerExternalFallback();
    });

    element.focus({ preventScroll: true });

    return () => {
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
      // 最終視聴位置を保存してからソースを解放する
      const finalPosition = Math.floor(element.currentTime) || 0;
      if (saveWatchEnabled() && finalPosition > 0) {
        void ipc()
          .updateVideo(video.id, { watchPosition: finalPosition })
          .catch((e: Error) => console.error("Failed to save final watch position:", e))
          .finally(() => invalidateVideos());
      } else {
        void invalidateVideos();
      }
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
    // video オブジェクトは ID 解決後の最新を使うため、ID のみ依存にする
  }, [ui.playerVideoId]);

  // video 要素へのフォーカスは上の effect が担うため、この trap は Tab 循環のみ担当する
  useFocusTrap(modalRef, ui.playerVideoId !== null);

  async function invalidateVideos(): Promise<void> {
    await qc.invalidateQueries({ queryKey: queryKeys.videos });
  }

  const captureScreenshot = useCallback(async (): Promise<void> => {
    const element = videoRef.current;
    if (!element || !video) return;
    const position = Math.floor(element.currentTime) || 0;
    const savedDir = localStorage.getItem("screenshotDir")?.trim();
    const outputDir = savedDir && savedDir !== "" ? savedDir : "~/Pictures";
    try {
      notify(`スクリーンショットを保存中... (${formatDuration(position)})`, "info");
      const result = await ipc().captureFrame(video.path, position, outputDir);
      if (result.success && result.outputPath !== undefined) {
        notify(`スクリーンショットを保存しました: ${result.outputPath}`, "success");
      } else {
        notify(`スクリーンショットの保存に失敗しました（${result.error ?? "不明なエラー"}）`, "error");
      }
    } catch (e) {
      notify(
        `スクリーンショットの保存に失敗しました（${e instanceof Error ? e.message : String(e)}）`,
        "error",
      );
    }
  }, [notify, video]);

  const createThumbnailFromFrame = useCallback(async (): Promise<void> => {
    const element = videoRef.current;
    if (!element || !video) return;
    const position = Math.floor(element.currentTime) || 0;
    try {
      notify(`サムネイルを作成中... (${formatDuration(position)})`, "info");
      await ipc().regenerateMainThumbnailWithTimestamp(video.id, position);
      await invalidateVideos();
      notify("サムネイルを作成しました", "success");
    } catch (e) {
      notify(
        `サムネイルの作成に失敗しました（${e instanceof Error ? e.message : String(e)}）`,
        "error",
      );
    }
  }, [notify, video]);

  // プレーヤー表示中のキーボード操作（キャプチャフェーズで他ハンドラより優先）
  useEffect(() => {
    if (ui.playerVideoId === null) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void captureScreenshot();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }

      const element = videoRef.current;
      if (!element) return;

      // Option(Alt)+←/→: フレーム送り
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        element.pause();
        const fps = video !== null && video.fps !== undefined && video.fps > 0 ? video.fps : 30;
        const frameStep = 1 / fps;
        const duration = element.duration || 0;
        const delta = e.key === "ArrowRight" ? frameStep : -frameStep;
        element.currentTime = Math.max(0, Math.min(duration, element.currentTime + delta));
        updateProgressText(Math.floor(element.currentTime), duration);
        return;
      }

      switch (e.key) {
        case " ": {
          e.preventDefault();
          e.stopPropagation();
          if (element.paused) {
            void element.play().catch((playError: DOMException) =>
              console.error("Failed to resume playback:", playError),
            );
          } else {
            element.pause();
          }
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          e.stopPropagation();
          const seconds = e.shiftKey ? 1 : 5;
          const delta = e.key === "ArrowLeft" ? -seconds : seconds;
          const duration = element.duration || 0;
          element.currentTime = Math.max(0, Math.min(duration, element.currentTime + delta));
          updateProgressText(Math.floor(element.currentTime), duration);
          break;
        }
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          e.stopPropagation();
          const volumeDelta = e.key === "ArrowUp" ? 0.1 : -0.1;
          element.volume = Math.max(0, Math.min(1, element.volume + volumeDelta));
          if (element.volume > 0) element.muted = false;
          break;
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      // スペース/Enter でフォーカス済みボタンが誤発火するのを防ぐ
      if (e.key !== " " && e.key !== "Enter") return;
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "BUTTON" || target.tagName === "A")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
  }, [ui.playerVideoId, captureScreenshot, createThumbnailFromFrame, updateProgressText, video]);

  if (ui.playerVideoId === null || !video) {
    return (
      <div ref={modalRef} id="videoPlayerModal" className="video-player-modal" style={{ display: "none" }} />
    );
  }

  const resetWatchProgress = (): void => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = 0;
    lastSavedRef.current = 0;
    if (saveWatchEnabled()) {
      void ipc()
        .updateVideo(video.id, { watchPosition: 0 })
        .catch((e: Error) => console.error("Failed to reset watch position:", e));
    }
    updateProgressText(0, element.duration || 0);
    notify("視聴位置をリセットしました", "success");
  };

  return (
    <div ref={modalRef} id="videoPlayerModal" className="video-player-modal" role="dialog" aria-modal="true" aria-label="動画プレーヤー">
      <div className="video-player-container">
        <div className="video-player-header">
          <span id="playerVideoTitle" className="video-player-title">{video.title}</span>
          <div className="video-player-actions">
            <button
              type="button"
              id="playerScreenshotBtn"
              className="btn btn-small"
              title="現在のフレームを最高画質で保存（⌘S）"
              onClick={() => {
                void captureScreenshot();
                videoRef.current?.focus({ preventScroll: true });
              }}
            >
              <span className="icon">📷</span>
              スクショ
            </button>
            <button
              type="button"
              id="playerThumbnailBtn"
              className="btn btn-small"
              title="現在のフレームを動画のサムネイルに設定"
              onClick={() => {
                void createThumbnailFromFrame();
                videoRef.current?.focus({ preventScroll: true });
              }}
            >
              <span className="icon">🖼️</span>
              サムネイル
            </button>
            <button
              type="button"
              id="playerExternalPlayBtn"
              className="btn btn-small"
              title="外部プレーヤーで開く"
              onClick={() => {
                ui.closePlayer();
                void ipc().openVideo(video.path);
              }}
            >
              <span className="icon">↗</span>
              外部再生
            </button>
            <button
              type="button"
              id="closePlayerBtn"
              className="btn btn-icon"
              aria-label="プレーヤーを閉じる"
              onClick={() => ui.closePlayer()}
            >
              <span className="icon">✕</span>
            </button>
          </div>
        </div>

        <div className="video-player-body">
          {/* tabindex=0: キーボードショートカットを受け取るフォーカス先 */}
          <video ref={videoRef} id="internalPlayer" controls playsInline preload="auto" tabIndex={0} />
        </div>

        <div className="video-player-footer">
          <span id="playerProgressText" className="video-player-progress">{progressText}</span>
          <button type="button" id="resetWatchProgressBtn" className="btn btn-small" title="視聴位置をリセット" onClick={resetWatchProgress}>
            視聴位置をリセット
          </button>
        </div>
      </div>
    </div>
  );
}
