import { FilterManager } from "./FilterManager.js";
import { VideoManager } from "./VideoManager.js";
import { UIRenderer } from "./UIRenderer.js";
import {
  Video,
  Directory,
  ChapterThumbnail,
  SortState,
  BulkTagChange,
  DuplicateGroup,
} from "../types/types.js";
import {
  NotificationManager,
  ProgressManager,
  EnhancedProgressManager,
  UnifiedProgressManager,
  ThemeManager,
  KeyboardManager,
  FormatUtils,
  DOMUtils,
  Utils,
  setupModalFocusTrap,
  logger,
} from "./Utils.js";

// 型定義のみをimport（実行時importを避ける）
import type {} from "../types/electron";

// 完了通知の表示待機時間（サムネイル生成が非同期で実行されるため）
const THUMBNAIL_COMPLETION_NOTIFY_DELAY_MS = 2000;
// ファイル操作完了待ち時間（新規追加されたファイルの書き込み完了を待つ）
const FILE_WRITE_SETTLE_DELAY_MS = 1000;

declare global {
  interface Window {
    movieApp: MovieLibraryApp;
  }
}

/**
 * メインアプリケーションクラス
 * 各モジュールを統合し、イベントハンドリングを管理
 */
class MovieLibraryApp {
  // Core data
  private filteredVideos: Video[] = [];
  private currentVideo: Video | null = null;
  private currentSort: SortState = { field: "addedAt", order: "DESC" };
  private tagInputKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private isScanOperationInProgress = false;

  // Thumbnail and tooltip state
  private currentThumbnails: ChapterThumbnail[] = [];
  private currentThumbnailIndex: number = 0;
  private tooltipTimeout: NodeJS.Timeout | null = null;
  private tooltipInterval: NodeJS.Timeout | null = null;

  // Event delegation setup flag
  private eventDelegationSetup: boolean = false;

  // 検索入力のデバウンス済みハンドラ（1キーストロークごとの全件再描画を防ぐ）
  private debouncedSearchInput: (e: Event) => void = Utils.debounce(
    (e: Event) => this.handleSearchInput(e),
    200,
  );

  // Managers
  private filterManager: FilterManager;
  private videoManager: VideoManager;
  private uiRenderer: UIRenderer;
  private notificationManager: NotificationManager;
  private progressManager: ProgressManager; // 後方互換性のため残す
  private directoryCheckProgress: EnhancedProgressManager; // ディレクトリチェック用
  private thumbnailProgress: EnhancedProgressManager; // サムネイル生成用
  private scanProgress: EnhancedProgressManager; // スキャン用
  private unifiedProgress: UnifiedProgressManager; // 統一プログレス管理
  private themeManager: ThemeManager;
  private keyboardManager: KeyboardManager;

  constructor() {
    // Initialize managers
    this.filterManager = new FilterManager();
    this.videoManager = new VideoManager();
    this.uiRenderer = new UIRenderer();
    this.notificationManager = new NotificationManager();
    this.progressManager = new ProgressManager(); // 後方互換性のため残す
    this.directoryCheckProgress = new EnhancedProgressManager(
      "directory-check",
    );
    this.thumbnailProgress = new EnhancedProgressManager(
      "thumbnail-generation",
    );
    this.scanProgress = new EnhancedProgressManager("scanning");
    this.unifiedProgress = UnifiedProgressManager.getInstance();
    this.themeManager = new ThemeManager();

    // Initialize keyboard navigation
    this.keyboardManager = new KeyboardManager({
      onEscape: (e) => this.handleEscapeKey(e),
      onArrow: (e) => this.handleArrowKeys(e),
      onEnter: (e) => this.handleEnterKey(e),
      onSpace: (e) => this.handleSpaceKey(e),
    });

    // プログレスイベントリスナーを設定
    this.setupProgressEventListeners();

    // モーダルのフォーカストラップを有効化（アクセシビリティ）
    setupModalFocusTrap();

    this.initializeEventListeners();
    this.loadSettings(); // 設定を読み込み
    this.initializeThemeButton(); // テーマボタンの初期化
    this.initializeSidebarToggle(); // サイドバートグルの初期化

    this.loadInitialData().catch((error) => {
      console.error("Failed to load initial data:", error);
    });
  }

  // クリーンアップメソッド（keyboardManagerの参照を明示）
  public cleanup(): void {
    // KeyboardManagerのクリーンアップ（将来的に必要になった場合）
    if (this.keyboardManager) {
      // this.keyboardManager.cleanup(); // 将来的な実装
    }
  }

  // プログレスイベントリスナーを設定
  private setupProgressEventListeners(): void {
    try {
      // スキャンプログレスイベント
      window.electronAPI.onScanProgress((data) => {
        if (
          data &&
          typeof data === "object" &&
          data.current !== undefined &&
          data.total !== undefined
        ) {
          // スキャン専用のプログレスを更新
          if (!this.unifiedProgress.hasProgress("scan-progress")) {
            this.unifiedProgress.addProgress(
              "scan-progress",
              "ディレクトリをスキャン中",
              data.total,
            );
          } else {
            this.unifiedProgress.updateProgressTotal(
              "scan-progress",
              data.total,
            );
          }
          this.unifiedProgress.updateProgress(
            "scan-progress",
            data.current,
            `ディレクトリをスキャン中 (${data.current}/${data.total})`,
          );
        } else if (data && data.message) {
          // 完了メッセージの場合
          if (this.unifiedProgress.hasProgress("scan-progress")) {
            // 既存のプログレスを完了
            this.unifiedProgress.completeProgress("scan-progress");
          } else {
            // プログレスが存在しない場合は一時的に作成して即座に完了
            this.unifiedProgress.addProgress("scan-progress", data.message, 1);
            this.unifiedProgress.updateProgress(
              "scan-progress",
              1,
              data.message,
            );
            this.unifiedProgress.completeProgress("scan-progress");
          }
        }
      });

      // 再スキャンプログレスイベント
      window.electronAPI.onRescanProgress((data) => {
        if (
          data &&
          typeof data === "object" &&
          data.current !== undefined &&
          data.total !== undefined
        ) {
          // 再スキャン専用のプログレスを更新
          if (!this.unifiedProgress.hasProgress("settings-rescan-all")) {
            this.unifiedProgress.addOwnerProgress(
              "settings-rescan-all",
              "全ての動画を再スキャン中",
              data.total,
            );
          } else {
            this.unifiedProgress.updateProgressTotal(
              "settings-rescan-all",
              data.total,
            );
          }
          this.unifiedProgress.updateProgress(
            "settings-rescan-all",
            data.current,
            `全ての動画を再スキャン中 (${data.current}/${data.total})`,
          );
        } else if (data && data.message) {
          // 完了メッセージの場合
          if (this.unifiedProgress.hasProgress("settings-rescan-all")) {
            // 既存のプログレスを完了
            this.unifiedProgress.completeProgress("settings-rescan-all");
          } else {
            // プログレスが存在しない場合は一時的に作成して即座に完了
            this.unifiedProgress.addOwnerProgress(
              "settings-rescan-all",
              data.message,
              1,
            );
            this.unifiedProgress.updateProgress(
              "settings-rescan-all",
              1,
              data.message,
            );
            this.unifiedProgress.completeProgress("settings-rescan-all");
          }
        }
      });

      // サムネイル生成プログレスイベント
      window.electronAPI.onThumbnailProgress((data) => {
        if (
          data &&
          typeof data === "object" &&
          data.current !== undefined &&
          data.total !== undefined
        ) {
          // 設定画面からのサムネイル再生成かどうかをチェック
          if (this.unifiedProgress.hasProgress("settings-thumbnail-regen")) {
            // 設定画面からの再生成の場合 - 総数を動的に更新
            this.unifiedProgress.updateProgressTotal(
              "settings-thumbnail-regen",
              data.total,
            );
            this.unifiedProgress.updateProgress(
              "settings-thumbnail-regen",
              data.current,
              `全サムネイルを再生成中 (${data.current}/${data.total})`,
            );
          } else {
            // 通常のサムネイル生成の場合
            if (!this.unifiedProgress.hasProgress("thumbnail-progress")) {
              this.unifiedProgress.addProgress(
                "thumbnail-progress",
                "サムネイルを生成中",
                data.total,
              );
            } else {
              this.unifiedProgress.updateProgressTotal(
                "thumbnail-progress",
                data.total,
              );
            }
            this.unifiedProgress.updateProgress(
              "thumbnail-progress",
              data.current,
              `サムネイルを生成中 (${data.current}/${data.total})`,
            );
          }
        } else if (data && data.message) {
          // メッセージのみの場合は適切なプログレスを使用
          if (this.unifiedProgress.hasProgress("settings-thumbnail-regen")) {
            // 設定画面からの再生成完了
            this.unifiedProgress.completeProgress("settings-thumbnail-regen");
          } else if (this.unifiedProgress.hasProgress("thumbnail-progress")) {
            // 通常のサムネイル生成完了
            this.unifiedProgress.completeProgress("thumbnail-progress");
          } else {
            // プログレスが存在しない場合は一時的に作成して即座に完了
            this.unifiedProgress.addProgress(
              "thumbnail-progress",
              data.message,
              1,
            );
            this.unifiedProgress.updateProgress(
              "thumbnail-progress",
              1,
              data.message,
            );
            this.unifiedProgress.completeProgress("thumbnail-progress");
          }
        }
      });

      // ビデオ追加イベント
      window.electronAPI.onVideoAdded((filePath: string) => {
        logger.log("Video added:", filePath);
        this.handleVideoAdded(filePath);
      });

      // ビデオ削除イベント
      window.electronAPI.onVideoRemoved((filePath: string) => {
        logger.log("Video removed:", filePath);
        this.handleVideoRemoved(filePath);
      });

      // ディレクトリ削除イベント
      window.electronAPI.onDirectoryRemoved((dirPath: string) => {
        logger.log("Directory removed:", dirPath);
        this.handleDirectoryRemoved(dirPath);
      });

      // メニューからの設定イベント
      window.electronAPI.onOpenSettings(() => {
        logger.log("Open settings from menu");
        this.openSettingsModal();
      });

      // メニューからのディレクトリ追加イベント
      window.electronAPI.onOpenAddDirectory(() => {
        logger.log("Open add directory from menu");
        this.addDirectory();
      });
    } catch (error) {
      console.warn("Failed to setup progress event listeners:", error);
    }
  }

  // 安全にイベントリスナーを追加するメソッド
  private safeAddEventListener(
    elementId: string,
    event: string,
    handler: (e: Event) => void,
  ): boolean {
    const element = document.getElementById(elementId);

    if (element && handler) {
      element.addEventListener(event, handler);
      return true;
    } else {
      console.warn(
        `Failed to add event listener for ${elementId} - element found: ${!!element}, handler: ${!!handler}`,
      );
    }
    return false;
  }

  private initializeThemeButton(): void {
    const themeBtn = DOMUtils.getElementById("themeToggleBtn");
    if (themeBtn) {
      const icon = themeBtn.querySelector(".icon");
      if (icon) {
        const currentTheme = this.themeManager.getCurrentTheme();
        icon.textContent = currentTheme === "dark" ? "☀️" : "🌙";
      }
    }
  }

  private initializeSidebarToggle(): void {
    const sidebar = document.getElementById("sidebar");
    const toggleBtn = document.getElementById("sidebarToggleBtn");
    if (!sidebar || !toggleBtn) return;

    const collapsed = localStorage.getItem("sidebarCollapsed") === "true";
    if (collapsed) {
      sidebar.classList.add("collapsed");
      toggleBtn.classList.add("collapsed");
      toggleBtn.title = "サイドメニューを表示";
    }

    toggleBtn.addEventListener("click", () => {
      const isCollapsed = sidebar.classList.toggle("collapsed");
      toggleBtn.classList.toggle("collapsed", isCollapsed);
      toggleBtn.title = isCollapsed
        ? "サイドメニューを表示"
        : "サイドメニューを隠す";
      localStorage.setItem("sidebarCollapsed", String(isCollapsed));
    });
  }

  private async loadInitialData(): Promise<void> {
    let showedProgress = false;

    try {
      // Check if electronAPI is available
      if (!window.electronAPI) {
        throw new Error(
          "electronAPI is not available - preload script may not have loaded",
        );
      }

      logger.log("Starting initial data load...");
      logger.debug(
        "electronAPI methods available:",
        Object.keys(window.electronAPI || {}),
      );

      // データ読み込み（差分チェック付き）
      const videosPromise = this.videoManager.loadVideos();
      const tagsPromise = this.videoManager.loadTags();
      const directoriesPromise = this.videoManager.loadDirectories();

      // すべてのデータを並行読み込み
      const [videos, tags, directories] = await Promise.all([
        videosPromise,
        tagsPromise,
        directoriesPromise,
      ]);

      logger.log(
        `Loaded ${videos.length} videos, ${tags.length} tags, ${directories.length} directories`,
      );

      // 起動時のディレクトリ存在チェック（ディレクトリがある場合のみプログレス表示）
      if (directories.length > 0) {
        logger.debug(
          `Starting directory existence check for ${directories.length} directories`,
        );
        this.directoryCheckProgress.startProgress(
          directories.length,
          "ディレクトリをチェック中",
        );
        showedProgress = true;
        await this.checkDirectoriesExistence(directories);
        logger.debug(
          "Directory existence check completed, calling completeProgress",
        );
        this.directoryCheckProgress.completeProgress();
      }

      // FilterManagerにディレクトリ情報を初期化（初回のみ）
      this.filterManager.updateAvailableDirectories(directories);

      // 初期表示
      this.filteredVideos = [...videos];
      this.renderAll();

      // フィルターイベントリスナーを設定
      this.filterManager.onFilterChange((_filters) => {
        this.applyFiltersAndSort();
      });

      // 保存されたフィルタ状態を復元
      this.restoreFilterState();

      // UIの初期ソート設定を反映
      this.updateSortUI();

      logger.log("Initial data load completed successfully");

      // 不完全なサムネイルをバックグラウンドで補完生成
      this.checkAndGenerateIncompleteThumbnails();
    } catch (error) {
      console.error("Error loading initial data:", error);
      this.notificationManager.show("データの読み込みに失敗しました", "error");
    } finally {
      // プログレスバーを表示した場合のみ非表示にする
      // completeProgress()が既に実行されているので、追加のhideは不要
      logger.debug(
        "loadInitialData finally block: showedProgress =",
        showedProgress,
      );
    }
  }

  private renderAll(): void {
    this.uiRenderer.renderVideoList(this.filteredVideos, (path: string) =>
      this.playVideo(path),
    );
    this.uiRenderer.renderSidebar(
      this.videoManager.getTags(),
      this.videoManager.getDirectories(),
      this.filterManager.getCurrentFilter(),
      this.filterManager.getSelectedDirectories(),
    );
    this.uiRenderer.updateStats(this.videoManager.getStats());
  }

  private checkAndGenerateIncompleteThumbnails(): void {
    this.videoManager
      .generateIncompleteThumbnails()
      .then((result) => {
        if (result.total > 0) {
          logger.log(
            `Incomplete thumbnail generation: ${result.generated}/${result.total} processed`,
          );
          // サムネイル補完後に動画リストを再読み込みして表示を更新
          this.videoManager.loadVideos(true).then(() => {
            this.filteredVideos = [...this.videoManager.getVideos()];
            this.applyFiltersAndSort();
          });
        }
      })
      .catch((error) => {
        console.error("Error during incomplete thumbnail generation:", error);
      });
  }

  private async applyFiltersAndSort(): Promise<void> {
    try {
      const filterData = this.filterManager.getFilterData();

      // フィルタリング
      this.filteredVideos = this.videoManager.getVideos().filter((video) => {
        // レーティングフィルター
        if (filterData.ratingFilter > 0) {
          if ((video.rating || 0) < filterData.ratingFilter) return false;
        }

        // タグフィルター
        if (filterData.selectedTags.length > 0) {
          const videoTags = video.tags || [];
          const hasMatchingTag = filterData.selectedTags.some((tag: string) =>
            videoTags.includes(tag),
          );
          if (!hasMatchingTag) return false;
        }

        // ディレクトリフィルター
        if (filterData.hasDirectoryFilter) {
          if (filterData.selectedDirectories.length === 0) {
            // ディレクトリが明示的に全解除された場合は何も表示しない
            return false;
          } else {
            // 選択されたディレクトリのいずれかに属するかチェック（サブフォルダも含む、正確な境界判定）
            const hasMatchingDirectory = filterData.selectedDirectories.some(
              (dir: string) => {
                // パスを正規化して比較
                const normalizedVideoPath = video.path.replace(/\\/g, "/");
                const normalizedDir = dir.replace(/\\/g, "/");

                // ディレクトリ末尾のスラッシュを統一
                const dirWithSlash = normalizedDir.endsWith("/")
                  ? normalizedDir
                  : normalizedDir + "/";

                // 1. 完全一致（ディレクトリ直下のファイル）
                const videoDir = normalizedVideoPath.substring(
                  0,
                  normalizedVideoPath.lastIndexOf("/") + 1,
                );
                if (videoDir === dirWithSlash) {
                  return true;
                }

                // 2. サブディレクトリ内のファイル（正確な境界チェック）
                return normalizedVideoPath.startsWith(dirWithSlash);
              },
            );
            if (!hasMatchingDirectory) return false;
          }
        }

        // 検索クエリフィルター
        if (filterData.searchQuery) {
          const searchLower = filterData.searchQuery.toLowerCase();
          const matchesSearch =
            video.title.toLowerCase().includes(searchLower) ||
            video.filename.toLowerCase().includes(searchLower) ||
            (video.description &&
              video.description.toLowerCase().includes(searchLower)) ||
            (video.tags &&
              video.tags.some((tag) =>
                tag.toLowerCase().includes(searchLower),
              ));
          if (!matchesSearch) return false;
        }

        return true;
      });

      // ソート
      this.filteredVideos.sort((a, b) => {
        let aValue = a[this.currentSort.field as keyof Video];
        let bValue = b[this.currentSort.field as keyof Video];

        // Null値の処理
        if (aValue == null && bValue == null) return 0;
        if (aValue == null) return this.currentSort.order === "ASC" ? -1 : 1;
        if (bValue == null) return this.currentSort.order === "ASC" ? 1 : -1;

        // Date型の比較（作成日、追加日等）
        if (aValue instanceof Date && bValue instanceof Date) {
          const comparison = aValue.getTime() - bValue.getTime();
          return this.currentSort.order === "ASC" ? comparison : -comparison;
        }

        // bigint型の比較（sizeフィールド用）
        if (typeof aValue === "bigint" && typeof bValue === "bigint") {
          if (aValue < bValue) {
            return this.currentSort.order === "ASC" ? -1 : 1;
          }
          if (aValue > bValue) {
            return this.currentSort.order === "ASC" ? 1 : -1;
          }
          return 0;
        }

        // 数値比較
        if (typeof aValue === "number" && typeof bValue === "number") {
          return this.currentSort.order === "ASC"
            ? aValue - bValue
            : bValue - aValue;
        }

        // 文字列比較
        if (typeof aValue === "string" && typeof bValue === "string") {
          const comparison = aValue.localeCompare(bValue);
          return this.currentSort.order === "ASC" ? comparison : -comparison;
        }

        // その他の型の場合は文字列として比較
        const aStr = String(aValue);
        const bStr = String(bValue);
        const comparison = aStr.localeCompare(bStr);
        return this.currentSort.order === "ASC" ? comparison : -comparison;
      });

      this.renderVideoList();
      this.renderSidebar(); // サイドバーも更新
    } catch (error) {
      console.error("Error applying filters and sort:", error);
    }
  }

  private renderVideoList(): void {
    this.uiRenderer.renderVideoList(this.filteredVideos, (path: string) =>
      this.playVideo(path),
    );
  }

  private renderSidebar(): void {
    const directories = this.videoManager.getDirectories();

    // 現在の選択状態を取得して表示に使用（状態の変更は行わない）
    const selectedDirectories = this.filterManager.getSelectedDirectories();

    this.uiRenderer.renderSidebar(
      this.videoManager.getTags(),
      directories,
      this.filterManager.getCurrentFilter(),
      selectedDirectories,
    );

    // 評価フィルタの表示を更新
    const currentRating = this.filterManager.getCurrentFilter().rating;
    this.updateRatingDisplay(currentRating);
  }

  // 保存されたフィルタ状態を復元
  private restoreFilterState(): void {
    try {
      // フィルタ状態保存が有効な場合のみ保存された状態を復元
      if (this.filterManager.isSaveFilterStateEnabled()) {
        // 検索クエリを復元
        const savedSearchQuery = localStorage.getItem("searchQuery");
        const searchInput = document.getElementById(
          "searchInput",
        ) as HTMLInputElement;
        if (searchInput && savedSearchQuery) {
          searchInput.value = savedSearchQuery;
        }
      }

      // フィルタとソートを適用（保存状態に関係なく実行）
      this.applyFiltersAndSort();
    } catch (error) {
      console.error("Error restoring filter state:", error);
    }
  }

  private initializeEventListeners(): void {
    logger.log("Initializing event listeners...");

    this.safeAddEventListener(
      "addDirectoryBtn",
      "click",
      this.addDirectory.bind(this),
    );
    this.safeAddEventListener(
      "scanDirectoriesBtn",
      "click",
      this.scanDirectories.bind(this),
    );
    this.safeAddEventListener(
      "generateThumbnailsBtn",
      "click",
      this.generateThumbnails.bind(this),
    );
    this.safeAddEventListener(
      "regenerateThumbnailsBtn",
      "click",
      this.regenerateAllThumbnails.bind(this),
    );
    this.safeAddEventListener(
      "cleanupThumbnailsBtn",
      "click",
      this.cleanupThumbnails.bind(this),
    );
    this.safeAddEventListener(
      "rescanAllBtn",
      "click",
      this.rescanAllVideos.bind(this),
    );
    // refreshBtn is not needed - data refresh is automatic
    this.safeAddEventListener(
      "themeToggleBtn",
      "click",
      this.toggleTheme.bind(this),
    );
    this.safeAddEventListener(
      "sortSelect",
      "change",
      this.handleSortChange.bind(this),
    );
    this.safeAddEventListener(
      "orderSelect",
      "change",
      this.handleSortChange.bind(this),
    );
    this.safeAddEventListener(
      "searchInput",
      "input",
      this.debouncedSearchInput,
    );
    this.safeAddEventListener(
      "searchClearBtn",
      "click",
      this.handleSearchClear.bind(this),
    );
    // Tag filter
    this.safeAddEventListener(
      "tagFilterInput",
      "input",
      this.handleTagFilterInput.bind(this),
    );
    this.safeAddEventListener(
      "tagFilterClearBtn",
      "click",
      this.handleTagFilterClear.bind(this),
    );
    // View controls
    this.safeAddEventListener("gridViewBtn", "click", () =>
      this.setView("grid"),
    );
    this.safeAddEventListener("listViewBtn", "click", () =>
      this.setView("list"),
    );

    // Settings-related event listeners
    this.safeAddEventListener(
      "settingsBtn",
      "click",
      this.openSettingsModal.bind(this),
    );
    this.safeAddEventListener(
      "saveSettingsBtn",
      "click",
      this.saveSettings.bind(this),
    );
    this.safeAddEventListener(
      "cancelSettingsBtn",
      "click",
      this.closeSettingsModal.bind(this),
    );
    this.safeAddEventListener(
      "closeSettingsBtn",
      "click",
      this.closeSettingsModal.bind(this),
    );
    this.safeAddEventListener(
      "addDirectorySettingsBtn",
      "click",
      this.addDirectory.bind(this),
    );

    // Bulk tag management
    this.safeAddEventListener(
      "bulkTagApplyBtn",
      "click",
      this.showBulkTagDialog.bind(this),
    );
    this.safeAddEventListener(
      "applyBulkTagsBtn",
      "click",
      this.applyBulkTags.bind(this),
    );
    this.safeAddEventListener("closeBulkTagApplyDialog", "click", () =>
      this.uiRenderer.hideBulkTagApplyDialog(),
    );
    this.safeAddEventListener("cancelBulkTagApplyBtn", "click", () =>
      this.uiRenderer.hideBulkTagApplyDialog(),
    );

    // Quick bulk tag input
    this.safeAddEventListener(
      "quickBulkTagApplyBtn",
      "click",
      this.applyQuickBulkTag.bind(this),
    );
    const quickBulkTagInput = document.getElementById("quickBulkTagInput");
    if (quickBulkTagInput) {
      quickBulkTagInput.addEventListener("keydown", (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") {
          this.applyQuickBulkTag();
        }
      });
    }

    // Duplicate detection
    this.safeAddEventListener(
      "findDuplicatesBtn",
      "click",
      this.findDuplicates.bind(this),
    );
    this.safeAddEventListener("closeDuplicateModal", "click", () =>
      this.closeDuplicateModal(),
    );
    this.safeAddEventListener("cancelDuplicateBtn", "click", () =>
      this.closeDuplicateModal(),
    );
    this.safeAddEventListener(
      "deleteDuplicatesBtn",
      "click",
      this.deleteDuplicates.bind(this),
    );

    // Event delegation for dynamic content
    this.setupEventDelegation();

    logger.log("Event listeners initialization completed");
  }

  private setupEventDelegation(): void {
    if (this.eventDelegationSetup) return;

    const videoList = document.getElementById("videoList");
    if (videoList) {
      videoList.addEventListener("click", this.handleVideoListClick.bind(this));
      videoList.addEventListener(
        "mouseenter",
        this.handleVideoListMouseEnter.bind(this),
        true,
      );
      videoList.addEventListener(
        "mouseleave",
        this.handleVideoListMouseLeave.bind(this),
        true,
      );
    }

    const sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar.addEventListener("click", this.handleSidebarClick.bind(this));
    }

    // フィルター要素のイベントリスナーを設定
    this.setupFilterEventListeners();

    this.eventDelegationSetup = true;
  }

  private setupFilterEventListeners(): void {
    // 評価フィルター
    const ratingButtons = document.querySelectorAll(".rating-btn");
    ratingButtons.forEach((btn) => {
      const button = btn as HTMLElement;

      // クリックイベント
      button.addEventListener("click", (_e) => {
        const rating = parseInt(button.dataset.rating || "0");
        this.handleRatingFilter(rating);
      });

      // ホバーイベント
      button.addEventListener("mouseenter", (_e) => {
        const rating = parseInt(button.dataset.rating || "0");
        this.handleRatingHover(rating, true);
      });

      button.addEventListener("mouseleave", (_e) => {
        // ホバー終了時は現在選択されている評価を維持
        const currentRating = this.filterManager.getCurrentFilter().rating;
        this.handleRatingHover(currentRating, false);
      });
    });

    // タグフィルター関連ボタン
    const clearAllTagsBtn = document.getElementById("clearAllTagsBtn");
    if (clearAllTagsBtn) {
      clearAllTagsBtn.addEventListener("click", () => {
        this.filterManager.clearTagsFilter();
        this.renderSidebar(); // UIを更新
        this.applyFiltersAndSort(); // フィルタを適用
      });
    }

    // フォルダフィルター関連ボタン
    const selectAllFoldersBtn = document.getElementById("selectAllFoldersBtn");
    const deselectAllFoldersBtn = document.getElementById(
      "deselectAllFoldersBtn",
    );

    if (selectAllFoldersBtn) {
      selectAllFoldersBtn.addEventListener("click", () => {
        this.filterManager.selectAllDirectories();
        this.renderSidebar(); // UIを更新
        this.applyFiltersAndSort(); // フィルタを適用
      });
    }

    if (deselectAllFoldersBtn) {
      deselectAllFoldersBtn.addEventListener("click", () => {
        this.filterManager.deselectAllDirectories();
        this.renderSidebar(); // UIを更新
        this.applyFiltersAndSort(); // フィルタを適用
      });
    }
  }

  private handleRatingFilter(rating: number): void {
    // 現在の評価フィルタと同じ場合はクリア、そうでなければ設定
    const currentRating = this.filterManager.getCurrentFilter().rating;
    const newRating = currentRating === rating ? 0 : rating;

    this.filterManager.setRatingFilter(newRating);
    this.updateRatingDisplay(newRating);
    this.applyFiltersAndSort(); // フィルタを適用
  }

  private handleRatingHover(rating: number, isHover: boolean): void {
    this.uiRenderer.updateStarDisplay(rating, isHover);
  }

  private updateRatingDisplay(rating: number): void {
    logger.debug("updateRatingDisplay called with rating:", rating);

    // data-rating属性を持つ星ボタンのみを対象
    const starButtons = document.querySelectorAll(".rating-btn[data-rating]");

    starButtons.forEach((btn) => {
      const button = btn as HTMLElement;
      const btnRating = parseInt(button.dataset.rating || "0");

      // data-rating="0"は「全て」ボタンなのでスキップ
      if (btnRating === 0) return;

      // 選択された評価以下の星を光らせる
      if (btnRating <= rating && rating > 0) {
        button.classList.add("active");
        button.textContent = "⭐";
        button.setAttribute("aria-pressed", "true");
        logger.debug(`Star ${btnRating} activated`);
      } else {
        button.classList.remove("active");
        button.textContent = "☆";
        button.setAttribute("aria-pressed", "false");
        logger.debug(`Star ${btnRating} deactivated`);
      }
    });

    // 「全て」ボタンの選択状態を同期
    const allButton = document.querySelector(
      '.rating-btn.all-btn[data-rating="0"]',
    ) as HTMLElement | null;
    if (allButton) {
      const isAllSelected = rating === 0;
      allButton.classList.toggle("active", isAllSelected);
      allButton.setAttribute("aria-pressed", isAllSelected.toString());
    }
  }

  private handleVideoListClick(e: Event): void {
    const target = e.target as HTMLElement;
    const videoItem = target.closest(".video-item") as HTMLElement;

    if (!videoItem) return;

    const videoId = parseInt(videoItem.dataset.videoId!);
    const video = this.filteredVideos.find((v) => v.id === videoId);

    if (!video) return;

    const videoIndex = parseInt(videoItem.dataset.index || "-1");
    this.uiRenderer.setSelectedVideoIndex(videoIndex);
    this.uiRenderer.highlightSelectedVideo();

    if (target.classList.contains("play-btn")) {
      e.stopPropagation();
      this.playVideo(video.path);
    } else if (target.classList.contains("details-btn")) {
      e.stopPropagation();
      this.showVideoDetails(video);
    } else if (target.classList.contains("regenerate-thumb-btn")) {
      e.stopPropagation();
      this.regenerateMainThumbnail(video);
    } else {
      this.showVideoDetails(video);
    }
  }

  private handleVideoListMouseEnter(e: Event): void {
    const target = e.target as HTMLElement;
    const videoItem = target.closest(".video-item") as HTMLElement;

    if (videoItem) {
      // チェック対象を拡張：video-thumbnail内の画像要素または video-thumbnail要素自体
      const isThumbnailElement =
        target.classList.contains("video-thumbnail") ||
        target.classList.contains("thumbnail-image") ||
        (target.tagName === "IMG" && target.closest(".video-thumbnail"));

      if (isThumbnailElement) {
        const videoId = parseInt(videoItem.dataset.videoId!);
        const video = this.filteredVideos.find((v) => v.id === videoId);

        if (video) {
          this.showThumbnailTooltip(target, video);
        }
      }
    }
  }

  private handleVideoListMouseLeave(e: Event): void {
    const target = e.target as HTMLElement;

    // チェック対象を拡張：video-thumbnail内の画像要素または video-thumbnail要素自体
    const isThumbnailElement =
      target.classList.contains("video-thumbnail") ||
      target.classList.contains("thumbnail-image") ||
      (target.tagName === "IMG" && target.closest(".video-thumbnail"));

    if (isThumbnailElement) {
      this.hideThumbnailTooltip();
    }
  }

  private handleSidebarClick(e: Event): void {
    const target = e.target as HTMLElement;

    // 編集・削除ボタンの処理（最優先）
    if (target.classList.contains("tag-edit-btn")) {
      e.stopPropagation();
      const tagElement = target.closest(".tag-item") as HTMLElement;
      if (tagElement) {
        const tagName = tagElement.dataset.tagName!;
        this.editTag(tagName);
      }
      return;
    }

    if (target.classList.contains("tag-delete-btn")) {
      e.stopPropagation();
      const tagElement = target.closest(".tag-item") as HTMLElement;
      if (tagElement) {
        const tagName = tagElement.dataset.tagName!;
        this.deleteTag(tagName);
      }
      return;
    }

    if (target.classList.contains("directory-remove-btn")) {
      e.stopPropagation();
      const dirElement = target.closest(".directory-item") as HTMLElement;
      if (dirElement) {
        const dirPath = dirElement.dataset.path!;
        this.removeDirectory(dirPath);
      }
      return;
    }

    // タグフィルターのトグル処理
    const tagElement = target.closest(".tag-item") as HTMLElement;
    if (tagElement && tagElement.dataset.tagName) {
      e.stopPropagation();
      const tagName = tagElement.dataset.tagName;
      this.filterManager.toggleTagFilter(tagName);
      this.renderSidebar(); // UIを更新
      this.applyFiltersAndSort(); // フィルタを適用
      return;
    }

    // ディレクトリフィルターのトグル処理
    const dirElement = target.closest(".directory-item") as HTMLElement;
    if (dirElement && dirElement.dataset.path && !dirElement.dataset.action) {
      e.stopPropagation();
      const dirPath = dirElement.dataset.path;
      this.filterManager.toggleDirectorySelection(dirPath);
      this.renderSidebar(); // UIを更新
      this.applyFiltersAndSort(); // フィルタを適用
      return;
    }
  }

  private async addDirectory(): Promise<void> {
    try {
      const directoryPaths = await this.videoManager.addDirectory();
      if (directoryPaths.length > 0) {
        this.notificationManager.show(
          `${directoryPaths.length}個のディレクトリを追加しました`,
          "success",
        );

        // ディレクトリ追加後、自動でスキャンとサムネイル生成を実行
        this.scanProgress.startProgress(
          1,
          "追加されたディレクトリをスキャン中",
        );
        try {
          logger.log("Starting automatic scan after directory addition...");
          const result = await this.videoManager.scanDirectories();
          logger.log("Automatic scan completed:", result);

          // データを再読み込み
          await this.refreshData();

          // スキャン結果を確認してサムネイル生成が必要かチェック
          let shouldGenerateThumbnails = false;
          if (result) {
            const { totalNew, totalUpdated, totalReprocessed } = result;
            shouldGenerateThumbnails =
              totalNew > 0 || totalUpdated > 0 || totalReprocessed > 0;
          }

          // 新規・更新・再処理された動画がある場合はサムネイル生成を実行
          if (shouldGenerateThumbnails) {
            logger.log(
              "Starting automatic thumbnail generation after directory addition...",
            );
            this.thumbnailProgress.startProgress(1, "サムネイルを生成中");
            try {
              await this.videoManager.generateThumbnails();
              logger.log("Automatic thumbnail generation completed");
              await this.refreshData(); // サムネイル生成後にデータを再読み込み
              this.thumbnailProgress.completeProgress();
            } catch (thumbnailError) {
              console.error(
                "Error during automatic thumbnail generation:",
                thumbnailError,
              );
              this.notificationManager.show(
                "サムネイル生成中にエラーが発生しました",
                "warning",
              );
              this.thumbnailProgress.hide();
            }
          }

          // 最終的な結果通知
          if (result) {
            const { totalNew, totalUpdated, totalReprocessed } = result;
            if (totalNew > 0 || totalUpdated > 0 || totalReprocessed > 0) {
              const details: string[] = [];
              if (totalNew > 0) details.push(`新規: ${totalNew}件`);
              if (totalUpdated > 0) details.push(`更新: ${totalUpdated}件`);
              if (totalReprocessed > 0)
                details.push(`再処理: ${totalReprocessed}件`);

              let message = `スキャンが完了しました (${details.join(", ")})`;
              if (shouldGenerateThumbnails) {
                message += "。サムネイルも生成しました";
              }
              this.notificationManager.show(message, "success");
            } else {
              this.notificationManager.show(
                "新しい動画は見つかりませんでした",
                "info",
              );
            }
          }
        } catch (scanError) {
          console.error("Error during automatic scan:", scanError);
          this.notificationManager.show(
            "自動スキャン中にエラーが発生しました",
            "warning",
          );
        } finally {
          this.scanProgress.completeProgress();
        }
      }
    } catch (error) {
      console.error("Error adding directory:", error);
      this.notificationManager.show(
        "ディレクトリの追加に失敗しました",
        "error",
      );
    }
  }

  private async removeDirectory(path: string): Promise<void> {
    if (!confirm(`ディレクトリ "${path}" を削除しますか？`)) {
      return;
    }

    try {
      await this.videoManager.removeDirectory(path);

      // データを完全に再読み込み
      await this.refreshData();

      // フィルター状態も更新
      const directories = this.videoManager.getDirectories();
      this.filterManager.updateAvailableDirectories(directories);

      this.notificationManager.show("ディレクトリを削除しました", "success");
    } catch (error) {
      console.error("Error removing directory:", error);
      this.notificationManager.show(
        "ディレクトリの削除に失敗しました",
        "error",
      );
    }
  }

  private async scanDirectories(): Promise<void> {
    logger.debug("scanDirectories called");

    if (this.isScanOperationInProgress) {
      this.notificationManager.show(
        "他のスキャン処理が実行中です。完了までお待ちください",
        "warning",
      );
      return;
    }
    this.isScanOperationInProgress = true;

    // ボタンを無効化
    const scanBtn = document.getElementById(
      "scanDirectoriesBtn",
    ) as HTMLButtonElement;
    const rescanBtn = document.getElementById(
      "rescanAllBtn",
    ) as HTMLButtonElement;
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.textContent = "スキャン中...";
    }
    if (rescanBtn) {
      rescanBtn.disabled = true;
    }

    try {
      // プログレス表示開始（バックエンドイベントで更新される）
      this.unifiedProgress.addProgress(
        "scan-progress",
        "ディレクトリをスキャン中",
        1,
      );

      const result = await this.videoManager.scanDirectories();
      logger.log("Comprehensive scan completed:", result);

      logger.log("Starting data refresh...");
      await this.refreshData();
      logger.log("Data refresh completed");

      // スキャン結果を確認してサムネイル生成が必要かチェック
      let shouldGenerateThumbnails = false;
      if (result) {
        const { totalNew, totalUpdated, totalReprocessed } = result;
        shouldGenerateThumbnails =
          totalNew > 0 || totalUpdated > 0 || totalReprocessed > 0;
      }

      // 新規・更新・再処理された動画がある場合はサムネイル生成を実行
      if (shouldGenerateThumbnails) {
        logger.log("Starting automatic thumbnail generation after scan...");
        this.unifiedProgress.addProgress(
          "thumbnail-progress",
          "サムネイルを生成中",
          1,
        );
        try {
          await this.videoManager.generateThumbnails();
          logger.log("Automatic thumbnail generation completed");
          await this.refreshData(); // サムネイル生成後にデータを再読み込み
          this.unifiedProgress.completeProgress("thumbnail-progress");
        } catch (thumbnailError) {
          console.error(
            "Error during automatic thumbnail generation:",
            thumbnailError,
          );
          this.notificationManager.show(
            "サムネイル生成中にエラーが発生しました",
            "warning",
          );
          this.unifiedProgress.removeProgress("thumbnail-progress");
        }
      }

      // 結果に応じた詳細な通知
      if (result) {
        const { totalNew, totalUpdated, totalReprocessed, totalDeleted } =
          result;
        let message = "スキャンが完了しました";
        const details: string[] = [];

        if (totalNew > 0) details.push(`新規: ${totalNew}件`);
        if (totalUpdated > 0) details.push(`更新: ${totalUpdated}件`);
        if (totalReprocessed > 0) details.push(`再処理: ${totalReprocessed}件`);
        if (totalDeleted && totalDeleted > 0)
          details.push(`削除: ${totalDeleted}件`);

        if (details.length > 0) {
          message += ` (${details.join(", ")})`;
        }

        if (shouldGenerateThumbnails) {
          message += "。サムネイルも生成しました";
        }

        this.notificationManager.show(message, "success");
      } else {
        this.notificationManager.show("スキャンが完了しました", "success");
      }
    } catch (error) {
      console.error("Error scanning directories:", error);
      this.notificationManager.show("スキャンに失敗しました", "error");
    } finally {
      this.unifiedProgress.completeProgress("scan-progress");
      this.isScanOperationInProgress = false;

      // ボタンを有効化
      if (scanBtn) {
        scanBtn.disabled = false;
        this.setButtonLabel(scanBtn, "🔄", "スキャン");
      }
      if (rescanBtn) {
        rescanBtn.disabled = false;
      }
    }
  }

  private async generateThumbnails(): Promise<void> {
    logger.debug("generateThumbnails called");

    // ボタンを無効化
    const genBtn = document.getElementById(
      "generateThumbnailsBtn",
    ) as HTMLButtonElement;
    if (genBtn) {
      genBtn.disabled = true;
      genBtn.textContent = "生成中...";
    }

    try {
      // プログレス表示開始（バックエンドイベントで更新される）
      this.unifiedProgress.addProgress(
        "thumbnail-progress",
        "サムネイルを生成中",
        1,
      );

      await this.videoManager.generateThumbnails();
      logger.log("Thumbnail generation completed successfully");

      logger.log("Starting data refresh...");
      await this.refreshData();
      logger.log("Data refresh completed");
      this.notificationManager.show("サムネイル生成が完了しました", "success");
    } catch (error) {
      console.error("Error generating thumbnails:", error);
      this.notificationManager.show("サムネイル生成に失敗しました", "error");
    } finally {
      this.unifiedProgress.completeProgress("thumbnail-progress");

      // ボタンを有効化
      if (genBtn) {
        genBtn.disabled = false;
        this.setButtonLabel(genBtn, "🖼️", "サムネイル再生成");
      }
    }
  }

  private async regenerateAllThumbnails(): Promise<void> {
    logger.debug("regenerateAllThumbnails called");

    // ボタンを無効化
    const regenBtn = document.getElementById(
      "regenerateThumbnailsBtn",
    ) as HTMLButtonElement;
    if (regenBtn) {
      regenBtn.disabled = true;
      regenBtn.textContent = "再生成中...";
    }

    try {
      // オーナープログレスとして開始（このプログレスが終了するまでモーダルは閉じない）
      // 初期状態では総数不明なので1で開始
      this.unifiedProgress.addOwnerProgress(
        "settings-thumbnail-regen",
        "全サムネイルを再生成中",
        1,
      );

      await this.videoManager.regenerateAllThumbnails();
      logger.log("Thumbnail regeneration completed successfully");

      // 処理完了を表示
      this.unifiedProgress.updateProgress(
        "settings-thumbnail-regen",
        1,
        "全サムネイルの再生成が完了しました",
      );

      logger.log("Starting data refresh...");
      await this.refreshData();
      logger.log("Data refresh completed");
      this.notificationManager.show(
        "サムネイル再生成が完了しました",
        "success",
      );
    } catch (error) {
      console.error("Error regenerating thumbnails:", error);
      this.notificationManager.show("サムネイル再生成に失敗しました", "error");
    } finally {
      // プログレスを完了（これでモーダルも閉じる）
      this.unifiedProgress.completeProgress("settings-thumbnail-regen");

      // ボタンを有効化
      if (regenBtn) {
        regenBtn.disabled = false;
        this.setButtonLabel(regenBtn, "🖼️", "全て再生成");
      }
    }
  }

  private async regenerateMainThumbnail(video: Video): Promise<void> {
    try {
      // 単一サムネイル再生成の進捗開始（総数1件）
      this.progressManager.startProgress(1, "メインサムネイルを再生成中");

      const result = await this.videoManager.regenerateMainThumbnail(video.id);

      // 処理完了
      this.progressManager.processItem(video.filename);

      logger.log("Thumbnail regeneration result:", result);

      // 結果の検証
      if (!result || !result.thumbnailPath) {
        throw new Error("サムネイル再生成の結果が無効です");
      }

      // プロパティ名の正規化（APIの返り値に応じて調整）
      const thumbnailPath = result.thumbnailPath;

      if (!thumbnailPath) {
        throw new Error("サムネイルパスが取得できませんでした");
      }

      // UIの更新
      const timestamp = Date.now();

      // 1. 一覧・グリッドビューのサムネイル更新
      const videoElement = document.querySelector(
        `[data-video-id="${video.id}"]`,
      );
      logger.debug("Video element found:", videoElement);

      if (videoElement) {
        // グリッドビューとリストビューで異なるセレクタを使用
        let thumbnail: HTMLImageElement | null = null;

        // まずグリッドビューのサムネイル構造を試す (.thumbnail-image.active)
        thumbnail = videoElement.querySelector(
          ".thumbnail-image.active",
        ) as HTMLImageElement;

        // 見つからない場合はリストビューの構造を試す (.video-thumbnail img)
        if (!thumbnail) {
          thumbnail = videoElement.querySelector(
            ".video-thumbnail img",
          ) as HTMLImageElement;
        }

        // さらに見つからない場合は汎用的なimgセレクタを試す
        if (!thumbnail) {
          thumbnail = videoElement.querySelector(
            ".video-thumbnail .thumbnail-image",
          ) as HTMLImageElement;
        }

        logger.debug("Thumbnail img element found:", thumbnail);

        if (thumbnail) {
          logger.debug("Updating list thumbnail:", thumbnailPath);
          // キャッシュバスターを追加してブラウザのキャッシュを回避
          thumbnail.src = `${FormatUtils.pathToFileUrl(thumbnailPath)}?t=${timestamp}`;

          // 画像の読み込み成功をハンドリング
          thumbnail.onload = () => {
            logger.debug("List thumbnail loaded successfully:", thumbnailPath);
          };

          // 画像の読み込みエラーをハンドリング
          thumbnail.onerror = () => {
            console.error("Failed to load thumbnail image:", thumbnailPath);
          };
        } else {
          logger.debug("Thumbnail img element not found in video element");
          // デバッグのため、要素内の構造を確認
          logger.debug("Video element HTML:", videoElement.outerHTML);
        }
      } else {
        logger.debug("Video element not found for ID:", video.id);
      }

      // 2. 詳細画面のメインサムネイル更新
      const detailsMainThumbnail = document.getElementById(
        "detailsMainThumbnail",
      ) as HTMLImageElement;
      logger.debug("Details main thumbnail element:", detailsMainThumbnail);
      logger.debug(
        "Current video ID:",
        this.currentVideo?.id,
        "Regenerated video ID:",
        video.id,
      );

      if (
        detailsMainThumbnail &&
        this.currentVideo &&
        this.currentVideo.id === video.id
      ) {
        logger.debug("Updating details thumbnail:", thumbnailPath);
        detailsMainThumbnail.src = `${FormatUtils.pathToFileUrl(thumbnailPath)}?t=${timestamp}`;

        // 画像の読み込み成功をハンドリング
        detailsMainThumbnail.onload = () => {
          logger.debug("Details thumbnail loaded successfully:", thumbnailPath);
        };

        // 画像の読み込みエラーをハンドリング
        detailsMainThumbnail.onerror = () => {
          console.error(
            "Failed to load details thumbnail image:",
            thumbnailPath,
          );
        };
      } else {
        logger.debug("Details thumbnail not updated:", {
          elementExists: !!detailsMainThumbnail,
          hasCurrentVideo: !!this.currentVideo,
          videoIdMatch: this.currentVideo?.id === video.id,
        });
      }

      // 3. ローカルデータも更新
      if (this.currentVideo && this.currentVideo.id === video.id) {
        this.currentVideo.thumbnailPath = thumbnailPath;
      }

      // 4. filteredVideosのデータも更新
      const videoInList = this.filteredVideos.find((v) => v.id === video.id);
      if (videoInList) {
        videoInList.thumbnailPath = thumbnailPath;
      }

      // 5. VideoManagerのデータも更新
      const videoInManager = this.videoManager
        .getVideos()
        .find((v) => v.id === video.id);
      if (videoInManager) {
        videoInManager.thumbnailPath = thumbnailPath;
      }

      this.notificationManager.show(
        "メインサムネイルを再生成しました",
        "success",
      );

      // 進捗完了
      this.progressManager.completeProgress();
    } catch (error) {
      console.error("Error regenerating main thumbnail:", error);
      this.notificationManager.show("サムネイル再生成に失敗しました", "error");
      this.progressManager.hide();
    }
  }

  // カスタムサムネイルダイアログを開く
  private async openCustomThumbnailDialog(video: Video): Promise<void> {
    const dialog = document.getElementById("customThumbnailDialog");
    const seekbar = document.getElementById(
      "thumbnailSeekbar",
    ) as HTMLInputElement;
    const preview = document.getElementById(
      "customThumbnailPreview",
    ) as HTMLImageElement;
    const currentTimeDisplay = document.getElementById("currentTimeDisplay");
    const totalTimeDisplay = document.getElementById("totalTimeDisplay");

    if (!dialog || !seekbar || !preview) {
      console.error("Custom thumbnail dialog elements not found");
      return;
    }

    // ダイアログを表示
    dialog.style.display = "flex";

    // シークバーの最大値を動画の長さに設定
    seekbar.max = video.duration.toString();
    seekbar.value = (video.duration * 0.05).toString(); // 初期値は5%の位置

    // シークバーにフォーカスを設定（キーボード操作を有効にするため）
    setTimeout(() => {
      seekbar.focus();
    }, 100);

    // 時間表示を更新
    if (totalTimeDisplay) {
      totalTimeDisplay.textContent = this.formatDuration(video.duration);
    }

    // 初期プレビューを生成
    // メインプレビューとツールチップで共有するキャッシュ
    const previewCache = new Map<number, string>();

    // 画像をクリア（前の動画のサムネイルが表示されないように）
    preview.src = "";
    // エラー時には非表示にしてリンク切れアイコンを防ぐ
    preview.onerror = () => {
      preview.style.display = "none";
    };

    await this.updateThumbnailPreview(
      video,
      parseFloat(seekbar.value),
      preview,
      currentTimeDisplay,
      previewCache,
    );

    // ツールチップ要素を取得
    const tooltip = document.getElementById("seekbarTooltip");
    const tooltipImage = document.getElementById(
      "seekbarTooltipImage",
    ) as HTMLImageElement;
    const tooltipTime = document.getElementById("seekbarTooltipTime");

    // ツールチップ画像もクリア＆初期状態で非表示
    if (tooltipImage) {
      tooltipImage.src = "";
      tooltipImage.style.display = "none";
      // エラー時には必ず非表示にする
      tooltipImage.onerror = () => {
        tooltipImage.style.display = "none";
      };
    }

    let tooltipUpdateTimeout: NodeJS.Timeout | null = null;

    // ツールチップの位置を更新
    const updateTooltipPosition = (event: MouseEvent) => {
      if (!tooltip || !seekbar) return;

      const rect = seekbar.getBoundingClientRect();
      const percent = (event.clientX - rect.left) / rect.width;
      const clampedPercent = Math.max(0, Math.min(1, percent));
      const position = clampedPercent * rect.width;

      tooltip.style.left = `${position}px`;
    };

    // ツールチップのプレビューを更新
    const updateTooltipPreview = async (timestamp: number) => {
      if (!tooltipImage || !tooltipTime) return;

      const tooltipLoading = document.getElementById("seekbarTooltipLoading");

      // 時間を表示
      tooltipTime.textContent = this.formatDuration(timestamp);

      // キャッシュから取得または生成（0.1秒単位で丸める）
      const cacheKey = Math.round(timestamp * 10) / 10;
      if (previewCache.has(cacheKey)) {
        tooltipImage.style.display = "block";
        tooltipImage.src = previewCache.get(cacheKey)!;
        if (tooltipLoading) tooltipLoading.style.display = "none";
      } else {
        // ローディング表示中は画像を非表示
        tooltipImage.style.display = "none";
        if (tooltipLoading) tooltipLoading.style.display = "flex";
        try {
          const previewPath = await window.electronAPI.generatePreviewThumbnail(
            video.path,
            timestamp,
          );
          const imageSrc = `${FormatUtils.pathToFileUrl(previewPath)}?t=${Date.now()}`;
          previewCache.set(cacheKey, imageSrc);
          tooltipImage.src = imageSrc;
          tooltipImage.style.display = "block";
        } catch (error) {
          console.error("Error generating tooltip preview:", error);
        } finally {
          if (tooltipLoading) tooltipLoading.style.display = "none";
        }
      }
    };

    // シークバーのマウスイベント
    const handleSeekbarMouseMove = async (event: MouseEvent) => {
      if (!tooltip || !seekbar) return;

      const rect = seekbar.getBoundingClientRect();
      const percent = (event.clientX - rect.left) / rect.width;
      const clampedPercent = Math.max(0, Math.min(1, percent));
      // シークバーの範囲（0からmax）に基づいて計算
      const rawTimestamp = clampedPercent * parseFloat(seekbar.max);

      // シークバーのstep値に合わせて丸める（step="0.1"の場合、0.1秒単位）
      const step = parseFloat(seekbar.step) || 1;
      const timestamp = Math.round(rawTimestamp / step) * step;

      logger.debug(
        "Tooltip - raw:",
        rawTimestamp,
        "rounded:",
        timestamp,
        "step:",
        step,
      );

      updateTooltipPosition(event);
      tooltip.style.display = "block";
      tooltip.classList.add("show");

      // プレビューは少し遅延させて更新
      if (tooltipUpdateTimeout) {
        clearTimeout(tooltipUpdateTimeout);
      }
      tooltipUpdateTimeout = setTimeout(async () => {
        await updateTooltipPreview(timestamp);
      }, 150);
    };

    // シークバーをクリックした時に正確な値を設定
    const handleSeekbarClick = (event: MouseEvent) => {
      if (!seekbar) return;

      const rect = seekbar.getBoundingClientRect();
      const percent = (event.clientX - rect.left) / rect.width;
      const clampedPercent = Math.max(0, Math.min(1, percent));
      const rawTimestamp = clampedPercent * parseFloat(seekbar.max);
      const step = parseFloat(seekbar.step) || 1;
      const timestamp = Math.round(rawTimestamp / step) * step;

      logger.debug("Click - setting seekbar to:", timestamp);
      seekbar.value = timestamp.toString();

      // inputイベントを手動でトリガー
      seekbar.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const handleSeekbarMouseLeave = () => {
      if (tooltip) {
        tooltip.classList.remove("show");
        setTimeout(() => {
          if (tooltip && !tooltip.classList.contains("show")) {
            tooltip.style.display = "none";
          }
        }, 200);
      }
      if (tooltipUpdateTimeout) {
        clearTimeout(tooltipUpdateTimeout);
      }
    };

    seekbar.addEventListener("mousemove", handleSeekbarMouseMove);
    seekbar.addEventListener("click", handleSeekbarClick);
    seekbar.addEventListener("mouseleave", handleSeekbarMouseLeave);

    // シークバー変更時のイベントハンドラー
    let updateTimeout: NodeJS.Timeout | null = null;
    let isKeyboardSeek = false;

    // キーボード操作を検出
    const handleSeekbarKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        isKeyboardSeek = true;
        e.stopPropagation();
      }
    };

    const handleSeekbarKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        isKeyboardSeek = false;
        e.stopPropagation();
      }
    };

    const handleSeekbarChange = async () => {
      if (updateTimeout) {
        clearTimeout(updateTimeout);
      }

      logger.debug("Seekbar value changed to:", seekbar.value);

      // 時間表示を即座に更新
      if (currentTimeDisplay) {
        currentTimeDisplay.textContent = this.formatDuration(
          parseFloat(seekbar.value),
        );
      }

      // キーボード操作の場合は即座に更新、マウス操作の場合は遅延
      const delay = isKeyboardSeek ? 0 : 300;

      updateTimeout = setTimeout(async () => {
        await this.updateThumbnailPreview(
          video,
          parseFloat(seekbar.value),
          preview,
          currentTimeDisplay,
          previewCache,
        );
      }, delay);
    };

    seekbar.addEventListener("keydown", handleSeekbarKeyDown);
    seekbar.addEventListener("keyup", handleSeekbarKeyUp);
    seekbar.addEventListener("input", handleSeekbarChange);

    // ダイアログ全体で方向キーをキャプチャしてシークバーに転送
    const handleDialogKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();

        // キーボード操作フラグを設定
        isKeyboardSeek = true;

        // シークバーの値を変更（シークバーのstep値を使用）
        const step = parseFloat(seekbar.step) || 1;
        const currentValue = parseFloat(seekbar.value);
        const maxValue = parseFloat(seekbar.max);

        let newValue: number;
        if (e.key === "ArrowLeft") {
          newValue = Math.max(0, currentValue - step);
        } else {
          newValue = Math.min(maxValue, currentValue + step);
        }

        seekbar.value = newValue.toString();

        // inputイベントを手動でトリガー
        seekbar.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    const handleDialogKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        isKeyboardSeek = false;
      }
    };

    dialog.addEventListener("keydown", handleDialogKeyDown);
    dialog.addEventListener("keyup", handleDialogKeyUp);

    // 確定ボタン
    const applyBtn = document.getElementById("applyCustomThumbnailBtn");
    if (applyBtn) {
      applyBtn.onclick = async () => {
        await this.applyCustomThumbnail(video, parseFloat(seekbar.value));
        dialog.style.display = "none";
        dialog.removeEventListener("keydown", handleDialogKeyDown);
        dialog.removeEventListener("keyup", handleDialogKeyUp);
        seekbar.removeEventListener("input", handleSeekbarChange);
        seekbar.removeEventListener("keydown", handleSeekbarKeyDown);
        seekbar.removeEventListener("keyup", handleSeekbarKeyUp);
        seekbar.removeEventListener("mousemove", handleSeekbarMouseMove);
        seekbar.removeEventListener("click", handleSeekbarClick);
        seekbar.removeEventListener("mouseleave", handleSeekbarMouseLeave);
        if (tooltipUpdateTimeout) {
          clearTimeout(tooltipUpdateTimeout);
        }
        previewCache.clear();
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById("cancelCustomThumbnailBtn");
    const closeBtn = document.getElementById("closeCustomThumbnailDialog");
    const closeHandler = () => {
      dialog.style.display = "none";
      dialog.removeEventListener("keydown", handleDialogKeyDown);
      dialog.removeEventListener("keyup", handleDialogKeyUp);
      seekbar.removeEventListener("input", handleSeekbarChange);
      seekbar.removeEventListener("keydown", handleSeekbarKeyDown);
      seekbar.removeEventListener("keyup", handleSeekbarKeyUp);
      seekbar.removeEventListener("mousemove", handleSeekbarMouseMove);
      seekbar.removeEventListener("click", handleSeekbarClick);
      seekbar.removeEventListener("mouseleave", handleSeekbarMouseLeave);
      if (updateTimeout) {
        clearTimeout(updateTimeout);
      }
      if (tooltipUpdateTimeout) {
        clearTimeout(tooltipUpdateTimeout);
      }
      previewCache.clear();
    };

    if (cancelBtn) {
      cancelBtn.onclick = closeHandler;
    }
    if (closeBtn) {
      closeBtn.onclick = closeHandler;
    }
  }

  // サムネイルプレビューを更新
  private async updateThumbnailPreview(
    video: Video,
    timestamp: number,
    preview: HTMLImageElement,
    currentTimeDisplay: HTMLElement | null,
    previewCache?: Map<number, string>,
  ): Promise<void> {
    try {
      // 時間表示を更新
      if (currentTimeDisplay) {
        currentTimeDisplay.textContent = this.formatDuration(timestamp);
      }

      // キャッシュキー（0.1秒単位で丸める）
      const cacheKey = Math.round(timestamp * 10) / 10;

      // キャッシュから取得できる場合
      if (previewCache && previewCache.has(cacheKey)) {
        preview.style.display = "block";
        preview.src = previewCache.get(cacheKey)!;
        return;
      }

      // プレビューサムネイルを生成
      const previewPath = await window.electronAPI.generatePreviewThumbnail(
        video.path,
        timestamp,
      );

      const imageSrc = `${FormatUtils.pathToFileUrl(previewPath)}?t=${Date.now()}`;

      // プレビュー画像を表示
      preview.src = imageSrc;
      preview.style.display = "block";

      // キャッシュに保存
      if (previewCache) {
        previewCache.set(cacheKey, imageSrc);
      }
    } catch (error) {
      console.error("Error updating thumbnail preview:", error);
      this.notificationManager.show("プレビューの生成に失敗しました", "error");
    }
  }

  // カスタムサムネイルを適用
  private async applyCustomThumbnail(
    video: Video,
    timestamp: number,
  ): Promise<void> {
    try {
      this.progressManager.startProgress(1, "カスタムサムネイルを生成中...");

      // メインサムネイルを指定タイムスタンプで再生成
      const electronVideo =
        await window.electronAPI.regenerateMainThumbnailWithTimestamp(
          video.id,
          timestamp,
        );

      this.progressManager.processItem(video.filename);

      logger.log("Custom thumbnail applied:", electronVideo);

      // ElectronVideo から thumbnailPath を取得
      const thumbnailPath = electronVideo.thumbnailPath;

      // UIを更新
      const detailsMainThumbnail = document.getElementById(
        "detailsMainThumbnail",
      ) as HTMLImageElement;
      if (detailsMainThumbnail && thumbnailPath) {
        detailsMainThumbnail.src = `${FormatUtils.pathToFileUrl(thumbnailPath)}?t=${Date.now()}`;
      }

      // ローカルデータを更新
      if (this.currentVideo && this.currentVideo.id === video.id) {
        this.currentVideo.thumbnailPath = thumbnailPath;
      }

      // リスト内のデータも更新
      const videoInList = this.filteredVideos.find((v) => v.id === video.id);
      if (videoInList) {
        videoInList.thumbnailPath = thumbnailPath;
        videoInList.updatedAt = new Date(); // キャッシュバスティング用に更新日時を更新
      }

      // ビデオリストを再描画
      await this.renderVideoList();

      this.notificationManager.show(
        "カスタムサムネイルを設定しました",
        "success",
      );

      this.progressManager.completeProgress();
    } catch (error) {
      console.error("Error applying custom thumbnail:", error);
      this.notificationManager.show(
        "カスタムサムネイルの設定に失敗しました",
        "error",
      );
      this.progressManager.hide();
    }
  }

  // 時間をフォーマット（HH:MM:SS形式）
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    } else {
      return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
  }

  private async cleanupThumbnails(): Promise<void> {
    logger.debug("cleanupThumbnails called");

    // ボタンを無効化
    const cleanupBtn = document.getElementById(
      "cleanupThumbnailsBtn",
    ) as HTMLButtonElement;
    if (cleanupBtn) {
      cleanupBtn.disabled = true;
      cleanupBtn.textContent = "削除中...";
    }

    try {
      // オーナープログレスとして開始（このプログレスが終了するまでモーダルは閉じない）
      this.unifiedProgress.addOwnerProgress(
        "settings-thumbnail-cleanup",
        "不要な画像を削除中",
        100,
      );

      await this.videoManager.cleanupThumbnails();
      logger.log("Thumbnail cleanup completed successfully");

      this.notificationManager.show(
        "不要な画像の削除が完了しました",
        "success",
      );
    } catch (error) {
      console.error("Error cleaning up thumbnails:", error);
      this.notificationManager.show("不要な画像の削除に失敗しました", "error");
    } finally {
      // プログレスを完了（これでモーダルも閉じる）
      this.unifiedProgress.completeProgress("settings-thumbnail-cleanup");

      // ボタンを有効化
      if (cleanupBtn) {
        cleanupBtn.disabled = false;
        this.setButtonLabel(cleanupBtn, "🗑️", "不要な画像を削除");
      }
    }
  }

  private async rescanAllVideos(): Promise<void> {
    logger.debug("rescanAllVideos called");

    if (this.isScanOperationInProgress) {
      this.notificationManager.show(
        "他のスキャン処理が実行中です。完了までお待ちください",
        "warning",
      );
      return;
    }
    this.isScanOperationInProgress = true;

    // ボタンを無効化
    const rescanBtn = document.getElementById(
      "rescanAllBtn",
    ) as HTMLButtonElement;
    const scanBtn = document.getElementById(
      "scanDirectoriesBtn",
    ) as HTMLButtonElement;
    if (rescanBtn) {
      rescanBtn.disabled = true;
      rescanBtn.textContent = "再スキャン中...";
    }
    if (scanBtn) {
      scanBtn.disabled = true;
    }

    try {
      // オーナープログレスとして開始（このプログレスが終了するまでモーダルは閉じない）
      this.unifiedProgress.addOwnerProgress(
        "settings-rescan-all",
        "全ての動画を再スキャン中",
        1,
      );

      // 強制的に全ての動画を再スキャン
      const result = await this.videoManager.rescanAllVideos();
      logger.log("Full rescan completed:", result);

      // 処理完了を表示（サムネイル生成が自動で開始されることを示す）
      this.unifiedProgress.updateProgress(
        "settings-rescan-all",
        1,
        "再スキャン完了 - サムネイル生成中...",
      );

      logger.log("Starting data refresh...");
      await this.refreshData();
      logger.log("Data refresh completed");

      // サムネイル生成完了まで少し待機（非同期で実行されているため）
      setTimeout(() => {
        // 通知メッセージでサムネイル生成完了も含める
        this.notificationManager.show(
          "再スキャンとサムネイル生成が完了しました",
          "success",
        );
      }, THUMBNAIL_COMPLETION_NOTIFY_DELAY_MS); // 完了通知の待機時間

      // 結果に応じた詳細な通知（サムネイル生成開始の通知は別途表示）
      if (result) {
        const { totalProcessed, totalUpdated, totalErrors } = result;
        let message = "再スキャン完了";
        const details: string[] = [];

        if (totalProcessed && totalProcessed > 0)
          details.push(`処理: ${totalProcessed}件`);
        if (totalUpdated > 0) details.push(`更新: ${totalUpdated}件`);
        if (totalErrors && totalErrors > 0)
          details.push(`エラー: ${totalErrors}件`);

        if (details.length > 0) {
          message += ` (${details.join(", ")})`;
        }

        message += " - サムネイル生成中...";

        // 即座に結果を表示し、後で最終完了通知を表示
        this.notificationManager.show(
          message,
          totalErrors && totalErrors > 0 ? "warning" : "info",
        );
      } else {
        this.notificationManager.show(
          "再スキャン完了 - サムネイル生成中...",
          "info",
        );
      }
    } catch (error) {
      console.error("Error rescanning all videos:", error);
      this.notificationManager.show("全動画再スキャンに失敗しました", "error");
    } finally {
      // プログレスを完了（これでモーダルも閉じる）
      this.unifiedProgress.completeProgress("settings-rescan-all");
      this.isScanOperationInProgress = false;

      // ボタンを有効化
      if (rescanBtn) {
        rescanBtn.disabled = false;
        this.setButtonLabel(rescanBtn, "🔄", "全ての動画を再スキャン");
      }
      if (scanBtn) {
        scanBtn.disabled = false;
      }
    }
  }

  private async refreshData(): Promise<void> {
    try {
      this.progressManager.show("データを更新中...");

      // 強制リロード
      await this.videoManager.loadVideos(true);
      await this.videoManager.loadTags(true);
      await this.videoManager.loadDirectories(true);

      this.filteredVideos = this.videoManager.getVideos();
      this.renderAll();
      this.applyFiltersAndSort();

      // 設定ダイアログが開いている場合は、ディレクトリリストも更新
      const settingsModal = document.getElementById("settingsModal");
      if (settingsModal && settingsModal.hasAttribute("is-open")) {
        const directories = this.videoManager.getDirectories();
        this.uiRenderer.renderSettingsDirectories(directories);
      }

      this.notificationManager.show("データを更新しました", "success");
    } catch (error) {
      console.error("Error refreshing data:", error);
      this.notificationManager.show("データの更新に失敗しました", "error");
    } finally {
      this.progressManager.hide();
    }
  }

  // ビデオファイル追加時の処理
  private async handleVideoAdded(filePath: string): Promise<void> {
    try {
      logger.log("Handling video addition:", filePath);

      // プログレスバーを表示
      this.progressManager.show("新しい動画を読み込み中...");

      // 短時間のディレイを入れて、ファイル操作の完了を待つ
      await new Promise((resolve) =>
        setTimeout(resolve, FILE_WRITE_SETTLE_DELAY_MS),
      );

      // データを再読み込み（新しい動画を含むため）
      await this.videoManager.loadVideos(true);

      // 新しく追加された動画を取得
      let newVideo = this.videoManager
        .getVideos()
        .find((v) => v.path === filePath);

      if (!newVideo) {
        logger.debug(
          "Video not found in database, triggering directory scan:",
          filePath,
        );

        // データベースで見つからない場合は、ディレクトリ全体の再スキャンを実行
        try {
          this.progressManager.show("ディレクトリを再スキャン中...");
          await this.videoManager.scanDirectories();

          // 再度データを読み込み
          await this.videoManager.loadVideos(true);
          newVideo = this.videoManager
            .getVideos()
            .find((v) => v.path === filePath);
        } catch (scanError) {
          console.error("Failed to scan directories:", scanError);
        }
      }

      if (newVideo) {
        // フィルタリングされたリストを更新
        this.filteredVideos = this.videoManager.getVideos();
        this.applyFiltersAndSort();

        // UIを更新
        this.renderAll();

        // 統計も更新
        this.uiRenderer.updateStats(this.videoManager.getStats());

        // 通知を表示
        const fileName = filePath.split("/").pop() || filePath;
        this.notificationManager.show(
          `新しい動画が追加されました: ${fileName}`,
          "success",
        );

        logger.log("Video addition handled successfully:", newVideo);
      } else {
        console.warn("Added video could not be processed:", filePath);
        const fileName = filePath.split("/").pop() || filePath;
        this.notificationManager.show(
          `動画ファイルを処理できませんでした: ${fileName}`,
          "warning",
        );
      }
    } catch (error) {
      console.error("Error handling video addition:", error);
      this.notificationManager.show(
        "動画の追加処理中にエラーが発生しました",
        "error",
      );
    } finally {
      this.progressManager.hide();
    }
  }

  // ビデオファイル削除時の処理
  private async handleVideoRemoved(filePath: string): Promise<void> {
    try {
      logger.log("Handling video removal:", filePath);

      // プログレスバーを表示
      this.progressManager.show("動画データを更新中...");

      // 削除された動画の情報を保存（通知用）
      const removedVideo = this.videoManager
        .getVideos()
        .find((v) => v.path === filePath);
      const fileName =
        removedVideo?.filename || filePath.split("/").pop() || filePath;

      // 現在表示中の動画が削除された場合、詳細パネルを閉じる
      if (this.currentVideo && this.currentVideo.path === filePath) {
        this.hideVideoDetails();
      }

      // データを再読み込み
      await this.videoManager.loadVideos(true);

      // フィルタリングされたリストを更新
      this.filteredVideos = this.videoManager.getVideos();
      this.applyFiltersAndSort();

      // UIを更新
      this.renderAll();

      // 統計も更新
      this.uiRenderer.updateStats(this.videoManager.getStats());

      // 通知を表示
      this.notificationManager.show(
        `動画が削除されました: ${fileName}`,
        "info",
      );

      logger.log("Video removal handled successfully");
    } catch (error) {
      console.error("Error handling video removal:", error);
      this.notificationManager.show(
        "動画の削除処理中にエラーが発生しました",
        "error",
      );
    } finally {
      this.progressManager.hide();
    }
  }

  // ディレクトリ削除時の処理
  private async handleDirectoryRemoved(dirPath: string): Promise<void> {
    try {
      logger.log("Handling directory removal:", dirPath);

      // プログレスバーを表示
      this.progressManager.show("ディレクトリデータを更新中...");

      // ディレクトリ名を取得（通知用）
      const dirName = dirPath.split("/").pop() || dirPath;

      // ディレクトリをデータベースから削除
      await this.videoManager.removeDirectory(dirPath);

      // データを完全に再読み込み
      await this.refreshData();

      // フィルター状態も更新
      const directories = this.videoManager.getDirectories();
      this.filterManager.updateAvailableDirectories(directories);

      // 通知を表示
      this.notificationManager.show(
        `ディレクトリが削除されました: ${dirName}`,
        "warning",
      );

      logger.log("Directory removal handled successfully");
    } catch (error) {
      console.error("Error handling directory removal:", error);
      this.notificationManager.show(
        "ディレクトリの削除処理中にエラーが発生しました",
        "error",
      );
    } finally {
      this.progressManager.hide();
    }
  }

  // 起動時のディレクトリ存在チェック
  private async checkDirectoriesExistence(
    directories: Directory[],
  ): Promise<void> {
    try {
      logger.log("Checking directories existence...");

      const removedDirectories: string[] = [];

      for (let i = 0; i < directories.length; i++) {
        const directory = directories[i];
        const dirPath = directory.path;

        logger.debug(
          `Checking directory ${i + 1}/${directories.length}: ${dirPath}`,
        );

        // プログレス更新
        this.directoryCheckProgress.processItem(dirPath);

        // ディレクトリの存在をチェック
        try {
          const exists = await window.electronAPI.checkDirectoryExists(dirPath);
          if (!exists) {
            logger.debug("Directory no longer exists:", dirPath);
            removedDirectories.push(dirPath);
          } else {
            logger.debug("Directory exists:", dirPath);
          }
        } catch (error) {
          console.warn("Failed to check directory existence:", dirPath, error);
          removedDirectories.push(dirPath);
        }
      }

      // 削除されたディレクトリがある場合の処理
      if (removedDirectories.length > 0) {
        logger.debug("Found removed directories:", removedDirectories);

        // 各削除されたディレクトリを処理
        for (const dirPath of removedDirectories) {
          try {
            await this.videoManager.removeDirectory(dirPath);
            const dirName = dirPath.split("/").pop() || dirPath;
            logger.debug(`Removed directory from database: ${dirName}`);
          } catch (error) {
            console.error(
              "Failed to remove directory from database:",
              dirPath,
              error,
            );
          }
        }

        // データを再読み込み
        await this.videoManager.loadDirectories(true);
        const updatedDirectories = this.videoManager.getDirectories();
        this.filterManager.updateAvailableDirectories(updatedDirectories);

        // 通知を表示
        if (removedDirectories.length === 1) {
          const dirName =
            removedDirectories[0].split("/").pop() || removedDirectories[0];
          this.notificationManager.show(
            `削除されたディレクトリをアプリから除外しました: ${dirName}`,
            "warning",
          );
        } else {
          this.notificationManager.show(
            `${removedDirectories.length}個の削除されたディレクトリをアプリから除外しました`,
            "warning",
          );
        }
      }
    } catch (error) {
      console.error("Error checking directories existence:", error);
    }
  }

  private toggleTheme(): void {
    this.themeManager.toggleTheme();
    this.initializeThemeButton();
  }

  private updateSortUI(): void {
    // ソート項目のselect要素を更新
    const sortSelect = document.getElementById(
      "sortSelect",
    ) as HTMLSelectElement;
    if (sortSelect) {
      sortSelect.value = this.currentSort.field;
    }

    // ソート順のselect要素を更新
    const orderSelect = document.getElementById(
      "orderSelect",
    ) as HTMLSelectElement;
    if (orderSelect) {
      orderSelect.value = this.currentSort.order;
    }
  }

  private handleSortChange(e: Event): void {
    const target = e.target as HTMLSelectElement;

    if (target.id === "sortSelect") {
      // ソートフィールドが変更された
      this.currentSort.field = target.value;
    } else if (target.id === "orderSelect") {
      // ソート順が変更された
      this.currentSort.order = target.value as "ASC" | "DESC";
    }

    // ソート状態をlocalStorageに保存
    localStorage.setItem("sortField", this.currentSort.field);
    localStorage.setItem("sortOrder", this.currentSort.order);

    logger.log("Sort changed:", this.currentSort);
    this.applyFiltersAndSort();
  }

  private handleSearchInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    // FilterManagerに検索状態を通知
    this.filterManager.updateSearch(target.value);
    // 検索入力時にフィルタリングを実行
    this.applyFiltersAndSort();
  }

  private handleSearchClear(): void {
    const searchInput = document.getElementById(
      "searchInput",
    ) as HTMLInputElement;
    if (searchInput) {
      searchInput.value = "";
      this.filterManager.updateSearch("");
      this.applyFiltersAndSort();
    }
  }

  private handleTagFilterInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.uiRenderer.setTagFilterKeyword(target.value);
    // タグリストを再描画
    this.renderSidebar();
  }

  private handleTagFilterClear(): void {
    const tagFilterInput = document.getElementById(
      "tagFilterInput",
    ) as HTMLInputElement;
    if (tagFilterInput) {
      tagFilterInput.value = "";
      this.uiRenderer.clearTagFilterKeyword();
      this.renderSidebar();
    }
  }

  private setView(view: "grid" | "list"): void {
    this.uiRenderer.setView(view);
    this.renderVideoList();

    // Maintain selected video highlighting after view change
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    if (selectedIndex >= 0) {
      setTimeout(() => {
        this.uiRenderer.highlightSelectedVideo();
      }, 50); // Small delay to ensure DOM is updated
    }
  }

  // 将来的に使用する可能性があるためコメントアウト
  // private toggleViewMode(): void {
  //   const viewModeBtn = document.getElementById("viewModeBtn");
  //   const videoList = document.getElementById("videoList");

  //   if (viewModeBtn && videoList) {
  //     const isGrid = videoList.classList.contains("grid-view");

  //     if (isGrid) {
  //       videoList.classList.remove("grid-view");
  //       videoList.classList.add("list-view");
  //       viewModeBtn.textContent = "グリッド表示";
  //     } else {
  //       videoList.classList.remove("list-view");
  //       videoList.classList.add("grid-view");
  //       viewModeBtn.textContent = "リスト表示";
  //     }

  //     // 設定を保存
  //     localStorage.setItem("viewMode", isGrid ? "list" : "grid");
  //   }
  // }

  private async playVideo(videoPath: string): Promise<void> {
    try {
      await this.videoManager.playVideo(videoPath);
    } catch (error) {
      console.error("Error playing video:", error);
      this.notificationManager.show("動画の再生に失敗しました", "error");
    }
  }

  private showVideoDetails(video: Video): void {
    // 同じビデオが既に表示されている場合は再描画をスキップ
    if (this.currentVideo && this.currentVideo.id === video.id) {
      return;
    }

    this.currentVideo = video;
    this.uiRenderer.showVideoDetails(video);

    // 詳細表示のイベントリスナー設定
    this.setupVideoDetailsEventListeners();
  }

  private setupVideoDetailsEventListeners(): void {
    // 詳細ダイアログのイベントリスナー
    const closeBtn = document.getElementById("closeDetailsBtn");
    const saveBtn = document.getElementById("saveDetailsBtn");
    const playBtn = document.getElementById("playVideoBtn");
    const refreshThumbnailBtn = document.getElementById(
      "refreshMainThumbnailBtn",
    );
    const ratingStars = document.querySelectorAll(".rating-input .star");

    if (closeBtn) {
      closeBtn.onclick = () => this.hideVideoDetails();
    }

    if (saveBtn) {
      saveBtn.onclick = () => this.saveVideoDetails();
    }

    if (playBtn) {
      playBtn.onclick = () => {
        if (this.currentVideo) {
          this.playVideo(this.currentVideo.path);
        }
      };
    }

    if (refreshThumbnailBtn) {
      refreshThumbnailBtn.onclick = () => {
        if (this.currentVideo) {
          this.regenerateMainThumbnail(this.currentVideo);
        }
      };
    }

    const customThumbnailBtn = document.getElementById("customThumbnailBtn");
    if (customThumbnailBtn) {
      customThumbnailBtn.onclick = () => {
        if (this.currentVideo) {
          this.openCustomThumbnailDialog(this.currentVideo);
        }
      };
    }

    // レーティング星のクリックイベント
    ratingStars.forEach((star, index) => {
      const starElement = star as HTMLElement;

      // クリックイベント
      starElement.onclick = () => {
        this.setVideoRating(index + 1);
      };

      // キーボード操作（Enter / Space）
      starElement.onkeydown = (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.setVideoRating(index + 1);
        }
      };

      // ホバーイベント
      starElement.onmouseenter = () => {
        this.uiRenderer.updateDetailsRatingHover(index + 1, true);
      };

      starElement.onmouseleave = () => {
        const currentRating = this.currentVideo?.rating || 0;
        this.uiRenderer.updateDetailsRatingHover(currentRating, false);
      };
    });

    // 評価削除ボタンのクリックイベント
    const clearRatingBtn = document.querySelector(
      ".clear-rating-btn",
    ) as HTMLElement;
    if (clearRatingBtn) {
      clearRatingBtn.onclick = () => {
        this.setVideoRating(0);
      };
    }

    // タグ入力のイベント処理
    const tagInput = document.getElementById("tagInput") as HTMLInputElement;
    if (tagInput) {
      if (this.tagInputKeydownHandler) {
        tagInput.removeEventListener("keydown", this.tagInputKeydownHandler);
      }
      this.tagInputKeydownHandler = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.addTagToCurrentVideo();
        }
      };
      tagInput.addEventListener("keydown", this.tagInputKeydownHandler);
    }

    // タグ削除ボタンのイベント処理
    const tagContainer = document.getElementById("detailsTagsList");
    if (tagContainer) {
      tagContainer.onclick = (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains("remove-tag")) {
          const tagName = target.dataset.tag!;
          this.removeTagFromCurrentVideo(tagName);
        }
      };
    }

    // メインサムネイルクリックでチャプターダイアログを表示
    const mainThumbnail = document.getElementById("detailsMainThumbnail");
    if (mainThumbnail) {
      mainThumbnail.onclick = () => {
        if (this.currentVideo) {
          this.showChapterDialog(this.currentVideo);
        }
      };
    }

    // チャプターサムネイルクリックでチャプターダイアログを表示
    const chapterContainer = document.getElementById(
      "detailsChapterThumbnails",
    );
    if (chapterContainer) {
      chapterContainer.onclick = (e) => {
        const target = e.target as HTMLElement;
        const chapterThumbnail = target.closest(".chapter-thumbnail");
        if (chapterThumbnail && this.currentVideo) {
          // クリックされたチャプターの0-based index を取得
          const siblings = Array.from(chapterContainer.children);
          const clickedIndex = siblings.indexOf(chapterThumbnail as Element);
          // allThumbnails[0] はメインサムネイルなので +1 してチャプター位置に変換
          const startIndex = clickedIndex >= 0 ? clickedIndex + 1 : 1;
          this.showChapterDialog(this.currentVideo, startIndex);
        }
      };
    }
  }

  private hideVideoDetails(): void {
    this.currentVideo = null;
    this.uiRenderer.hideVideoDetails();
  }

  private async saveVideoDetails(): Promise<void> {
    if (!this.currentVideo) return;

    try {
      const titleInput = document.getElementById(
        "detailsTitleInput",
      ) as HTMLInputElement;
      const descriptionInput = document.getElementById(
        "detailsDescriptionInput",
      ) as HTMLTextAreaElement;

      const updatedData = {
        title: titleInput.value,
        description: descriptionInput.value,
      };

      await this.videoManager.updateVideo(this.currentVideo.id, updatedData);

      // ローカルデータを更新
      this.currentVideo.title = updatedData.title;
      this.currentVideo.description = updatedData.description;

      // リストを再描画
      this.renderVideoList();

      this.notificationManager.show("動画情報を更新しました", "success");
    } catch (error) {
      console.error("Error saving video details:", error);
      this.notificationManager.show("動画情報の更新に失敗しました", "error");
    }
  }

  private async addTagToCurrentVideo(): Promise<void> {
    if (!this.currentVideo) return;

    const tagInput = document.getElementById("tagInput") as HTMLInputElement;
    const tagInputValue = tagInput.value.trim();

    if (!tagInputValue) {
      this.notificationManager.show("タグ名を入力してください", "warning");
      return;
    }

    // スペース区切りで複数のタグを処理
    const tagNames = tagInputValue
      .split(/\s+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    if (tagNames.length === 0) {
      this.notificationManager.show("タグ名を入力してください", "warning");
      return;
    }

    try {
      // 各タグを追加
      for (const tagName of tagNames) {
        await this.videoManager.addTagToVideo(this.currentVideo.id, tagName);

        // ローカルデータを更新
        if (!this.currentVideo.tags) {
          this.currentVideo.tags = [];
        }
        if (!this.currentVideo.tags.includes(tagName)) {
          this.currentVideo.tags.push(tagName);
        }
      }

      // filteredVideosの該当動画も更新
      const videoInList = this.filteredVideos.find(
        (v) => v.id === this.currentVideo!.id,
      );
      if (videoInList) {
        videoInList.tags = [...(this.currentVideo.tags || [])];
      }

      // UIを更新
      this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags || []);
      // サムネイルを再読み込みせずにタグ表示だけ更新
      this.uiRenderer.updateVideoTags(
        this.currentVideo.id,
        this.currentVideo.tags || [],
      );

      // タグ一覧を更新するためにサイドバーを再描画
      this.renderSidebar();

      tagInput.value = "";
      const message =
        tagNames.length === 1
          ? "タグを追加しました"
          : `${tagNames.length}個のタグを追加しました`;
      this.notificationManager.show(message, "success");
    } catch (error) {
      console.error("Error adding tag:", error);
      this.notificationManager.show("タグの追加に失敗しました", "error");
    }
  }

  private async removeTagFromCurrentVideo(tagName: string): Promise<void> {
    if (!this.currentVideo) return;

    try {
      await this.videoManager.removeTagFromVideo(this.currentVideo.id, tagName);

      // ローカルデータを更新
      if (this.currentVideo.tags) {
        this.currentVideo.tags = this.currentVideo.tags.filter(
          (tag) => tag !== tagName,
        );
      }

      // filteredVideosの該当動画も更新
      const videoInList = this.filteredVideos.find(
        (v) => v.id === this.currentVideo!.id,
      );
      if (videoInList) {
        videoInList.tags = [...(this.currentVideo.tags || [])];
      }

      // UIを更新
      this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags || []);
      // サムネイルを再読み込みせずにタグ表示だけ更新
      this.uiRenderer.updateVideoTags(
        this.currentVideo.id,
        this.currentVideo.tags || [],
      );

      // タグ一覧を更新するためにサイドバーを再描画
      this.renderSidebar();

      this.notificationManager.show("タグを削除しました", "success");
    } catch (error) {
      console.error("Error removing tag:", error);
      this.notificationManager.show("タグの削除に失敗しました", "error");
    }
  }

  private async setVideoRating(rating: number): Promise<void> {
    if (!this.currentVideo) return;

    try {
      await this.videoManager.updateVideo(this.currentVideo.id, { rating });

      // ローカルデータを更新
      this.currentVideo.rating = rating;

      // UIを更新（詳細画面のみ）
      this.uiRenderer.updateDetailsRatingDisplay(rating);

      // filteredVideosの該当動画も更新
      const videoInList = this.filteredVideos.find(
        (v) => v.id === this.currentVideo!.id,
      );
      if (videoInList) {
        videoInList.rating = rating;
      }

      // VideoManagerのデータも更新
      const videoInManager = this.videoManager
        .getVideos()
        .find((v) => v.id === this.currentVideo!.id);
      if (videoInManager) {
        videoInManager.rating = rating;
      }

      // 動画リスト全体を再描画して即座に反映
      this.renderVideoList();

      // 適切な通知メッセージを表示
      if (rating === 0) {
        this.notificationManager.show("評価を削除しました", "success");
      } else {
        this.notificationManager.show(
          `評価を${rating}に設定しました`,
          "success",
        );
      }
    } catch (error) {
      console.error("Error setting rating:", error);
      this.notificationManager.show("評価の設定に失敗しました", "error");
    }
  }

  private showThumbnailTooltip(element: HTMLElement, video: Video): void {
    this.hideThumbnailTooltip();

    // チャプターサムネイルがない場合は何もしない
    if (!video.chapterThumbnails) return;

    let chapterThumbnails: ChapterThumbnail[];
    try {
      chapterThumbnails =
        typeof video.chapterThumbnails === "string"
          ? JSON.parse(video.chapterThumbnails)
          : video.chapterThumbnails;
    } catch {
      return;
    }

    if (!chapterThumbnails || chapterThumbnails.length === 0) return;

    this.currentThumbnails = chapterThumbnails;
    this.currentThumbnailIndex = 0;

    // ツールチップを表示
    const tooltip = this.uiRenderer.createThumbnailTooltip(
      chapterThumbnails[0].path,
      FormatUtils.formatTimestamp(chapterThumbnails[0].timestamp),
    );

    // 位置を調整
    const rect = element.getBoundingClientRect();
    tooltip.style.left = `${rect.right + 10}px`;
    tooltip.style.top = `${rect.top}px`;

    document.body.appendChild(tooltip);

    // サムネイル切り替えタイマー
    this.tooltipInterval = setInterval(() => {
      this.currentThumbnailIndex =
        (this.currentThumbnailIndex + 1) % this.currentThumbnails.length;

      const currentThumbnail =
        this.currentThumbnails[this.currentThumbnailIndex];
      const img = tooltip.querySelector("img") as HTMLImageElement;
      const timestamp = tooltip.querySelector(".timestamp") as HTMLElement;

      if (img && timestamp) {
        img.src = `${FormatUtils.pathToFileUrl(currentThumbnail.path)}`;
        timestamp.textContent = FormatUtils.formatTimestamp(
          currentThumbnail.timestamp,
        );
      }
    }, 1000);
  }

  private hideThumbnailTooltip(): void {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }

    if (this.tooltipInterval) {
      clearInterval(this.tooltipInterval);
      this.tooltipInterval = null;
    }

    const existingTooltip = document.querySelector(".thumbnail-tooltip");
    if (existingTooltip) {
      existingTooltip.remove();
    }

    this.currentThumbnails = [];
    this.currentThumbnailIndex = 0;
  }

  // チャプターダイアログを表示
  private showChapterDialog(video: Video, startIndex: number = 0): void {
    logger.debug("showChapterDialog called for video:", video.id, video.title);
    logger.debug("video.chapterThumbnails:", video.chapterThumbnails);
    logger.debug(
      "video.chapterThumbnails type:",
      typeof video.chapterThumbnails,
    );

    if (!video.chapterThumbnails) {
      logger.debug("No chapterThumbnails found for video");
      this.notificationManager.show("チャプターサムネイルがありません", "info");
      return;
    }

    let chapters: ChapterThumbnail[] = [];
    try {
      if (Array.isArray(video.chapterThumbnails)) {
        logger.debug("chapterThumbnails is array:", video.chapterThumbnails);
        chapters = video.chapterThumbnails;
      } else if (typeof video.chapterThumbnails === "string") {
        logger.debug(
          "chapterThumbnails is string, parsing:",
          video.chapterThumbnails,
        );
        const parsed = JSON.parse(video.chapterThumbnails);
        logger.debug("Parsed chapterThumbnails:", parsed);
        if (Array.isArray(parsed)) {
          chapters = parsed as ChapterThumbnail[];
        } else if (typeof parsed === "object" && parsed !== null) {
          chapters = Object.values(parsed) as ChapterThumbnail[];
          logger.debug("Converted object to chapters array:", chapters);
        }
      } else if (
        typeof video.chapterThumbnails === "object" &&
        video.chapterThumbnails !== null
      ) {
        logger.debug("chapterThumbnails is object:", video.chapterThumbnails);
        chapters = Object.values(video.chapterThumbnails) as ChapterThumbnail[];
        logger.debug("Converted object to chapters array:", chapters);
      }
    } catch (error) {
      logger.warn("Failed to parse chapterThumbnails:", error);
      this.notificationManager.show(
        "チャプターサムネイルの読み込みに失敗しました",
        "error",
      );
      return;
    }

    logger.debug("Final chapters array:", chapters);
    logger.debug("chapters.length:", chapters.length);

    if (chapters.length === 0) {
      logger.debug("No valid chapters found");
      this.notificationManager.show("チャプターサムネイルがありません", "info");
      return;
    }

    this.uiRenderer.showChapterDialog(video, chapters, startIndex);
  }

  // キーボードイベントハンドラー
  private handleEscapeKey(_e: KeyboardEvent): void {
    if (this.currentVideo) {
      this.hideVideoDetails();
    }
  }

  private handleArrowKeys(e: KeyboardEvent): void {
    // モーダルやダイアログが開いている場合は、グリッド/リストナビゲーションを無効にする
    const chapterModal = document.getElementById("chapterDialog");
    const settingsModal = document.getElementById("settingsModal");
    const tagEditDialog = document.getElementById("tagEditDialog");
    const bulkTagApplyDialog = document.getElementById("bulkTagApplyDialog");
    const errorDialog = document.getElementById("errorDialog");
    const customThumbnailDialog = document.getElementById(
      "customThumbnailDialog",
    );

    if (
      (chapterModal && chapterModal.hasAttribute("is-open")) ||
      (settingsModal && settingsModal.hasAttribute("is-open")) ||
      (tagEditDialog && tagEditDialog.hasAttribute("is-open")) ||
      (bulkTagApplyDialog && bulkTagApplyDialog.hasAttribute("is-open")) ||
      (errorDialog && errorDialog.hasAttribute("is-open")) ||
      (customThumbnailDialog && customThumbnailDialog.style.display === "flex")
    ) {
      // 何らかのモーダル/ダイアログが開いている場合は何もしない
      // 各モーダル/ダイアログ側のキーボードハンドラーが処理する
      return;
    }

    // Navigate through video grid
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    const totalVideos = this.filteredVideos.length;

    if (totalVideos === 0) return;

    let newIndex = selectedIndex;
    const currentView = this.uiRenderer.getCurrentView();

    if (currentView === "grid") {
      // Grid view navigation
      const videosPerRow = this.calculateVideosPerRow();
      const currentRow = Math.floor(selectedIndex / videosPerRow);
      const currentCol = selectedIndex % videosPerRow;
      const totalRows = Math.ceil(totalVideos / videosPerRow);

      switch (e.key) {
        case "ArrowUp":
          if (currentRow > 0) {
            // Move up within the same column
            newIndex = selectedIndex - videosPerRow;
          } else {
            // Wrap to bottom row, same column
            const bottomRowStartIndex = (totalRows - 1) * videosPerRow;
            newIndex = Math.min(
              bottomRowStartIndex + currentCol,
              totalVideos - 1,
            );
          }
          break;
        case "ArrowDown":
          if (currentRow < totalRows - 1) {
            // Move down within the same column
            newIndex = Math.min(selectedIndex + videosPerRow, totalVideos - 1);
          } else {
            // Wrap to top row, same column
            newIndex = currentCol < totalVideos ? currentCol : 0;
          }
          break;
        case "ArrowLeft":
          if (selectedIndex > 0) {
            newIndex = selectedIndex - 1;
          } else {
            // Wrap to last video
            newIndex = totalVideos - 1;
          }
          break;
        case "ArrowRight":
          if (selectedIndex < totalVideos - 1) {
            newIndex = selectedIndex + 1;
          } else {
            // Wrap to first video
            newIndex = 0;
          }
          break;
      }
    } else {
      // List view navigation (1 item per row)
      switch (e.key) {
        case "ArrowUp":
        case "ArrowLeft":
          if (selectedIndex > 0) {
            newIndex = selectedIndex - 1;
          } else {
            newIndex = totalVideos - 1; // Wrap to last video
          }
          break;
        case "ArrowDown":
        case "ArrowRight":
          if (selectedIndex < totalVideos - 1) {
            newIndex = selectedIndex + 1;
          } else {
            newIndex = 0; // Wrap to first video
          }
          break;
      }
    }

    if (newIndex !== selectedIndex) {
      this.uiRenderer.setSelectedVideoIndex(newIndex);
      this.uiRenderer.ensureIndexRendered(newIndex);
      this.uiRenderer.highlightSelectedVideo();
      this.scrollToSelectedVideo();

      // 詳細パネルが開いている場合は、選択された動画の詳細を更新
      const detailsPanel = document.getElementById("detailsPanel");
      if (detailsPanel && detailsPanel.style.display !== "none") {
        const selectedVideo = this.filteredVideos[newIndex];
        if (selectedVideo) {
          this.showVideoDetails(selectedVideo);
        }
      }

      e.preventDefault();
    }
  }

  // Calculate videos per row for grid view
  private calculateVideosPerRow(): number {
    const videoList = document.getElementById("videoList");
    if (!videoList) return 4; // Default fallback

    const videoItems = videoList.querySelectorAll(".video-item");
    if (videoItems.length === 0) return 4;

    const firstVideoItem = videoItems[0] as HTMLElement;
    const containerWidth = videoList.clientWidth;
    const itemWidth = firstVideoItem.offsetWidth + 20; // Include margin

    return Math.floor(containerWidth / itemWidth) || 1;
  }

  // Scroll to selected video if it's out of view
  private scrollToSelectedVideo(): void {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    const videoItems = document.querySelectorAll(".video-item");

    if (selectedIndex >= 0 && videoItems[selectedIndex]) {
      const selectedItem = videoItems[selectedIndex];
      const container = document.getElementById("videoList");

      if (container) {
        const containerRect = container.getBoundingClientRect();
        const itemRect = selectedItem.getBoundingClientRect();

        if (
          itemRect.top < containerRect.top ||
          itemRect.bottom > containerRect.bottom
        ) {
          // コンテナ内でのスクロール位置を計算
          const htmlSelectedItem = selectedItem as HTMLElement;
          const itemOffsetTop = htmlSelectedItem.offsetTop;
          const containerHeight = container.clientHeight;
          const itemHeight = htmlSelectedItem.offsetHeight;

          // アイテムを画面中央に配置するためのスクロール位置を計算
          const targetScrollTop =
            itemOffsetTop - containerHeight / 2 + itemHeight / 2;

          // スムーズスクロール
          // scrollIntoViewは画面全体がスクロールしてしまいヘッダーが埋もれてしまうので使用しない
          container.scrollTo({
            top: targetScrollTop,
            behavior: "smooth",
          });
        }
      }
    }
  }

  private handleEnterKey(_e: KeyboardEvent): void {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    if (selectedIndex >= 0 && this.filteredVideos[selectedIndex]) {
      // Enterキーで動画を再生
      this.uiRenderer.playSelectedVideo(this.filteredVideos, (path: string) =>
        this.playVideo(path),
      );
    }
  }

  private handleSpaceKey(_e: KeyboardEvent): void {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    if (selectedIndex >= 0 && this.filteredVideos[selectedIndex]) {
      this.showVideoDetails(this.filteredVideos[selectedIndex]);
    }
  }

  // タグ管理機能
  private async editTag(tagName: string): Promise<void> {
    // カスタムダイアログでタグ名を入力
    const newTagName = await this.showTagEditDialog(tagName);
    if (!newTagName || newTagName === tagName) return;

    try {
      await this.videoManager.updateTag(tagName, newTagName);
      this.notificationManager.show("タグを更新しました", "success");

      // データを再読み込み
      await this.refreshData();
    } catch (error) {
      console.error("Error updating tag:", error);
      this.notificationManager.show("タグの更新に失敗しました", "error");
    }
  }

  // カスタムタグ編集ダイアログ
  private async showTagEditDialog(
    currentTagName: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      // ダイアログ要素を作成（DOM API で安全に構築）
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";

      const dialog = document.createElement("div");
      dialog.className = "dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "タグ名を編集");

      const title = document.createElement("h3");
      title.textContent = "タグ名を編集";

      const input = document.createElement("input");
      input.type = "text";
      input.id = "tagNameInput";
      input.value = currentTagName; // value プロパティは自動でエスケープされる
      input.setAttribute("aria-label", "タグ名");

      const dialogButtons = document.createElement("div");
      dialogButtons.className = "dialog-buttons";

      const saveBtn = document.createElement("button");
      saveBtn.id = "tagSaveBtn";
      saveBtn.textContent = "保存";

      const cancelBtn = document.createElement("button");
      cancelBtn.id = "tagCancelBtn";
      cancelBtn.textContent = "キャンセル";

      dialogButtons.appendChild(saveBtn);
      dialogButtons.appendChild(cancelBtn);

      dialog.appendChild(title);
      dialog.appendChild(input);
      dialog.appendChild(dialogButtons);
      overlay.appendChild(dialog);

      // イベントリスナーを追加
      const cleanup = () => {
        document.body.removeChild(overlay);
      };

      saveBtn.addEventListener("click", () => {
        const newName = input.value.trim();
        cleanup();
        resolve(newName || null);
      });

      cancelBtn.addEventListener("click", () => {
        cleanup();
        resolve(null);
      });

      // Escキーで閉じる
      overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          cleanup();
          resolve(null);
        }
      });

      // Enterキーで保存
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const newName = input.value.trim();
          cleanup();
          resolve(newName || null);
        }
      });

      // ダイアログを表示
      document.body.appendChild(overlay);
      input.focus();
      input.select();
    });
  }

  private async deleteTag(tagName: string): Promise<void> {
    if (!confirm(`タグ "${tagName}" を削除しますか？`)) return;

    try {
      await this.videoManager.deleteTag(tagName);
      this.notificationManager.show("タグを削除しました", "success");

      // データを再読み込み
      await this.refreshData();
    } catch (error) {
      console.error("Error deleting tag:", error);
      this.notificationManager.show("タグの削除に失敗しました", "error");
    }
  }

  // 設定関連
  private openSettingsModal(): void {
    // 設定ダイアログを表示する前にディレクトリリストを更新
    const directories = this.videoManager.getDirectories();
    this.uiRenderer.renderSettingsDirectories(directories);
    this.uiRenderer.showSettingsModal();
  }

  private closeSettingsModal(): void {
    this.uiRenderer.hideSettingsModal();
  }

  private async saveSettings(): Promise<void> {
    try {
      const qualityInput = document.getElementById(
        "thumbnailQuality",
      ) as HTMLSelectElement;
      const sizeInput = document.getElementById(
        "thumbnailSize",
      ) as HTMLSelectElement;
      const themeSelect = document.getElementById(
        "themeSelect",
      ) as HTMLSelectElement;
      const saveFilterStateCheckbox = document.getElementById(
        "saveFilterState",
      ) as HTMLInputElement;

      // サムネイル設定があれば保存
      if (qualityInput && sizeInput) {
        const settings = {
          quality: parseInt(qualityInput.value),
          size: sizeInput.value,
        };
        logger.log("App.ts - Saving thumbnail settings:", settings);
        await this.videoManager.updateThumbnailSettings(settings);
      }

      // テーマ設定を保存
      if (themeSelect) {
        localStorage.setItem("theme", themeSelect.value);
        // テーマを適用
        this.applyTheme(themeSelect.value);
      }

      // フィルタ状態保存設定を保存
      if (saveFilterStateCheckbox) {
        this.filterManager.setSaveFilterStateEnabled(
          saveFilterStateCheckbox.checked,
        );
      }

      this.notificationManager.show("設定を保存しました", "success");
      this.closeSettingsModal();
    } catch (error) {
      console.error("Error saving settings:", error);
      this.notificationManager.show("設定の保存に失敗しました", "error");
    }
  }

  private loadSettings(): void {
    // ローカルストレージから設定を読み込み
    const viewMode = localStorage.getItem("viewMode") || "grid";
    const videoList = document.getElementById("videoList");
    const viewModeBtn = document.getElementById("viewModeBtn");

    if (videoList && viewModeBtn) {
      if (viewMode === "list") {
        videoList.classList.add("list-view");
        viewModeBtn.textContent = "グリッド表示";
      } else {
        videoList.classList.add("grid-view");
        viewModeBtn.textContent = "リスト表示";
      }
    }

    // 設定ダイアログの各フィールドに保存された値を設定
    const themeSelect = document.getElementById(
      "themeSelect",
    ) as HTMLSelectElement;
    if (themeSelect) {
      const savedTheme = localStorage.getItem("theme") || "system";
      themeSelect.value = savedTheme;
      // 保存されたテーマを適用
      this.applyTheme(savedTheme);
    }

    const saveFilterStateCheckbox = document.getElementById(
      "saveFilterState",
    ) as HTMLInputElement;
    if (saveFilterStateCheckbox) {
      saveFilterStateCheckbox.checked =
        this.filterManager.isSaveFilterStateEnabled();
    }

    // 保存されたソート状態を復元
    const savedSortField = localStorage.getItem("sortField");
    const savedSortOrder = localStorage.getItem("sortOrder");
    if (savedSortField) {
      this.currentSort.field = savedSortField;
    }
    if (savedSortOrder === "ASC" || savedSortOrder === "DESC") {
      this.currentSort.order = savedSortOrder;
    }
    this.updateSortUI();

    // サムネイル設定はVideoManagerから取得する必要があるかもしれません
    // 必要に応じて実装
  }

  // テーマを適用するメソッド
  private applyTheme(theme: string): void {
    const body = document.body;

    // 既存のテーマクラスを削除
    body.classList.remove("theme-light", "theme-dark", "theme-system");

    switch (theme) {
      case "light":
        body.classList.add("theme-light");
        body.setAttribute("data-theme", "light");
        break;
      case "dark":
        body.classList.add("theme-dark");
        body.setAttribute("data-theme", "dark");
        break;
      case "system":
      default:
        body.classList.add("theme-system");
        // システム設定に従う場合は、prefers-color-schemeを使用
        const prefersDark = window.matchMedia(
          "(prefers-color-scheme: dark)",
        ).matches;
        body.setAttribute("data-theme", prefersDark ? "dark" : "light");
        break;
    }
  }

  // Bulk tag management
  private showBulkTagDialog(): void {
    // Get current filtered videos
    const currentVideos = this.filteredVideos || [];

    // Get all available tags
    const allTags = this.videoManager.getTags();

    // UIRendererのメソッドを呼び出し
    this.uiRenderer.showBulkTagApplyDialog(currentVideos, allTags);
  }

  // 表示中の全動画にタグを一括付与（クイック入力）
  private async applyQuickBulkTag(): Promise<void> {
    const input = document.getElementById(
      "quickBulkTagInput",
    ) as HTMLInputElement | null;
    if (!input) return;

    const rawValue = input.value.trim();
    if (!rawValue) {
      this.notificationManager.show("タグ名を入力してください", "warning");
      return;
    }

    const tagNames = rawValue
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (tagNames.length === 0) return;

    const targetVideos = this.filteredVideos || [];
    if (targetVideos.length === 0) {
      this.notificationManager.show("表示中の動画がありません", "warning");
      return;
    }

    try {
      let addedCount = 0;

      for (const video of targetVideos) {
        for (const tagName of tagNames) {
          const alreadyHas = video.tags && video.tags.includes(tagName);
          if (!alreadyHas) {
            await this.videoManager.addTagToVideo(video.id, tagName);
            // addTagToVideo がすでに同一オブジェクトのタグを更新済みのため push は不要
            this.uiRenderer.updateVideoTags(video.id, video.tags || []);
            addedCount++;
          }
        }
      }

      this.renderSidebar();
      input.value = "";

      const tagLabel =
        tagNames.length === 1
          ? `「${tagNames[0]}」`
          : `${tagNames.length}個のタグ`;
      const message =
        addedCount > 0
          ? `${targetVideos.length}本の動画に${tagLabel}を付与しました`
          : `対象動画は既に${tagLabel}を持っています`;
      this.notificationManager.show(
        message,
        addedCount > 0 ? "success" : "info",
      );
    } catch (error) {
      console.error("Error applying quick bulk tag:", error);
      this.notificationManager.show("タグの付与に失敗しました", "error");
    }
  }

  private async applyBulkTags(): Promise<void> {
    logger.log("applyBulkTags called");

    const bulkTagApplyDialog = DOMUtils.getElementById("bulkTagApplyDialog");
    if (!bulkTagApplyDialog) return;

    // Get all checkboxes (excluding select-all checkboxes)
    const checkboxes = bulkTagApplyDialog.querySelectorAll(
      ".tag-checkbox",
    ) as NodeListOf<HTMLInputElement>;
    const changes: BulkTagChange[] = [];

    // Collect all changes
    checkboxes.forEach((checkbox: HTMLInputElement) => {
      const videoIdStr = checkbox.dataset.videoId;
      const tagName = checkbox.dataset.tagName;
      const isChecked = checkbox.checked;

      if (!videoIdStr || !tagName) return;

      const videoId = parseInt(videoIdStr);

      // Find the video
      const video = this.filteredVideos.find((v) => v.id === videoId);
      if (!video) return;

      const currentlyHasTag = video.tags && video.tags.includes(tagName);

      if (isChecked && !currentlyHasTag) {
        // Add tag
        changes.push({
          videoId: videoId,
          tagName: tagName,
          action: "add",
        });
      } else if (!isChecked && currentlyHasTag) {
        // Remove tag
        changes.push({
          videoId: videoId,
          tagName: tagName,
          action: "remove",
        });
      }
    });

    logger.debug("Changes to apply:", changes);

    if (changes.length === 0) {
      this.notificationManager.show("変更がありません", "info");
      this.uiRenderer.hideBulkTagApplyDialog();
      return;
    }

    // Confirm changes
    const addCount = changes.filter(
      (c: BulkTagChange) => c.action === "add",
    ).length;
    const removeCount = changes.filter(
      (c: BulkTagChange) => c.action === "remove",
    ).length;
    const confirmMessage = `${addCount}個のタグ追加と${removeCount}個のタグ削除を実行しますか？`;

    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      // Apply changes
      let successCount = 0;
      let errorCount = 0;

      for (const change of changes) {
        try {
          if (change.action === "add") {
            await this.videoManager.addTagToVideo(
              change.videoId,
              change.tagName,
            );
          } else if (change.action === "remove") {
            await this.videoManager.removeTagFromVideo(
              change.videoId,
              change.tagName,
            );
          }

          // Update local video data
          const video = this.filteredVideos.find(
            (v) => v.id === change.videoId,
          );
          if (video) {
            if (change.action === "add") {
              if (!video.tags) video.tags = [];
              if (!video.tags.includes(change.tagName)) {
                video.tags.push(change.tagName);
              }
            } else if (change.action === "remove") {
              if (video.tags) {
                video.tags = video.tags.filter((tag) => tag !== change.tagName);
              }
            }

            // Update VideoManager local data (remove this if method doesn't exist)
            // this.videoManager.updateLocalVideoData(video);
          }

          successCount++;
        } catch (error) {
          console.error(
            `Error applying change for video ${change.videoId}, tag ${change.tagName}:`,
            error,
          );
          errorCount++;
        }
      }

      // Update UI
      this.renderVideoList();
      this.renderSidebar();
      this.applyFiltersAndSort();

      // Update current video details if open
      if (this.currentVideo) {
        const updatedCurrentVideo = this.filteredVideos.find(
          (v) => v.id === this.currentVideo!.id,
        );
        if (updatedCurrentVideo) {
          this.currentVideo = updatedCurrentVideo;
          this.uiRenderer.updateDetailsTagsDisplay(
            this.currentVideo.tags || [],
          );
        }
      }

      this.uiRenderer.hideBulkTagApplyDialog();

      if (errorCount === 0) {
        this.notificationManager.show(
          `タグの一括反映が完了しました (${successCount}件の変更)`,
          "success",
        );
      } else {
        this.notificationManager.show(
          `タグの一括反映が完了しました (成功: ${successCount}件、失敗: ${errorCount}件)`,
          "info",
        );
      }
    } catch (error) {
      console.error("Error in applyBulkTags:", error);
      this.notificationManager.show("タグの一括反映に失敗しました", "error");
    }
  }

  /**
   * Find duplicate videos
   */
  private async findDuplicates(): Promise<void> {
    try {
      const modal = document.getElementById("duplicateModal");
      const searchingState = document.getElementById("duplicateSearchingState");
      const resultsContainer = document.getElementById(
        "duplicateResultsContainer",
      );
      const groupsList = document.getElementById("duplicateGroupsList");
      const groupCount = document.getElementById("duplicateGroupCount");

      if (
        !modal ||
        !searchingState ||
        !resultsContainer ||
        !groupsList ||
        !groupCount
      )
        return;

      // Show progress dialog
      this.unifiedProgress.addProgress(
        "duplicate-search-progress",
        "重複動画を検索中...",
        0,
      );

      // Listen for progress updates
      const progressHandler = (data: {
        current: number;
        total: number;
        message: string;
      }) => {
        this.unifiedProgress.updateProgress(
          "duplicate-search-progress",
          data.current,
          `${data.message} (${data.current}/${data.total})`,
        );
      };
      window.electronAPI.onDuplicateSearchProgress(progressHandler);

      let duplicateGroups: DuplicateGroup[];
      try {
        // Find duplicates
        duplicateGroups = await window.electronAPI.findDuplicates();
      } finally {
        // Remove progress handler
        window.electronAPI.offDuplicateSearchProgress(progressHandler);
        this.unifiedProgress.completeProgress("duplicate-search-progress");
      }

      // Show modal with results
      modal.style.display = "flex";
      searchingState.style.display = "none";
      resultsContainer.style.display = "block";

      // Update count
      if (groupCount) {
        groupCount.textContent = duplicateGroups.length.toString();
      }

      // Clear previous results
      groupsList.replaceChildren();

      if (duplicateGroups.length === 0) {
        const noDuplicates = document.createElement("div");
        noDuplicates.className = "no-duplicates-message";

        const iconDiv = document.createElement("div");
        iconDiv.className = "icon";
        iconDiv.textContent = "✓";

        const message = document.createElement("p");
        message.textContent = "重複する動画は見つかりませんでした";

        noDuplicates.appendChild(iconDiv);
        noDuplicates.appendChild(message);
        groupsList.appendChild(noDuplicates);
        return;
      }

      // Render duplicate groups
      for (const group of duplicateGroups) {
        const groupEl = await this.createDuplicateGroupElement(group);
        groupsList.appendChild(groupEl);
      }

      // Update delete button state
      this.updateDeleteButtonState();
    } catch (error) {
      console.error("Failed to find duplicates:", error);
      this.notificationManager.show("重複動画の検索に失敗しました", "error");
      this.closeDuplicateModal();
    }
  }

  /**
   * アイコン付き span 要素を作成する
   */
  private createIconSpan(icon: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "icon";
    span.textContent = icon;
    return span;
  }

  /**
   * ボタンのラベルをアイコン付きで設定する（innerHTML 不使用・XSS 安全）
   */
  private setButtonLabel(
    button: HTMLButtonElement,
    icon: string,
    label: string,
  ): void {
    button.replaceChildren();
    button.appendChild(this.createIconSpan(icon));
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    button.appendChild(labelSpan);
  }

  /**
   * Create a duplicate group element
   */
  private async createDuplicateGroupElement(
    group: DuplicateGroup,
  ): Promise<HTMLElement> {
    const groupEl = document.createElement("div");
    groupEl.className = "duplicate-group";

    // Sort by quality (higher resolution first)
    const sortedVideos = [...group.videos].sort((a, b) => {
      const aQuality = a.width * a.height;
      const bQuality = b.width * b.height;
      return bQuality - aQuality;
    });

    // ヘッダーを作成（DOM API で安全に構築）
    const headerEl = document.createElement("div");
    headerEl.className = "duplicate-group-header";

    const titleEl = document.createElement("div");
    titleEl.className = "duplicate-group-title";
    titleEl.textContent = `グループ ${group.hash.substring(0, 8)}`;

    const statsEl = document.createElement("div");
    statsEl.className = "duplicate-group-stats";
    statsEl.textContent = `${group.videos.length} 件の重複`;

    headerEl.appendChild(titleEl);
    headerEl.appendChild(statsEl);

    // 各動画アイテムを作成
    const videosListEl = document.createElement("div");
    videosListEl.className = "duplicate-videos-list";

    for (let i = 0; i < sortedVideos.length; i++) {
      const video = sortedVideos[i];
      const index = i;
      const item = document.createElement("div");
      item.className = "duplicate-video-item";
      item.dataset.videoId = String(video.id);

      // チェックボックス
      const checkboxDiv = document.createElement("div");
      checkboxDiv.className = "duplicate-video-checkbox";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.videoId = String(video.id);
      checkbox.checked = index > 0;
      checkbox.setAttribute("aria-label", `削除対象: ${video.filename}`);

      checkboxDiv.appendChild(checkbox);

      // サムネイル
      if (video.thumbnailPath) {
        const img = document.createElement("img");
        img.src = `${FormatUtils.pathToFileUrl(video.thumbnailPath)}?t=${Date.now()}`;
        img.className = "duplicate-video-thumbnail";
        img.alt = video.filename;
        item.appendChild(img);
      }

      // 情報
      const infoDiv = document.createElement("div");
      infoDiv.className = "duplicate-video-info";

      const filenameDiv = document.createElement("div");
      filenameDiv.className = "duplicate-video-filename";
      filenameDiv.textContent = video.filename;

      const pathDiv = document.createElement("div");
      pathDiv.className = "duplicate-video-path";
      pathDiv.textContent = video.path;

      const detailsDiv = document.createElement("div");
      detailsDiv.className = "duplicate-video-details";

      const resolutionDetail = document.createElement("div");
      resolutionDetail.className = "duplicate-video-detail";
      resolutionDetail.appendChild(this.createIconSpan("📐"));
      const resolutionSpan = document.createElement("span");
      resolutionSpan.textContent = `${video.width}×${video.height}`;
      resolutionDetail.appendChild(resolutionSpan);

      const sizeDetail = document.createElement("div");
      sizeDetail.className = "duplicate-video-detail";
      sizeDetail.appendChild(this.createIconSpan("💾"));
      const sizeSpan = document.createElement("span");
      sizeSpan.textContent = FormatUtils.formatFileSize(Number(video.size));
      sizeDetail.appendChild(sizeSpan);

      const durationDetail = document.createElement("div");
      durationDetail.className = "duplicate-video-detail";
      durationDetail.appendChild(this.createIconSpan("⏱️"));
      const durationSpan = document.createElement("span");
      durationSpan.textContent = FormatUtils.formatDuration(video.duration);
      durationDetail.appendChild(durationSpan);

      detailsDiv.appendChild(resolutionDetail);
      detailsDiv.appendChild(sizeDetail);
      detailsDiv.appendChild(durationDetail);

      if (index === 0) {
        const recommended = document.createElement("div");
        recommended.className = "duplicate-video-detail";
        recommended.style.color = "var(--accent-color)";
        recommended.style.fontWeight = "600";
        recommended.textContent = "推奨: 保持";
        detailsDiv.appendChild(recommended);
      }

      infoDiv.appendChild(filenameDiv);
      infoDiv.appendChild(pathDiv);
      infoDiv.appendChild(detailsDiv);

      item.appendChild(checkboxDiv);
      item.appendChild(infoDiv);
      videosListEl.appendChild(item);
    }

    groupEl.appendChild(headerEl);
    groupEl.appendChild(videosListEl);

    // Add checkbox event listeners
    const checkboxes = groupEl.querySelectorAll('input[type="checkbox"]');

    // 初期表示時にチェックされているアイテムにselectedクラスを追加
    checkboxes.forEach((checkbox) => {
      const item = checkbox.closest(".duplicate-video-item");
      if (item && (checkbox as HTMLInputElement).checked) {
        item.classList.add("selected");
      }
    });

    checkboxes.forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const item = checkbox.closest(".duplicate-video-item");
        const isChecked = (checkbox as HTMLInputElement).checked;

        // 全てチェックされようとしている場合、最初にチェックされたものを自動的に外す
        if (isChecked) {
          const allCheckboxes = Array.from(checkboxes) as HTMLInputElement[];
          const checkedCount = allCheckboxes.filter((cb) => cb.checked).length;

          if (checkedCount === allCheckboxes.length) {
            // 最初にチェックされている別のチェックボックスを外す
            const firstChecked = allCheckboxes.find(
              (cb) => cb !== checkbox && cb.checked,
            );
            if (firstChecked) {
              firstChecked.checked = false;
              const firstItem = firstChecked.closest(".duplicate-video-item");
              if (firstItem) {
                firstItem.classList.remove("selected");
              }
            }
          }
        }

        if (item) {
          item.classList.toggle("selected", isChecked);
        }
        this.updateDeleteButtonState();
      });
    });

    // Add click event to video items (excluding checkbox area)
    const videoItems = groupEl.querySelectorAll(".duplicate-video-item");
    videoItems.forEach((item) => {
      item.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        // チェックボックス自体がクリックされた場合は何もしない
        if (
          (target as HTMLInputElement).type === "checkbox" ||
          target.closest(".duplicate-video-checkbox")
        ) {
          return;
        }

        const checkbox = item.querySelector(
          'input[type="checkbox"]',
        ) as HTMLInputElement;
        if (checkbox) {
          const willBeChecked = !checkbox.checked;

          // 全てチェックされようとしている場合、最初にチェックされたものを自動的に外す
          if (willBeChecked) {
            const allCheckboxes = Array.from(
              groupEl.querySelectorAll('input[type="checkbox"]'),
            ) as HTMLInputElement[];
            const checkedCount = allCheckboxes.filter(
              (cb) => cb.checked,
            ).length;

            if (checkedCount === allCheckboxes.length - 1) {
              // 最初にチェックされている別のチェックボックスを外す
              const firstChecked = allCheckboxes.find(
                (cb) => cb !== checkbox && cb.checked,
              );
              if (firstChecked) {
                firstChecked.checked = false;
                const firstItem = firstChecked.closest(".duplicate-video-item");
                if (firstItem) {
                  firstItem.classList.remove("selected");
                }
              }
            }
          }

          checkbox.checked = willBeChecked;
          item.classList.toggle("selected", willBeChecked);
          this.updateDeleteButtonState();
        }
      });
    });

    return groupEl;
  }

  /**
   * Update delete button state based on selection
   */
  private updateDeleteButtonState(): void {
    const deleteBtn = document.getElementById(
      "deleteDuplicatesBtn",
    ) as HTMLButtonElement;
    if (!deleteBtn) return;

    const checkedCount = document.querySelectorAll(
      '#duplicateGroupsList input[type="checkbox"]:checked',
    ).length;

    deleteBtn.disabled = checkedCount === 0;
    deleteBtn.textContent =
      checkedCount > 0
        ? `選択した${checkedCount}件の動画を削除`
        : "選択した動画を削除";
  }

  /**
   * Delete selected duplicate videos
   */
  private async deleteDuplicates(): Promise<void> {
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '#duplicateGroupsList input[type="checkbox"]:checked',
    );

    const videoIds = Array.from(checkboxes).map((cb) =>
      parseInt(cb.dataset.videoId || "0"),
    );

    if (videoIds.length === 0) return;

    const confirmed = confirm(
      `選択した${videoIds.length}件の動画を削除しますか？\n\n動画ファイルはゴミ箱に移動されます。`,
    );
    if (!confirmed) return;

    try {
      const deleteBtn = document.getElementById(
        "deleteDuplicatesBtn",
      ) as HTMLButtonElement;
      if (deleteBtn) {
        deleteBtn.disabled = true;
        deleteBtn.textContent = "削除中...";
      }

      const result = await window.electronAPI.deleteVideos(videoIds, true);

      this.closeDuplicateModal();

      // Reload videos
      await this.loadInitialData();

      if (result.failed === 0) {
        this.notificationManager.show(
          `${result.success}件の重複動画を削除しました`,
          "success",
        );
      } else {
        this.notificationManager.show(
          `${result.success}件削除しました（${result.failed}件失敗）`,
          "warning",
        );
      }
    } catch (error) {
      console.error("Failed to delete duplicates:", error);
      this.notificationManager.show("動画の削除に失敗しました", "error");
    }
  }

  /**
   * Close duplicate modal
   */
  private closeDuplicateModal(): void {
    const modal = document.getElementById("duplicateModal");
    if (modal) {
      modal.style.display = "none";
    }
  }
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.movieApp = new MovieLibraryApp();
});

export default MovieLibraryApp;
