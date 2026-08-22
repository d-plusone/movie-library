/**
 * renderer プロセス用のグローバル型定義
 *
 * window.electronAPI の型は src/types/electron-api.ts の ElectronAPI を
 * 唯一の真実源として参照する（ここに手書きの宣言を追加しないこと）。
 */

import type { ElectronAPI } from "./electron-api";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
