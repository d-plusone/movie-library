/**
 * 通知トーストの描画
 */
import { useNotify } from "../state/NotificationContext";

export function Toasts() {
  const { toasts, dismiss } = useNotify();
  if (toasts.length === 0) return null;

  return (
    <div id="notificationContainer" className="notification-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`notification ${toast.type}`}>
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
