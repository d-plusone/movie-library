/**
 * アプリケーションルート。
 * プロバイダの構成、レイアウト、グローバルキーボード操作、起動時処理を担う。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "./api/ipc";
import { addDirectoriesFlow } from "./api/operations";
import { filterVideos, sortVideos, readStoredDirectoryCount } from "./lib/filters";
import { useDebouncedValue } from "./lib/hooks";
import { FilterProvider, useFilters } from "./state/FilterContext";
import { NotifyProvider, useNotify } from "./state/NotificationContext";
import { ProgressProvider } from "./state/ProgressContext";
import { ThemeProvider } from "./state/ThemeContext";
import { UiProvider, useUi } from "./state/UiContext";
import { BulkTagModal } from "./components/BulkTagModal";
import { ChapterDialog } from "./components/ChapterDialog";
import { CustomThumbnailDialog } from "./components/CustomThumbnailDialog";
import { DetailsPanel } from "./components/DetailsPanel";
import { DuplicatesModal } from "./components/DuplicatesModal";
import { Header } from "./components/Header";
import { PlayerModal } from "./components/PlayerModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { TagEditDialog } from "./components/TagEditDialog";
import { Toasts } from "./components/Toasts";
import { ProgressOverlay } from "./components/ProgressOverlay";
import { VideoArea } from "./components/VideoArea";
import type { DirectoryStatus, Video } from "./types";

/** グリッドの 1 行あたり表示数を測定する（旧 calculateVideosPerRow の移植） */
function measureVideosPerRow(container: HTMLDivElement): number {
  const items = container.querySelectorAll<HTMLElement>(".video-item");
  if (items.length === 0) return 4;
  const itemWidth = items[0]!.offsetWidth + 20; // margin 込み
  return Math.floor(container.clientWidth / itemWidth) || 1;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function Shell() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();
  const filterState = useFilters();
  const { filters, sort, search, view } = filterState;

  const listRef = useRef<HTMLDivElement | null>(null);
  const startupRanRef = useRef(false);
  /** 接続エラーを通知済みのディレクトリ（起動時処理との二重通知を防ぐ） */
  const offlineNotifiedRef = useRef<Set<string>>(new Set());

  const debouncedSearch = useDebouncedValue(search, 200);
  const syncAvailableDirectories = filterState.syncAvailableDirectories;

  const videosQuery = useQuery({
    queryKey: queryKeys.videos,
    queryFn: () => ipc().getVideos(),
    staleTime: Infinity,
  });
  const directoriesQuery = useQuery({
    queryKey: queryKeys.directories,
    queryFn: () => ipc().getDirectories(),
    staleTime: Infinity,
  });
  const directoryStatusesQuery = useQuery({
    queryKey: queryKeys.directoryStatuses,
    queryFn: () => ipc().getDirectoryStatuses(),
    staleTime: Infinity,
  });

  const allVideos = videosQuery.data ?? [];

  // フィルタ + ソート済みの一覧（キーボードナビゲーションとも共有する）
  const visibleVideos = useMemo(() => {
    // availableDirectories が空ならディレクトリフィルタ自体が無効（旧 getFilterData 挙動）
    const effectiveCount = readStoredDirectoryCount();
    const filtered = filterVideos(allVideos, filters, effectiveCount, debouncedSearch);
    return sortVideos(filtered, sort);
  }, [allVideos, filters, debouncedSearch, sort]);

  // ディレクトリ一覧と接続状態をフィルタ状態へ同期。
  // 接続エラー中のディレクトリは選択対象から外れ（復帰時に自動で戻る）、フィルタは非活性になる
  useEffect(() => {
    if (directoriesQuery.data === undefined) return;
    const statuses = directoryStatusesQuery.data ?? {};
    const paths = directoriesQuery.data.map((directory) => directory.path);
    const unavailablePaths = paths.filter(
      (path) => statuses[path] === "offline",
    );
    syncAvailableDirectories(paths, unavailablePaths);
  }, [
    directoriesQuery.data,
    directoryStatusesQuery.data,
    syncAvailableDirectories,
  ]);

  const playVideo = useCallback(
    (video: Video): void => {
      const mode = localStorage.getItem("playbackMode") ?? "internal";
      if (mode === "external") {
        void ipc().openVideo(video.path);
      } else {
        ui.openPlayer(video.id);
      }
    },
    [ui],
  );

  // ウォッチャー由来の IPC イベントでキャッシュを更新する。
  // 追加・削除の完了トーストは main の進捗イベント（ProgressContext）側から出る
  useEffect(() => {
    window.electronAPI.onVideoAdded(() => {
      void qc.invalidateQueries({ queryKey: queryKeys.videos });
    });
    window.electronAPI.onVideoRemoved(() => {
      void qc.invalidateQueries({ queryKey: queryKeys.videos });
    });
  }, [qc]);

  // NAS（SMB 共有）の接続エラー / 再接続の通知。
  // 切断中も登録は維持される（main 側が接続エラーとして保持し再接続を試行する）
  useEffect(() => {
    const handler = (data: DirectoryStatus): void => {
      void qc.invalidateQueries({ queryKey: queryKeys.directoryStatuses });
      if (data.status === "offline") {
        if (offlineNotifiedRef.current.has(data.path)) return;
        offlineNotifiedRef.current.add(data.path);
        notify(
          `フォルダに接続できません（再接続を試行中）: ${basename(data.path)}`,
          "warning",
        );
        return;
      }
      // 初回確認（previousStatus なし）では通知しない
      if (data.previousStatus !== "offline") return;
      offlineNotifiedRef.current.delete(data.path);
      notify(`フォルダに再接続しました: ${basename(data.path)}`, "success");
      // 切断中に増えたファイルを取り込むには再スキャンが必要
      void qc.invalidateQueries({ queryKey: queryKeys.videos });
    };
    window.electronAPI.onDirectoryStatusChanged(handler);
    return () => {
      window.electronAPI.offDirectoryStatusChanged(handler);
    };
  }, [qc, notify]);

  // ネイティブメニュー（Cmd+, / Cmd+O）からの IPC イベント
  useEffect(() => {
    window.electronAPI.onOpenSettings(() => {
      ui.setSettingsOpen(true);
    });
    window.electronAPI.onOpenAddDirectory(() => {
      void ui.runScanExclusive(async () => {
        await addDirectoriesFlow({ qc, notify });
      });
    });
  }, [ui, qc, notify]);

  // 起動時処理: 接続できないフォルダの通知 + 不完全サムネイルの補完。
  // NAS の切断中でも登録は削除しない（main 側がオフラインとして保持し再接続を試行する）
  useEffect(() => {
    if (startupRanRef.current) return;
    const directories = directoriesQuery.data;
    if (directories === undefined) return;

    startupRanRef.current = true;

    void (async () => {
      try {
        const statuses = await ipc().getDirectoryStatuses();
        const newlyOffline = directories.filter(
          (directory) =>
            statuses[directory.path] === "offline" &&
            !offlineNotifiedRef.current.has(directory.path),
        );
        for (const directory of newlyOffline) {
          offlineNotifiedRef.current.add(directory.path);
        }
        if (newlyOffline.length === 1) {
          notify(
            `フォルダに接続できません（再接続を試行中）: ${basename(newlyOffline[0]!.path)}`,
            "warning",
          );
        } else if (newlyOffline.length > 1) {
          notify(
            `${newlyOffline.length}個のフォルダに接続できません（再接続を試行中）`,
            "warning",
          );
        }
      } catch (e) {
        console.warn("Failed to check directory availability:", e);
      }

      // 不完全なサムネイルをバックグラウンドで補完
      // （完了トーストは main の進捗イベント（ProgressContext）側から出る）
      try {
        const result = await ipc().generateIncompleteThumbnails();
        if (result.generated > 0) {
          await qc.invalidateQueries({ queryKey: queryKeys.videos });
        }
      } catch (e) {
        console.error("Error during incomplete thumbnail generation:", e);
      }
    })();
  }, [directoriesQuery.data, qc, notify]);

  // グローバルキーボード操作（Esc / Enter / Space / 矢印）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      // Esc: 開いている UI を優先度順に閉じる
      if (e.key === "Escape") {
        if (ui.playerVideoId !== null) {
          ui.closePlayer();
          return;
        }
        if (ui.chapterRequest !== null) {
          ui.closeChapter();
          return;
        }
        if (ui.customThumbVideoId !== null) {
          ui.closeCustomThumb();
          return;
        }
        if (ui.tagEditName !== null) {
          ui.closeTagEdit();
          return;
        }
        if (ui.detailsVideoId !== null) {
          ui.closeDetails();
        }
        return;
      }

      // モーダル中はグリッドナビゲーションを行わない
      if (ui.anyModalOpen) return;

      const videos = visibleVideos;
      if (videos.length === 0) return;

      if (e.key === "Enter") {
        const current = videos[ui.selectedIndex];
        if (current !== undefined) playVideo(current);
        return;
      }
      if (e.key === " ") {
        const current = videos[ui.selectedIndex];
        if (current !== undefined) ui.openDetails(current.id);
        return;
      }

      if (
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight"
      ) {
        return;
      }

      // --- 矢印ナビゲーション ---
      e.preventDefault();

      const total = videos.length;
      const currentIndex = ui.selectedIndex >= 0 ? ui.selectedIndex : 0;
      let nextIndex = currentIndex;

      if (view === "grid" && listRef.current !== null) {
        const perRow = measureVideosPerRow(listRef.current);
        const row = Math.floor(currentIndex / perRow);
        const col = currentIndex % perRow;
        const rows = Math.ceil(total / perRow);

        switch (e.key) {
          case "ArrowUp":
            nextIndex =
              row > 0 ? currentIndex - perRow : Math.min((rows - 1) * perRow + col, total - 1);
            break;
          case "ArrowDown":
            nextIndex =
              row < rows - 1
                ? Math.min(currentIndex + perRow, total - 1)
                : col < total
                  ? col
                  : 0;
            break;
          case "ArrowLeft":
            nextIndex = currentIndex > 0 ? currentIndex - 1 : total - 1;
            break;
          case "ArrowRight":
            nextIndex = currentIndex < total - 1 ? currentIndex + 1 : 0;
            break;
        }
      } else {
        switch (e.key) {
          case "ArrowUp":
          case "ArrowLeft":
            nextIndex = currentIndex > 0 ? currentIndex - 1 : total - 1;
            break;
          case "ArrowDown":
          case "ArrowRight":
            nextIndex = currentIndex < total - 1 ? currentIndex + 1 : 0;
            break;
        }
      }

      if (nextIndex === currentIndex) return;

      ui.setSelectedIndex(nextIndex);
      ui.ensureRendered(nextIndex);

      // 選択項目が見える位置へスクロールする
      const container = listRef.current;
      if (container !== null) {
        const items = container.querySelectorAll<HTMLElement>(".video-item");
        const selectedItem = items[nextIndex];
        if (selectedItem !== undefined) {
          const containerRect = container.getBoundingClientRect();
          const itemRect = selectedItem.getBoundingClientRect();
          if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
            const targetTop =
              selectedItem.offsetTop - container.clientHeight / 2 + selectedItem.offsetHeight / 2;
            container.scrollTo({ top: targetTop, behavior: "smooth" });
          }
        }
      }

      // 詳細パネルが開いている場合は内容も追従させる
      if (ui.detailsVideoId !== null) {
        const nextVideo = videos[nextIndex];
        if (nextVideo !== undefined) ui.openDetails(nextVideo.id);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ui, view, visibleVideos, playVideo]);

  return (
    <div id="app">
      <Header />
      <main className="main-content">
        <Sidebar />
        <VideoArea videos={visibleVideos} listRef={listRef} />
        <DetailsPanel />
      </main>

      {/* モーダル群 */}
      <PlayerModal />
      <SettingsModal />
      <BulkTagModal videos={visibleVideos} />
      <DuplicatesModal />
      <ChapterDialog />
      <CustomThumbnailDialog />
      <TagEditDialog />

      <Toasts />
      <ProgressOverlay />
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <NotifyProvider>
        <ProgressProvider>
          <FilterProvider>
            <UiProvider>
              <Shell />
            </UiProvider>
          </FilterProvider>
        </ProgressProvider>
      </NotifyProvider>
    </ThemeProvider>
  );
}
