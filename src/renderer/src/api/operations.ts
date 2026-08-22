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
  try {
    const paths = await ipc().chooseDirectory();
    if (paths.length === 0) return;

    for (const path of paths) {
      await ipc().addDirectory(path);
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

    if (hasNew) {
      const details: string[] = [];
      if (result.totalNew > 0) details.push(`新規: ${result.totalNew}件`);
      if (result.totalUpdated > 0) details.push(`更新: ${result.totalUpdated}件`);
      if (result.totalReprocessed > 0) details.push(`再処理: ${result.totalReprocessed}件`);
      notify(`スキャンが完了しました (${details.join(", ")})。サムネイルも生成しました`, "success");
    } else {
      notify("新しい動画は見つかりませんでした", "info");
    }
  } catch (e) {
    console.error("Error adding directory:", e);
    notify(`ディレクトリの追加に失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** 登録済みディレクトリの包括スキャン（差分検出） */
export async function scanDirectoriesFlow(deps: OperationDeps): Promise<void> {
  const { notify, qc } = deps;
  try {
    const result = await ipc().scanDirectories();
    await invalidateLibraryData(qc);

    const shouldGenerateThumbnails =
      result.totalNew > 0 || result.totalUpdated > 0 || result.totalReprocessed > 0;
    if (shouldGenerateThumbnails) {
      await ipc().generateThumbnails();
      await invalidateLibraryData(qc);
    }

    const details: string[] = [];
    if (result.totalNew > 0) details.push(`新規: ${result.totalNew}件`);
    if (result.totalUpdated > 0) details.push(`更新: ${result.totalUpdated}件`);
    if (result.totalReprocessed > 0) details.push(`再処理: ${result.totalReprocessed}件`);
    if ((result.totalDeleted ?? 0) > 0) details.push(`削除: ${result.totalDeleted}件`);

    let message = "スキャンが完了しました";
    if (details.length > 0) message += ` (${details.join(", ")})`;
    if (shouldGenerateThumbnails) message += "。サムネイルも生成しました";
    notify(message, "success");
  } catch (e) {
    console.error("Error scanning directories:", e);
    notify(`スキャンに失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** サムネイルが無い動画への生成 */
export async function generateThumbnailsOp(deps: OperationDeps): Promise<void> {
  const { notify, qc } = deps;
  try {
    await ipc().generateThumbnails();
    await invalidateLibraryData(qc);
    notify("サムネイル生成が完了しました", "success");
  } catch (e) {
    console.error("Error generating thumbnails:", e);
    notify(`サムネイル生成に失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** 全サムネイル再生成 */
export async function regenerateAllThumbnailsOp(deps: OperationDeps): Promise<void> {
  const { notify, qc } = deps;
  try {
    await ipc().regenerateAllThumbnails();
    await invalidateLibraryData(qc);
    notify("サムネイル再生成が完了しました", "success");
  } catch (e) {
    console.error("Error regenerating thumbnails:", e);
    notify(`サムネイル再生成に失敗しました (${messageOf(e as Error)})`, "error");
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
    const result = await ipc().rescanAllVideos();
    await invalidateLibraryData(qc);

    const details: string[] = [];
    if ((result.totalProcessed ?? 0) > 0) details.push(`処理: ${result.totalProcessed}件`);
    if (result.totalUpdated > 0) details.push(`更新: ${result.totalUpdated}件`);
    if ((result.totalErrors ?? 0) > 0) details.push(`エラー: ${result.totalErrors}件`);

    let message = "再スキャン完了";
    if (details.length > 0) message += ` (${details.join(", ")})`;
    message += " - サムネイル生成中...";
    notify(message, (result.totalErrors ?? 0) > 0 ? "warning" : "info");

    // サムネイル生成は main 側で自動実行されるため、完了通知のみ遅延表示する
    window.setTimeout(() => {
      void invalidateLibraryData(qc).then(() => {
        notify("再スキャンとサムネイル生成が完了しました", "success");
      });
    }, 2000);
  } catch (e) {
    console.error("Error rescanning all videos:", e);
    notify(`全動画再スキャンに失敗しました (${messageOf(e as Error)})`, "error");
  }
}

/** ディレクトリ削除 */
export async function removeDirectoryFlow(deps: OperationDeps, path: string): Promise<boolean> {
  try {
    await ipc().removeDirectory(path);
    await invalidateLibraryData(deps.qc);
    deps.notify("ディレクトリを削除しました", "success");
    return true;
  } catch (e) {
    console.error("Error removing directory:", e);
    deps.notify(`ディレクトリの削除に失敗しました (${messageOf(e as Error)})`, "error");
    return false;
  }
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"] as const;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
