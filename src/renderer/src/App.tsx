/**
 * アプリケーションルート。
 * プロバイダの構成、レイアウト、グローバルキーボード操作、起動時処理を担う。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "./api/ipc";
import { addDirectoriesFlow, removeDirectoryFlow } from "./api/operations";
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
import type { Video } from "./types";

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

  const allVideos = videosQuery.data ?? [];

  // フィルタ + ソート済みの一覧（キーボードナビゲーションとも共有する）
  const visibleVideos = useMemo(() => {
    // availableDirectories が空ならディレクトリフィルタ自体が無効（旧 getFilterData 挙動）
    const effectiveCount = readStoredDirectoryCount();
    const filtered = filterVideos(allVideos, filters, effectiveCount, debouncedSearch);
    return sortVideos(filtered, sort);
  }, [allVideos, filters, debouncedSearch, sort]);

  // ディレクトリ一覧をフィルタ状態へ同期
  useEffect(() => {
    if (directoriesQuery.data === undefined) return;
    syncAvailableDirectories(directoriesQuery.data.map((directory) => directory.path));
  }, [directoriesQuery.data, syncAvailableDirectories]);

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

  // ウォッチャー由来の IPC イベントでキャッシュを更新する
  useEffect(() => {
    window.electronAPI.onVideoAdded((filePath) => {
      void qc.invalidateQueries({ queryKey: queryKeys.videos });
      notify(`新しい動画が追加されました: ${basename(filePath)}`, "success");
    });
    window.electronAPI.onVideoRemoved((filePath) => {
      void qc.invalidateQueries({ queryKey: queryKeys.videos });
      notify(`動画が削除されました: ${basename(filePath)}`, "info");
    });
    window.electronAPI.onDirectoryRemoved((dirPath) => {
      void Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.directories }),
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
      ]);
      notify(`ディレクトリが削除されました: ${basename(dirPath)}`, "warning");
    });
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

  // 起動時処理: 存在しないディレクトリの除外 + 不完全サムネイルの補完
  useEffect(() => {
    if (startupRanRef.current) return;
    const directories = directoriesQuery.data;
    if (directories === undefined) return;

    startupRanRef.current = true;
    const deps = { qc, notify };

    void (async () => {
      const removed: string[] = [];
      for (const directory of directories) {
        try {
          const exists = await ipc().checkDirectoryExists(directory.path);
          if (!exists) {
            await removeDirectoryFlow(deps, directory.path);
            removed.push(directory.path);
          }
        } catch (e) {
          console.warn("Failed to check directory existence:", directory.path, e);
        }
      }
      if (removed.length > 0) {
        await qc.invalidateQueries({ queryKey: queryKeys.directories });
        await qc.invalidateQueries({ queryKey: queryKeys.videos });
        if (removed.length === 1) {
          notify(`削除されたディレクトリをアプリから除外しました: ${basename(removed[0] ?? "")}`, "warning");
        } else {
          notify(`${removed.length}個の削除されたディレクトリをアプリから除外しました`, "warning");
        }
      }

      // 不完全なサムネイルをバックグラウンドで補完
      try {
        const result = await ipc().generateIncompleteThumbnails();
        if (result.total > 0) {
          await qc.invalidateQueries({ queryKey: queryKeys.videos });
          notify(`不完全なサムネイルを補完しました (${result.generated}/${result.total})`, "info");
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
