/**
 * IPC アクセスと React Query のキー定義
 */
import type { ElectronAPI } from "../../../types/electron-api";
import type { ProgressEvent } from "../../../types/types";

/** window.electronAPI へのアクセス（preload が注入する） */
export function ipc(): ElectronAPI {
  if (window.electronAPI === undefined) {
    throw new Error(
      "electronAPI is not available - preload script may not have loaded",
    );
  }
  return window.electronAPI;
}

export const queryKeys = {
  videos: ["videos"] as const,
  tags: ["tags"] as const,
  directories: ["directories"] as const,
  directoryStatuses: ["directory-statuses"] as const,
} as const;

/** 進捗イベントが「進捗中」かどうかの型ガード */
export function isProgressStart(event: ProgressEvent): boolean {
  return event.kind === "progress";
}
