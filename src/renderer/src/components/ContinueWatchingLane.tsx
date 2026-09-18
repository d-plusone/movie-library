import { useRef } from "react";
import { formatDuration } from "../lib/format";
import { useFocusTrap } from "../lib/hooks";
import { PLACEHOLDER_THUMBNAIL, thumbnailUrl } from "../lib/thumbnails";
import { useUi } from "../state/UiContext";
import type { Video } from "../types";

interface ContinueWatchingLaneProps {
  videos: Video[];
  onPlay: (video: Video) => void;
}

function watchedSortValue(video: Video): number {
  return video.watchedAt instanceof Date ? video.watchedAt.getTime() : 0;
}

export function ContinueWatchingLane({ videos, onPlay }: ContinueWatchingLaneProps) {
  const ui = useUi();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, ui.continueWatchingOpen);

  const resumable = videos
    .filter((video) => {
      const position = video.watchPosition ?? 0;
      const duration = video.duration ?? 0;
      return position > 0 && duration > 0 && position < duration * 0.95;
    })
    .sort((a, b) => watchedSortValue(b) - watchedSortValue(a))

  if (resumable.length === 0) return null;

  return (
    <>
      <section className="continue-watching-launcher" aria-label="続きから見る">
        <button
          type="button"
          className="continue-watching-open-btn"
          onClick={() => ui.setContinueWatchingOpen(true)}
        >
          <span className="icon">▶</span>
          続きから見る
          <span className="continue-watching-count">{resumable.length}本</span>
        </button>
      </section>

      {ui.continueWatchingOpen && (
        <div
          className="modal continue-watching-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="continueWatchingTitle"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) ui.setContinueWatchingOpen(false);
          }}
        >
          <div ref={dialogRef} className="modal-content">
            <div className="modal-header">
              <h2 id="continueWatchingTitle">続きから見る</h2>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="閉じる"
                onClick={() => ui.setContinueWatchingOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body continue-watching-dialog-body">
              <div className="continue-watching-dialog-list">
                {resumable.map((video) => {
                  const position = Math.min(video.duration, Math.max(0, video.watchPosition ?? 0));
                  const percentage = Math.min(100, (position / video.duration) * 100);
                  return (
                    <button
                      type="button"
                      className="continue-watching-card"
                      key={video.id}
                      onClick={() => {
                        ui.setContinueWatchingOpen(false);
                        onPlay(video);
                      }}
                      title={`${video.title}を${formatDuration(position)}から再生`}
                    >
                      <span className="continue-watching-thumb">
                        <img
                          src={video.thumbnailPath ? thumbnailUrl(video, video.thumbnailPath) : PLACEHOLDER_THUMBNAIL}
                          alt=""
                          loading="lazy"
                        />
                        <span className="continue-watching-progress" style={{ width: `${percentage}%` }} />
                      </span>
                      <span className="continue-watching-title">{video.title}</span>
                      <span className="continue-watching-time">
                        {formatDuration(position)} / {formatDuration(video.duration)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
