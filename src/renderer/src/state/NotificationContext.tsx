/**
 * 通知トースト管理（旧 NotificationManager の移植）
 * - 同一メッセージの 1 秒内重複を抑制
 * - 最大 3 枚表示（超過時は最古を除去）
 * - 5 秒で自動消滅
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NotificationType } from "../types";

export interface Toast {
  id: number;
  message: string;
  type: NotificationType;
}

interface NotifyContextValue {
  toasts: Toast[];
  notify: (message: string, type?: NotificationType) => void;
  dismiss: (id: number) => void;
}

const NotifyContext = createContext<NotifyContextValue | null>(null);

const MAX_TOASTS = 3;
const DEDUPE_WINDOW_MS = 1000;
const AUTO_DISMISS_MS = 5000;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const recentMessages = useRef(new Set<string>());
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, type: NotificationType = "info") => {
      const key = `${message}-${type}`;
      if (recentMessages.current.has(key)) return;
      recentMessages.current.add(key);
      window.setTimeout(() => recentMessages.current.delete(key), DEDUPE_WINDOW_MS);

      const id = nextId.current++;
      setToasts((current) => {
        const next = [...current, { id, message, type }];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo<NotifyContextValue>(
    () => ({ toasts, notify, dismiss }),
    [toasts, notify, dismiss],
  );

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>;
}

export function useNotify(): NotifyContextValue {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error("useNotify must be used within NotifyProvider");
  return ctx;
}
