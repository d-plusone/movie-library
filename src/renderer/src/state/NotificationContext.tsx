/**
 * 通知トースト管理（旧 NotificationManager の移植）
 * - 同一メッセージの 1 秒内重複を抑制
 * - 最大 3 枚表示（超過時は最古を除去）
 * - 全トーストが 5 秒で自動消滅。ホバー / フォーカス中はタイマーを一時停止し、
 *   残り時間から再開する
 * - × ボタンで全トーストを手動削除できる
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  /**
   * トーストを表示して id を返す。
   * 重複抑止で表示されなかった場合も id は返るため、呼び出し側は
   * 戻り値をそのまま dismiss してよい（表示されていない場合は何も起きない）。
   */
  notify: (message: string, type?: NotificationType) => number;
  dismiss: (id: number) => void;
  /** ホバー / フォーカス開始時に自動消滅タイマーを止める */
  pauseAutoDismiss: (id: number) => void;
  /** ホバー / フォーカス終了時に残り時間から自動消滅を再開する */
  resumeAutoDismiss: (id: number) => void;
}

const NotifyContext = createContext<NotifyContextValue | null>(null);

const MAX_TOASTS = 3;
const DEDUPE_WINDOW_MS = 1000;
const AUTO_DISMISS_MS = 5000;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const recentMessages = useRef(new Set<string>());
  const nextId = useRef(1);
  /** トースト id -> 自動消滅タイマー */
  const timers = useRef(new Map<number, number>());
  /** トースト id -> 一時停止時点の残り時間 */
  const remainingMs = useRef(new Map<number, number>());
  /** トースト id -> 現在のタイマー開始時刻 */
  const startedAt = useRef(new Map<number, number>());

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      remainingMs.current.delete(id);
      startedAt.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const scheduleAutoDismiss = useCallback(
    (id: number, delayMs: number) => {
      startedAt.current.set(id, Date.now());
      const timer = window.setTimeout(() => dismiss(id), delayMs);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const pauseAutoDismiss = useCallback(
    (id: number) => {
      // タイマーが無い = 既に停止中 or 消滅済み
      if (!timers.current.has(id)) return;
      clearTimer(id);
      const started = startedAt.current.get(id) ?? Date.now();
      const remaining = remainingMs.current.get(id) ?? AUTO_DISMISS_MS;
      remainingMs.current.set(id, Math.max(0, remaining - (Date.now() - started)));
      startedAt.current.delete(id);
    },
    [clearTimer],
  );

  const resumeAutoDismiss = useCallback(
    (id: number) => {
      // 既にタイマーが動いていれば何もしない
      if (timers.current.has(id)) return;
      const remaining = remainingMs.current.get(id);
      // 削除済み（remainingMs からも消えている）なら何もしない
      if (remaining === undefined) return;
      if (remaining <= 0) {
        dismiss(id);
        return;
      }
      scheduleAutoDismiss(id, remaining);
    },
    [dismiss, scheduleAutoDismiss],
  );

  const notify = useCallback(
    (message: string, type: NotificationType = "info"): number => {
      const id = nextId.current++;
      const key = `${message}-${type}`;
      if (!recentMessages.current.has(key)) {
        recentMessages.current.add(key);
        window.setTimeout(() => recentMessages.current.delete(key), DEDUPE_WINDOW_MS);

        remainingMs.current.set(id, AUTO_DISMISS_MS);
        scheduleAutoDismiss(id, AUTO_DISMISS_MS);
        setToasts((current) => {
          const next = [...current, { id, message, type }];
          return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
        });
      }
      return id;
    },
    [scheduleAutoDismiss],
  );

  // 表示から消えたトースト（手動削除・最大枚数超過による押し出し）のタイマーを破棄する
  useEffect(() => {
    const visible = new Set(toasts.map((toast) => toast.id));
    for (const [id, timer] of timers.current) {
      if (visible.has(id)) continue;
      window.clearTimeout(timer);
      timers.current.delete(id);
      remainingMs.current.delete(id);
      startedAt.current.delete(id);
    }
  }, [toasts]);

  // アンマウント時に残っているタイマーを破棄する
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
      remainingMs.current.clear();
      startedAt.current.clear();
    },
    [],
  );

  const value = useMemo<NotifyContextValue>(
    () => ({ toasts, notify, dismiss, pauseAutoDismiss, resumeAutoDismiss }),
    [toasts, notify, dismiss, pauseAutoDismiss, resumeAutoDismiss],
  );

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>;
}

export function useNotify(): NotifyContextValue {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error("useNotify must be used within NotifyProvider");
  return ctx;
}
