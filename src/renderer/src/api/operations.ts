/**
 * ライブラリ操作（スキャン・サムネイル生成など）の共通処理。
 * 各コンポーネントから呼び出され、成功時に React Query キャッシュを無効化する。
 */
import type { QueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "./ipc";
import type { NotificationType } from "../types";

export interface OperationDeps {
  qc: QueryClient;
  notify: (message: string, type?: NotificationType) => void;
}

async function invalidateLibraryData(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.videos }),
    qc.invalidateQueries({ queryKey: queryKeys.tags }),
    qc.invalidateQueries({ queryKey: queryKeys.directories }),
  ]);
}

function messageOf(e: Error | string): string {
  return e instanceof Error ? e.message : String(e);
}

/** フォルダ選択 → 登録 → 自動スキャン → 必要ならサムネイル生成までの一連の流れ */
export async function addDirectoriesFlow(deps: OperationDeps): Promise<void> {
  const { notify, qc } = deps;
  // 追加済みのパス。途中で失敗しても、ここまで成功した分は必ず一覧に反映する
  // （そうしないと DB には登録済みなのに UI キャッシュにだけ現れない状態になる）
  const addedPaths: string[] = [];
  try {
    const paths = await ipc().chooseDirectory();
    if (paths.length === 0) return;

    try {
      for (const path of paths) {
        await ipc().addDirectory(path);
        addedPaths.push(path);
      }
    } finally {
      if (addedPaths.length > 0) {
        await qc.invalidateQueries({ queryKey: queryKeys.directories });
      }
    }
    notify(`${paths.length}個のディレクトリを追加しました`, "success");

    const result = await ipc().scanDirectories();
    await invalidateLibraryData(qc);

    const hasNew =
      result.totalNew > 0 || result.totalUpdated > 0 || result.totalReprocessed > 0;
    if (hasNew) {
      await ipc().generateThumbnails();
      await invalidateLibraryData(qc);
    }
    // スキャン・サムネイル生成の完了トーストは main の進捗イベント側から出る
  } catch (e) {
    console.error("Error adding directory:", e);
    const partial =
      addedPaths.length > 0 ? `（${addedPaths.length}件は追加済み）` : "";
    notify(
      `ディレクトリの追加に失敗しました${partial} (${messageOf(e as Error)})`,
      "error",
    );
  }
}

/** 登録済みディレクトリの包括スキャン（差分検出） */
export async function scanDirectoriesFlow(deps: OperationDeps): Promise<void> {
  const { qc } = deps;
  try {
    const result = await ipc().scanDirectories();
    await invalidateLibraryData(qc);

    const shouldGenerateThumbnails =
      result.totalNew > 0 || result.totalUpdated > 0 || result.totalReprocessed > 0;
    if (shouldGenerateThumbnails) {
      await ipc().generateThumbnails();
      await invalidateLibraryData(qc);
    }
    // スキャン・サムネイル生成の完了トーストは main の進捗イベント側から出る
  } catch (e) {
    console.error("Error scanning directories:", e);
    deps.notify(`スキャンに失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** サムネイルが無い動画への生成 */
export async function generateThumbnailsOp(deps: OperationDeps): Promise<void> {
  const { qc } = deps;
  try {
    await ipc().generateThumbnails();
    await invalidateLibraryData(qc);
    // 完了トーストは main の進捗イベント側から出る
  } catch (e) {
    console.error("Error generating thumbnails:", e);
    deps.notify(`サムネイル生成に失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** 全サムネイル再生成 */
export async function regenerateAllThumbnailsOp(deps: OperationDeps): Promise<void> {
  const { qc } = deps;
  try {
    await ipc().regenerateAllThumbnails();
    await invalidateLibraryData(qc);
    // 完了トーストは main の進捗イベント側から出る
  } catch (e) {
    console.error("Error regenerating thumbnails:", e);
    deps.notify(`サムネイル再生成に失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** 不要サムネイル削除 */
export async function cleanupThumbnailsOp(deps: OperationDeps): Promise<void> {
  const { notify } = deps;
  try {
    const result = await ipc().cleanupThumbnails();
    notify(
      `不要な画像を削除しました (${result.removedFiles}件, ${formatSize(result.totalSize)})`,
      "success",
    );
  } catch (e) {
    console.error("Error cleaning up thumbnails:", e);
    notify(`不要な画像の削除に失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** 全動画の強制再スキャン（サムネイル自動生成付き） */
export async function rescanAllFlow(deps: OperationDeps): Promise<void> {
  const { notify, qc } = deps;
  try {
    // main 側の rescan-all-videos ハンドラは、再スキャン本体だけでなく
    // その後の自動サムネイル生成まで完了してから resolve する。
    // 進捗と完了トーストは main の進捗イベント側から出るため、ここでは
    // データの再取得だけを行う（以前は中間通知用の setTimeout を挟んでいた）。
    await ipc().rescanAllVideos();
    await invalidateLibraryData(qc);
  } catch (e) {
    console.error("Error rescanning all videos:", e);
    notify(`全動画再スキャンに失敗しました (${messageOf(e as Error)})`, "error");
  }
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"] as const;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
