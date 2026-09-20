/**
 * アプリ全体の UI 状態: モーダル開閉・選択・スキャン排他ロック
 * （旧 app.ts の各モーダル表示状態と isScanOperationInProgress の移植）
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

export interface ChapterRequest {
  videoId: number;
  startIndex: number;
}

interface UiContextValue {
  /** 詳細パネルに表示中の動画 ID（null は閉じている） */
  detailsVideoId: number | null;
  openDetails: (videoId: number) => void;
  closeDetails: () => void;

  playerVideoId: number | null;
  openPlayer: (videoId: number) => void;
  closePlayer: () => void;
  playlistVideoIds: readonly number[];
  openPlaylist: (videoIds: number[]) => void;
  playPlaylistVideo: (videoId: number) => void;
  clearPlaylist: () => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  duplicatesOpen: boolean;
  setDuplicatesOpen: (open: boolean) => void;

  bulkTagOpen: boolean;
  setBulkTagOpen: (open: boolean) => void;

  chapterRequest: ChapterRequest | null;
  openChapter: (request: ChapterRequest) => void;
  closeChapter: () => void;

  customThumbVideoId: number | null;
  openCustomThumb: (videoId: number) => void;
  closeCustomThumb: () => void;

  tagEditName: string | null;
  openTagEdit: (name: string) => void;
  closeTagEdit: () => void;

  /** 拡張子チェックモーダルの開閉状態（ContainerCheckModal が自身の状態を反映する） */
  containerCheckOpen: boolean;
  setContainerCheckOpen: (open: boolean) => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  scanPreviewOpen: boolean;
  setScanPreviewOpen: (open: boolean) => void;

  continueWatchingOpen: boolean;
  setContinueWatchingOpen: (open: boolean) => void;

  /** キーボードナビゲーション用の選択インデックス */
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;

  /** 一括操作の対象として選択中の動画 ID */
  selectedVideoIds: ReadonlySet<number>;
  /** 選択された動画の順序（プレイリスト再生順） */
  selectedVideoOrder: readonly number[];
  toggleVideoSelection: (videoId: number) => void;
  setVideoSelection: (videoIds: number[]) => void;
  reorderVideoSelection: (videoId: number, targetVideoId: number) => void;
  clearVideoSelection: () => void;
  retainVideoSelection: (videoIds: readonly number[]) => void;

  /** 段階描画リストの未描画範囲を描画させる（VideoArea が実装を登録する） */
  ensureRendered: (index: number) => void;
  registerEnsure: (fn: ((index: number) => void) | null) => void;

  /** サイドバー開閉状態 */
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;

  /** スキャン系操作の排他。実行中に呼ぶと通知して拒否される */
  scanLocked: boolean;
  runScanExclusive: (operation: () => Promise<void>) => Promise<void>;

  /** ナビゲーションを止めるべきモーダルが開いているか */
  anyModalOpen: boolean;
}

const UiContext = createContext<UiContextValue | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [detailsVideoId, setDetailsVideoId] = useState<number | null>(null);
  const [playerVideoId, setPlayerVideoId] = useState<number | null>(null);
  const [playlistVideoIds, setPlaylistVideoIds] = useState<number[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [chapterRequest, setChapterRequest] = useState<ChapterRequest | null>(null);
  const [customThumbVideoId, setCustomThumbVideoId] = useState<number | null>(null);
  const [tagEditName, setTagEditName] = useState<string | null>(null);
  const [containerCheckOpen, setContainerCheckOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [scanPreviewOpen, setScanPreviewOpen] = useState(false);
  const [continueWatchingOpen, setContinueWatchingOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [selectedVideoOrder, setSelectedVideoOrder] = useState<number[]>([]);
  const [scanLocked, setScanLocked] = useState(false);
  const scanLockRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("sidebarCollapsed") === "true",
  );

  const ensureRef = useRef<((index: number) => void) | null>(null);
  const registerEnsure = useCallback((fn: ((index: number) => void) | null) => {
    ensureRef.current = fn;
  }, []);
  const ensureRendered = useCallback((index: number) => {
    ensureRef.current?.(index);
  }, []);

  const selectedVideoIds = useMemo(
    () => new Set(selectedVideoOrder),
    [selectedVideoOrder],
  );

  const openPlayer = useCallback((videoId: number): void => {
    setPlaylistVideoIds([]);
    setPlayerVideoId(videoId);
  }, []);

  const closePlayer = useCallback((): void => {
    setPlaylistVideoIds([]);
    setPlayerVideoId(null);
  }, []);

  const openPlaylist = useCallback((videoIds: number[]): void => {
    const uniqueIds = [...new Set(videoIds)];
    const firstVideoId = uniqueIds[0];
    if (firstVideoId === undefined) return;
    setPlaylistVideoIds(uniqueIds);
    setPlayerVideoId(firstVideoId);
  }, []);

  const playPlaylistVideo = useCallback((videoId: number): void => {
    setPlayerVideoId(videoId);
  }, []);

  const clearPlaylist = useCallback((): void => {
    setPlaylistVideoIds([]);
  }, []);

  const toggleVideoSelection = useCallback((videoId: number): void => {
    setSelectedVideoOrder((current) => {
      if (current.includes(videoId)) {
        return current.filter((id) => id !== videoId);
      }
      return [...current, videoId];
    });
  }, []);

  const setVideoSelection = useCallback((videoIds: number[]): void => {
    setSelectedVideoOrder([...new Set(videoIds)]);
  }, []);

  const reorderVideoSelection = useCallback((videoId: number, targetVideoId: number): void => {
    setSelectedVideoOrder((current) => {
      const fromIndex = current.indexOf(videoId);
      const targetIndex = current.indexOf(targetVideoId);
      if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return current;
      const next = [...current];
      next.splice(fromIndex, 1);
      next.splice(fromIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, videoId);
      return next;
    });
  }, []);

  const clearVideoSelection = useCallback((): void => {
    setSelectedVideoOrder((current) => (current.length === 0 ? current : []));
  }, []);

  const retainVideoSelection = useCallback((videoIds: readonly number[]): void => {
    const allowed = new Set(videoIds);
    setSelectedVideoOrder((current) => {
      const next = current.filter((id) => allowed.has(id));
      return next.length === current.length ? current : next;
    });
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      localStorage.setItem("sidebarCollapsed", String(!current));
      return !current;
    });
  }, []);

  const runScanExclusive = useCallback(async (operation: () => Promise<void>) => {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    setScanLocked(true);
    try {
      await operation();
    } finally {
      scanLockRef.current = false;
      setScanLocked(false);
    }
  }, []);

  const value = useMemo<UiContextValue>(() => {
    const anyModalOpen =
      playerVideoId !== null ||
      settingsOpen ||
      duplicatesOpen ||
      bulkTagOpen ||
      chapterRequest !== null ||
      customThumbVideoId !== null ||
      tagEditName !== null ||
      containerCheckOpen ||
      commandPaletteOpen ||
      scanPreviewOpen ||
      continueWatchingOpen;

    return {
      detailsVideoId,
      openDetails: (videoId) => setDetailsVideoId(videoId),
      closeDetails: () => setDetailsVideoId(null),

      playerVideoId,
      openPlayer,
      closePlayer,
      playlistVideoIds,
      openPlaylist,
      playPlaylistVideo,
      clearPlaylist,

      settingsOpen,
      setSettingsOpen,
      duplicatesOpen,
      setDuplicatesOpen,
      bulkTagOpen,
      setBulkTagOpen,

      chapterRequest,
      openChapter: (request) => setChapterRequest(request),
      closeChapter: () => setChapterRequest(null),

      customThumbVideoId,
      openCustomThumb: (videoId) => setCustomThumbVideoId(videoId),
      closeCustomThumb: () => setCustomThumbVideoId(null),

      tagEditName,
      openTagEdit: (name) => setTagEditName(name),
      closeTagEdit: () => setTagEditName(null),

      containerCheckOpen,
      setContainerCheckOpen,
      commandPaletteOpen,
      setCommandPaletteOpen,
      scanPreviewOpen,
      setScanPreviewOpen,
      continueWatchingOpen,
      setContinueWatchingOpen,

      selectedIndex,
      setSelectedIndex,

      selectedVideoIds,
      selectedVideoOrder,
      toggleVideoSelection,
      setVideoSelection,
      reorderVideoSelection,
      clearVideoSelection,
      retainVideoSelection,

      ensureRendered,
      registerEnsure,

      sidebarCollapsed,
      toggleSidebarCollapsed,

      scanLocked,
      runScanExclusive,

      anyModalOpen,
    };
  }, [
    detailsVideoId,
    playerVideoId,
    playlistVideoIds,
    openPlayer,
    closePlayer,
    openPlaylist,
    playPlaylistVideo,
    clearPlaylist,
    settingsOpen,
    duplicatesOpen,
    bulkTagOpen,
    chapterRequest,
    customThumbVideoId,
    tagEditName,
    containerCheckOpen,
    commandPaletteOpen,
    scanPreviewOpen,
    continueWatchingOpen,
    selectedIndex,
    selectedVideoIds,
    selectedVideoOrder,
    scanLocked,
    sidebarCollapsed,
    runScanExclusive,
    toggleSidebarCollapsed,
    registerEnsure,
    ensureRendered,
    toggleVideoSelection,
    setVideoSelection,
    reorderVideoSelection,
    clearVideoSelection,
    retainVideoSelection,
  ]);

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi must be used within UiProvider");
  return ctx;
}
