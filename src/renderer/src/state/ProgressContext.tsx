/**
 * main プロセスからの進捗イベントを集約する（旧 UnifiedProgressManager の移植）
 *
 * - scan / rescan / thumbnail の各チャネルを受信し、統一オーバーレイ用の状態へ変換する
 * - オーナープログレス（rescan-all, thumbnail-regen, cleanup）が残っている間は
 *   設定モーダルを閉じられない、という旧挙動を hasOwners で再現する
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ProgressEvent } from "../../../types/types";

export interface ProgressEntry {
  id: string;
  label: string;
  message: string;
  current: number;
  total: number;
  owner: boolean;
  completed: boolean;
  /** 最終更新時刻。完了イベントが来ない単発処理のスタイル検出に使う */
  updatedAt: number;
  /** 完了時刻。完了後 COMPLETE_REMOVE_DELAY_MS 経過で一覧から取り除く */
  completedAt?: number;
}

interface ProgressContextValue {
  entries: ProgressEntry[];
  /** オーナープログレスが 1 つでも生存しているか */
  hasOwners: boolean;
}

const ProgressContext = createContext<ProgressContextValue | null>(null);

const COMPLETE_REMOVE_DELAY_MS = 1000;
/** この時間更新がない進行中エントリは完了扱いにする（done イベント欠落の保険） */
const STALE_AFTER_MS = 6000;

type ProgressChannel = "scan-progress" | "rescan-progress" | "thumbnail-progress";

interface ChannelBinding {
  id: string;
  label: string;
  owner: boolean;
}

function resolveThumbnailBinding(entries: ProgressEntry[]): ChannelBinding {
  // 設定画面からのサムネイル再生成が進行中ならそちらを優先
  const regen = entries.find(
    (entry) => entry.id === "settings-thumbnail-regen" && !entry.completed,
  );
  if (regen) {
    return { id: regen.id, label: regen.label, owner: true };
  }
  return { id: "thumbnail-progress", label: "サムネイルを生成中", owner: false };
}

function bindingFor(
  channel: ProgressChannel,
  entries: ProgressEntry[],
): ChannelBinding {
  switch (channel) {
    case "scan-progress":
      return { id: "scan-progress", label: "ディレクトリをスキャン中", owner: false };
    case "rescan-progress":
      return { id: "settings-rescan-all", label: "全ての動画を再スキャン中", owner: true };
    case "thumbnail-progress":
      return resolveThumbnailBinding(entries);
  }
}

function applyEvent(
  previous: ProgressEntry[],
  channel: ProgressChannel,
  event: ProgressEvent,
): ProgressEntry[] {
  const now = Date.now();
  const binding = bindingFor(channel, previous);

  if (event.kind === "progress") {
    const message = event.message ?? `${binding.label} (${event.current}/${event.total})`;
    const existing = previous.find((entry) => entry.id === binding.id);
    if (!existing) {
      return [
        ...previous,
        {
          id: binding.id,
          label: binding.label,
          message,
          current: event.current,
          total: event.total,
          owner: binding.owner,
          completed: false,
          updatedAt: now,
        },
      ];
    }
    return previous.map((entry) =>
      entry.id === binding.id
        ? { ...entry, total: event.total, current: event.current, message, completed: false, updatedAt: now }
        : entry,
    );
  }

  // kind === "done"
  const existing = previous.find((entry) => entry.id === binding.id && !entry.completed);
  if (!existing) {
    // プログレス未登録なら一時的に作って即完了扱い（旧挙動）
    return [
      ...previous.filter((entry) => entry.id !== binding.id),
      {
        id: binding.id,
        label: binding.label,
        message: event.message,
        current: 1,
        total: 1,
        owner: false,
        completed: true,
        updatedAt: now,
        completedAt: now,
      },
    ];
  }
  return previous.map((entry) =>
    entry.id === binding.id
      ? { ...entry, current: entry.total, completed: true, completedAt: now }
      : entry,
  );
}

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ProgressEntry[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    api.onScanProgress((data) =>
      setEntries((current) => applyEvent(current, "scan-progress", data)),
    );
    api.onRescanProgress((data) =>
      setEntries((current) => applyEvent(current, "rescan-progress", data)),
    );
    api.onThumbnailProgress((data) =>
      setEntries((current) => applyEvent(current, "thumbnail-progress", data)),
    );
    // preload が off を提供しないチャネルのため、アプリ生存期間中は
    // リスナーを張りっぱなしにする（単一ページ構成のため実害なし）
  }, []);

  // 完了エントリの遅延除去 + スタイル（長時間更新なし）エントリの自動完了
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setEntries((current) => {
        let changed = false;
        const next = current
          .map((entry) => {
            // done イベントを欠いた単発処理を完了扱いにする
            if (!entry.completed && now - entry.updatedAt > STALE_AFTER_MS) {
              changed = true;
              return { ...entry, completed: true, current: entry.total, completedAt: now };
            }
            return entry;
          })
          .filter((entry) => {
            if (entry.completed && entry.completedAt !== undefined) {
              if (now - entry.completedAt >= COMPLETE_REMOVE_DELAY_MS) {
                changed = true;
                return false;
              }
            }
            return true;
          });
        return changed ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const value = useMemo<ProgressContextValue>(
    () => ({
      entries,
      hasOwners: entries.some((entry) => entry.owner),
    }),
    [entries],
  );

  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>;
}

export function useProgress(): ProgressContextValue {
  const ctx = useContext(ProgressContext);
  if (!ctx) throw new Error("useProgress must be used within ProgressProvider");
  return ctx;
}
