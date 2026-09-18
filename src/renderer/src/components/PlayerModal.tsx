/**
 * 内蔵プレーヤーモーダル
 * キーボード操作・視聴進捗の保存・スクリーンショット・フレームからサムネイル作成を担う。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { parseChapters } from "../lib/chapters";
import { formatDuration, pathToFileUrl } from "../lib/format";
import { thumbnailUrl } from "../lib/thumbnails";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

const WATCH_SAVE_INTERVAL_SEC = 5;
/** 動画長の 95% 以上まで視聴済みなら次回は先頭から再生する */
const RESUME_SKIP_THRESHOLD = 0.95;

export function PlayerModal() {
  const qc = useQueryClient();
  const { notify, dismiss } = useNotify();
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
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [seekPreview, setSeekPreview] = useState<{ time: number; left: number; path: string | null } | null>(null);
  const playbackRateRef = useRef(1);
  const loopARef = useRef<number | null>(null);
  const loopBRef = useRef<number | null>(null);
  /** 外部プレーヤーへのフォールバックを 1 開始あたり 1 回だけ行うためのフラグ */
  const fallbackTriggeredRef = useRef(false);
  const modalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (ui.playerVideoId === null) {
      setLoopA(null);
      setLoopB(null);
      loopARef.current = null;
      loopBRef.current = null;
      return;
    }
    if (video?.id === undefined) return;
    const stored = Number(localStorage.getItem("playbackRate") ?? "1");
    const nextRate = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(stored) ? stored : 1;
    playbackRateRef.current = nextRate;
    setPlaybackRate(nextRate);
    setLoopA(null);
    setLoopB(null);
    loopARef.current = null;
    loopBRef.current = null;
  }, [ui.playerVideoId, video?.id]);

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
    setCurrentTime(0);
    setDuration(video.duration ?? 0);

    element.src = pathToFileUrl(video.path);
    element.playbackRate = playbackRateRef.current;
    element.load();

    const saved = video.watchPosition ?? 0;
    const onLoadedMetadata = (): void => {
      const loadedDuration = element.duration || video.duration || 0;
      setDuration(loadedDuration);
      element.playbackRate = playbackRateRef.current;
      if (saveWatchEnabled() && saved > 0 && loadedDuration > 0 && saved < loadedDuration * RESUME_SKIP_THRESHOLD) {
        element.currentTime = saved;
      }
      updateProgressText(element.currentTime || 0, loadedDuration);
    };
    element.addEventListener("loadedmetadata", onLoadedMetadata);

    if (saveWatchEnabled()) {
      void ipc()
        .updateVideo(video.id, { watchedAt: new Date() })
        .catch((e: Error) => console.error("Failed to record watchedAt:", e));
    }

    const onTimeUpdate = (): void => {
      const position = Math.floor(element.currentTime) || 0;
      const duration = element.duration || video.duration || 0;
      setCurrentTime(element.currentTime || 0);
      setDuration(duration);
      updateProgressText(position, duration);

      const end = loopBRef.current;
      const start = loopARef.current ?? 0;
      if (end !== null && end > start && element.currentTime >= end - 0.03) {
        element.currentTime = start;
        void element.play().catch(() => undefined);
        return;
      }

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
      setCurrentTime(0);
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
      element.removeEventListener("loadedmetadata", onLoadedMetadata);
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
      setSeekPreview(null);
    };
    // video は videos クエリ解決後のため、ID 到着遅延に追従できるよう依存に含める。
    // 初回実行時に video が null なら早期 return（クリーンアップなし）し、
    // video 到着後の再実行で初期化される。ID が同一のまま video オブジェクトだけ
    // 変わった場合は再初期化しないよう video.id（プリミティブ）で比較する。
  }, [ui.playerVideoId, video?.id]);

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
    // 未設定時は空文字を送り、main 側で OS のピクチャフォルダにフォールバックさせる。
    // 旧バージョンが保存した文字通りの "~/Pictures" も未設定扱いにする。
    const outputDir =
      savedDir && savedDir !== "" && savedDir !== "~/Pictures" ? savedDir : "";
    // 完了時に「保存中...」を消してから結果を出す（2 枚同時に残らないようにする）
    const progressId = notify(
      `スクリーンショットを保存中... (${formatDuration(position)})`,
      "info",
    );
    try {
      const result = await ipc().captureFrame(video.path, position, outputDir);
      dismiss(progressId);
      if (result.success && result.outputPath !== undefined) {
        notify(`スクリーンショットを保存しました: ${result.outputPath}`, "success");
      } else {
        notify(`スクリーンショットの保存に失敗しました（${result.error ?? "不明なエラー"}）`, "error");
      }
    } catch (e) {
      dismiss(progressId);
      notify(
        `スクリーンショットの保存に失敗しました（${e instanceof Error ? e.message : String(e)}）`,
        "error",
      );
    }
  }, [dismiss, notify, video]);

  const createThumbnailFromFrame = useCallback(async (): Promise<void> => {
    const element = videoRef.current;
    if (!element || !video) return;
    const position = Math.floor(element.currentTime) || 0;
    // 完了時に「作成中...」を消してから結果を出す（2 枚同時に残らないようにする）
    const progressId = notify(
      `サムネイルを作成中... (${formatDuration(position)})`,
      "info",
    );
    try {
      await ipc().regenerateMainThumbnailWithTimestamp(video.id, position);
      await invalidateVideos();
      dismiss(progressId);
      notify("サムネイルを作成しました", "success");
    } catch (e) {
      dismiss(progressId);
      notify(
        `サムネイルの作成に失敗しました（${e instanceof Error ? e.message : String(e)}）`,
        "error",
      );
    }
  }, [dismiss, notify, video]);

  const setPlaybackRateValue = (value: number): void => {
    const nextRate = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(value) ? value : 1;
    playbackRateRef.current = nextRate;
    setPlaybackRate(nextRate);
    localStorage.setItem("playbackRate", String(nextRate));
    if (videoRef.current) videoRef.current.playbackRate = nextRate;
  };

  const seekTo = (time: number): void => {
    const element = videoRef.current;
    if (!element) return;
    const nextTime = Math.max(0, Math.min(duration || element.duration || 0, time));
    element.currentTime = nextTime;
    setCurrentTime(nextTime);
    updateProgressText(nextTime, duration || element.duration || 0);
  };

  const handleSeekPointer = (event: React.MouseEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const totalDuration = duration || video?.duration || 0;
    if (rect.width <= 0 || totalDuration <= 0) return;
    const left = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const time = left * totalDuration;
    const chapters = parseChapters(video?.chapterThumbnails).filter((chapter) => chapter.path);
    const nearest = chapters.reduce<{ path: string; distance: number } | null>((best, chapter) => {
      const distance = Math.abs(chapter.timestamp - time);
      return best === null || distance < best.distance ? { path: chapter.path, distance } : best;
    }, null);
    setSeekPreview({ time, left: left * 100, path: nearest?.path ?? null });
  };

  const setLoopPoint = (point: "A" | "B"): void => {
    const time = videoRef.current?.currentTime ?? currentTime;
    if (point === "A") {
      loopARef.current = time;
      setLoopA(time);
      if (loopBRef.current !== null && loopBRef.current <= time) {
        loopBRef.current = null;
        setLoopB(null);
      }
      return;
    }
    if (loopARef.current === null) {
      notify("先にA地点を設定してください", "warning");
      return;
    }
    if (time <= loopARef.current) {
      notify("B地点はA地点より後に設定してください", "warning");
      return;
    }
    loopBRef.current = time;
    setLoopB(time);
  };

  const clearLoop = (): void => {
    loopARef.current = null;
    loopBRef.current = null;
    setLoopA(null);
    setLoopB(null);
  };

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
    setCurrentTime(0);
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
          <div
            className="player-seek-preview-track"
            role="slider"
            aria-label="シーク"
            aria-valuemin={0}
            aria-valuemax={duration || video.duration || 0}
            aria-valuenow={currentTime}
            onMouseMove={handleSeekPointer}
            onMouseLeave={() => setSeekPreview(null)}
            onClick={(event) => {
              handleSeekPointer(event);
              const rect = event.currentTarget.getBoundingClientRect();
              const totalDuration = duration || video.duration || 0;
              if (rect.width > 0 && totalDuration > 0) {
                seekTo(((event.clientX - rect.left) / rect.width) * totalDuration);
              }
            }}
          >
            <span className="player-seek-preview-progress" style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }} />
            {seekPreview && (
              <span className="player-seek-preview" style={{ left: `${seekPreview.left}%` }}>
                {seekPreview.path && video && <img src={thumbnailUrl(video, seekPreview.path)} alt="" />}
                <span>{formatDuration(seekPreview.time)}</span>
              </span>
            )}
          </div>
        </div>

        <div className="video-player-footer">
          <span id="playerProgressText" className="video-player-progress">{progressText}</span>
          <label className="player-speed-control">
            速度
            <select value={playbackRate} onChange={(event) => setPlaybackRateValue(Number(event.target.value))}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <option key={rate} value={rate}>{rate}x</option>
              ))}
            </select>
          </label>
          <div className="player-loop-controls" role="group" aria-label="A-Bリピート">
            <button type="button" className={`btn btn-small${loopA !== null ? " active" : ""}`} onClick={() => setLoopPoint("A")}>
              A {loopA === null ? "" : formatDuration(loopA)}
            </button>
            <button type="button" className={`btn btn-small${loopB !== null ? " active" : ""}`} onClick={() => setLoopPoint("B")}>
              B {loopB === null ? "" : formatDuration(loopB)}
            </button>
            <button type="button" className="btn btn-small" disabled={loopA === null && loopB === null} onClick={clearLoop}>
              解除
            </button>
          </div>
          <button type="button" id="resetWatchProgressBtn" className="btn btn-small" title="視聴位置をリセット" onClick={resetWatchProgress}>
            視聴位置をリセット
          </button>
        </div>
      </div>
    </div>
  );
}
