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
      openPlayer: (videoId) => setPlayerVideoId(videoId),
      closePlayer: () => setPlayerVideoId(null),

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
    scanLocked,
    sidebarCollapsed,
    runScanExclusive,
    toggleSidebarCollapsed,
    registerEnsure,
    ensureRendered,
  ]);

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi must be used within UiProvider");
  return ctx;
}
