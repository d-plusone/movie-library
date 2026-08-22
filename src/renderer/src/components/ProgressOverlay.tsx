/**
 * 統一進捗オーバーレイ（旧 UnifiedProgressManager のモーダル部分）
 * 画面下部に進行中タスクの一覧を表示する。
 */
import { useProgress } from "../state/ProgressContext";

function percent(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((current / total) * 100));
}

export function ProgressOverlay() {
  const { entries } = useProgress();
  if (entries.length === 0) return null;

  return (
    <div id="unifiedProgressModal" className="unified-progress-modal">
      <div className="progress-list">
        {entries.map((entry) => {
          const pct = entry.completed ? 100 : percent(entry.current, entry.total);
          return (
            <div
              key={entry.id}
              id={`progress-item-${entry.id}`}
              className={`progress-item${entry.completed ? " completed" : ""}`}
            >
              <div className="progress-message">
                {entry.completed ? `${entry.label} - 完了` : entry.message}
              </div>
              <div className="progress-bar-wrapper">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
                <div className="progress-percentage">{pct}%</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
