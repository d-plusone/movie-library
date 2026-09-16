/**
 * 通知トーストの描画
 * ホバー / フォーカス中は自動消滅を一時停止し、× で手動削除できる。
 */
import { useNotify } from "../state/NotificationContext";

export function Toasts() {
  const { toasts, dismiss, pauseAutoDismiss, resumeAutoDismiss } = useNotify();
  if (toasts.length === 0) return null;

  return (
    <div id="notificationContainer" className="notification-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`notification ${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
          onMouseEnter={() => pauseAutoDismiss(toast.id)}
          onMouseLeave={() => resumeAutoDismiss(toast.id)}
          onFocus={() => pauseAutoDismiss(toast.id)}
          onBlur={() => resumeAutoDismiss(toast.id)}
        >
          <div className="notification-message">{toast.message}</div>
          <button
            type="button"
            className="notification-close"
            title="閉じる"
            aria-label="通知を閉じる"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
