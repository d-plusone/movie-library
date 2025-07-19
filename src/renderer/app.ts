import { FilterManager } from "./FilterManager.js";
import { VideoManager, Video, Tag, Directory } from "./VideoManager.js";
import { UIRenderer } from "./UIRenderer.js";
import {
  NotificationManager,
  ProgressManager,
  ThemeManager,
  KeyboardManager,
  FormatUtils,
  DOMUtils,
  Utils,
} from "./Utils.js";

interface SortState {
  field: string;
  order: "ASC" | "DESC";
}

interface ThumbnailData {
  path: string;
  timestamp: number;
  index: number;
}

interface BulkTagChange {
  action: "add" | "remove";
  videoId: number;
  tagName: string;
}

interface FilterState {
  selectedTags: Set<string>;
  selectedDirectories: Set<string>;
  searchQuery: string;
  ratingFilter: number;
}

interface DialogData {
  video: Video;
  element: HTMLElement;
}

interface KeyboardHandlers {
  onEscape: (e: KeyboardEvent) => void;
  onArrow: (e: KeyboardEvent) => void;
  onEnter: (e: KeyboardEvent) => void;
  onSpace: (e: KeyboardEvent) => void;
}

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
  private currentSort: SortState = { field: "filename", order: "ASC" };

  // Thumbnail and tooltip state
  private currentThumbnails: ThumbnailData[] = [];
  private currentThumbnailIndex: number = 0;
  private tooltipTimeout: NodeJS.Timeout | null = null;
  private tooltipInterval: NodeJS.Timeout | null = null;

  // Tag editing state
  private currentEditingTag: string | null = null;

  // Event delegation setup flag
  private eventDelegationSetup: boolean = false;

  // Managers
  private filterManager: FilterManager;
  private videoManager: VideoManager;
  private uiRenderer: UIRenderer;
  private notificationManager: NotificationManager;
  private progressManager: ProgressManager;
  private themeManager: ThemeManager;
  private keyboardManager: KeyboardManager;

  constructor() {
    // Initialize managers
    this.filterManager = new FilterManager();
    this.videoManager = new VideoManager();
    this.uiRenderer = new UIRenderer();
    this.notificationManager = new NotificationManager();
    this.progressManager = new ProgressManager();
    this.themeManager = new ThemeManager();

    // Initialize keyboard navigation
    this.keyboardManager = new KeyboardManager({
      onEscape: (e) => this.handleEscapeKey(e),
      onArrow: (e) => this.handleArrowKeys(e),
      onEnter: (e) => this.handleEnterKey(e),
      onSpace: (e) => this.handleSpaceKey(e),
    });

    this.initializeEventListeners();
    this.loadSettings(); // 設定を読み込み
    this.initializeThemeButton(); // テーマボタンの初期化

    this.loadInitialData().catch((error) => {
      console.error("Failed to load initial data:", error);
    });
  }

  // 安全にイベントリスナーを追加するメソッド
  private safeAddEventListener(
    elementId: string,
    event: string,
    handler: (e: Event) => void
  ): boolean {
    const element = document.getElementById(elementId);
    if (element && handler) {
      element.addEventListener(event, handler);
      console.log(`Event listener added for ${elementId} - ${event}`);
      return true;
    } else {
      console.warn(
        `Failed to add event listener for ${elementId} - element found: ${!!element}, handler: ${!!handler}`
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

  private async loadInitialData(): Promise<void> {
    try {
      // Check if electronAPI is available
      if (!window.electronAPI) {
        throw new Error(
          "electronAPI is not available - preload script may not have loaded"
        );
      }

      console.log("Starting initial data load...");

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

      console.log(
        `Loaded ${videos.length} videos, ${tags.length} tags, ${directories.length} directories`
      );

      // FilterManagerにディレクトリ情報を初期化（初回のみ）
      this.filterManager.updateAvailableDirectories(directories);

      // 初期表示
      this.filteredVideos = [...videos];
      this.renderAll();

      // フィルターイベントリスナーを設定
      this.filterManager.onFilterChange((filters) => {
        this.applyFiltersAndSort();
      });

      // 保存されたフィルタ状態を復元
      this.restoreFilterState();

      console.log("Initial data load completed successfully");
    } catch (error) {
      console.error("Error loading initial data:", error);
      this.notificationManager.show("データの読み込みに失敗しました", "error");
    }
  }

  private renderAll(): void {
    this.uiRenderer.renderVideoList(this.filteredVideos);
    this.uiRenderer.renderSidebar(
      this.videoManager.getTags(),
      this.videoManager.getDirectories(),
      this.filterManager.getCurrentFilter(),
      this.filterManager.getSelectedDirectories()
    );
    this.uiRenderer.updateStats(this.videoManager.getStats());
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
            videoTags.includes(tag)
          );
          if (!hasMatchingTag) return false;
        }

        // ディレクトリフィルター
        if (filterData.hasDirectoryFilter) {
          if (filterData.selectedDirectories.length === 0) {
            // ディレクトリが明示的に全解除された場合は何も表示しない
            return false;
          } else {
            // 選択されたディレクトリのいずれかに含まれるかチェック
            const hasMatchingDirectory = filterData.selectedDirectories.some(
              (dir: string) => video.path.startsWith(dir)
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
                tag.toLowerCase().includes(searchLower)
              ));
          if (!matchesSearch) return false;
        }

        return true;
      });

      // ソート
      this.filteredVideos.sort((a, b) => {
        let aValue = a[this.currentSort.field];
        let bValue = b[this.currentSort.field];

        // Null値の処理
        if (aValue == null) aValue = "";
        if (bValue == null) bValue = "";

        // 文字列比較
        if (typeof aValue === "string" && typeof bValue === "string") {
          const comparison = aValue.localeCompare(bValue);
          return this.currentSort.order === "ASC" ? comparison : -comparison;
        }

        // 数値比較
        if (typeof aValue === "number" && typeof bValue === "number") {
          return this.currentSort.order === "ASC"
            ? aValue - bValue
            : bValue - aValue;
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
    this.uiRenderer.renderVideoList(this.filteredVideos);
  }

  private renderSidebar(): void {
    const directories = this.videoManager.getDirectories();

    // 現在の選択状態を取得して表示に使用（状態の変更は行わない）
    const selectedDirectories = this.filterManager.getSelectedDirectories();

    this.uiRenderer.renderSidebar(
      this.videoManager.getTags(),
      directories,
      this.filterManager.getCurrentFilter(),
      selectedDirectories
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
          "searchInput"
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
    this.safeAddEventListener(
      "addDirectoryBtn",
      "click",
      this.addDirectory.bind(this)
    );
    this.safeAddEventListener(
      "scanDirectoriesBtn",
      "click",
      this.scanDirectories.bind(this)
    );
    this.safeAddEventListener(
      "generateThumbnailsBtn",
      "click",
      this.generateThumbnails.bind(this)
    );
    this.safeAddEventListener(
      "regenerateThumbnailsBtn",
      "click",
      this.regenerateAllThumbnails.bind(this)
    );
    // refreshBtn is not needed - data refresh is automatic
    this.safeAddEventListener(
      "themeToggleBtn",
      "click",
      this.toggleTheme.bind(this)
    );
    this.safeAddEventListener(
      "sortSelect",
      "change",
      this.handleSortChange.bind(this)
    );
    this.safeAddEventListener(
      "orderSelect",
      "change",
      this.handleSortChange.bind(this)
    );
    this.safeAddEventListener(
      "searchInput",
      "input",
      this.handleSearchInput.bind(this)
    );
    // View controls
    this.safeAddEventListener("gridViewBtn", "click", () =>
      this.setView("grid")
    );
    this.safeAddEventListener("listViewBtn", "click", () =>
      this.setView("list")
    );

    // Settings-related event listeners
    this.safeAddEventListener(
      "settingsBtn",
      "click",
      this.openSettingsModal.bind(this)
    );
    this.safeAddEventListener(
      "saveSettingsBtn",
      "click",
      this.saveSettings.bind(this)
    );
    this.safeAddEventListener(
      "cancelSettingsBtn",
      "click",
      this.closeSettingsModal.bind(this)
    );
    this.safeAddEventListener(
      "closeSettingsBtn",
      "click",
      this.closeSettingsModal.bind(this)
    );

    // Bulk tag management
    this.safeAddEventListener(
      "bulkTagApplyBtn",
      "click",
      this.showBulkTagDialog.bind(this)
    );
    this.safeAddEventListener(
      "applyBulkTagsBtn",
      "click",
      this.applyBulkTags.bind(this)
    );
    this.safeAddEventListener("closeBulkTagApplyDialog", "click", () =>
      this.uiRenderer.hideBulkTagApplyDialog()
    );
    this.safeAddEventListener("cancelBulkTagApplyBtn", "click", () =>
      this.uiRenderer.hideBulkTagApplyDialog()
    );

    // Event delegation for dynamic content
    this.setupEventDelegation();
  }

  private setupEventDelegation(): void {
    if (this.eventDelegationSetup) return;

    const videoList = document.getElementById("videoList");
    if (videoList) {
      videoList.addEventListener("click", this.handleVideoListClick.bind(this));
      videoList.addEventListener(
        "mouseenter",
        this.handleVideoListMouseEnter.bind(this),
        true
      );
      videoList.addEventListener(
        "mouseleave",
        this.handleVideoListMouseLeave.bind(this),
        true
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
      button.addEventListener("click", (e) => {
        const rating = parseInt(button.dataset.rating || "0");
        this.handleRatingFilter(rating);
      });

      // ホバーイベント
      button.addEventListener("mouseenter", (e) => {
        const rating = parseInt(button.dataset.rating || "0");
        this.handleRatingHover(rating, true);
      });

      button.addEventListener("mouseleave", (e) => {
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
      "deselectAllFoldersBtn"
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
    console.log("updateRatingDisplay called with rating:", rating);

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
        console.log(`Star ${btnRating} activated`);
      } else {
        button.classList.remove("active");
        button.textContent = "☆";
        console.log(`Star ${btnRating} deactivated`);
      }
    });
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

    if (videoItem && target.classList.contains("thumbnail")) {
      const videoId = parseInt(videoItem.dataset.videoId!);
      const video = this.filteredVideos.find((v) => v.id === videoId);

      if (video) {
        this.showThumbnailTooltip(target, video);
      }
    }
  }

  private handleVideoListMouseLeave(e: Event): void {
    const target = e.target as HTMLElement;

    if (target.classList.contains("thumbnail")) {
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
          "success"
        );
        this.renderSidebar();
      }
    } catch (error) {
      console.error("Error adding directory:", error);
      this.notificationManager.show(
        "ディレクトリの追加に失敗しました",
        "error"
      );
    }
  }

  private async removeDirectory(path: string): Promise<void> {
    if (!confirm(`ディレクトリ "${path}" を削除しますか？`)) {
      return;
    }

    try {
      await this.videoManager.removeDirectory(path);
      this.notificationManager.show("ディレクトリを削除しました", "success");
      this.renderSidebar();
    } catch (error) {
      console.error("Error removing directory:", error);
      this.notificationManager.show(
        "ディレクトリの削除に失敗しました",
        "error"
      );
    }
  }

  private async scanDirectories(): Promise<void> {
    try {
      this.progressManager.show("ディレクトリをスキャン中...");
      await this.videoManager.scanDirectories();
      await this.refreshData();
      this.notificationManager.show("スキャンが完了しました", "success");
    } catch (error) {
      console.error("Error scanning directories:", error);
      this.notificationManager.show("スキャンに失敗しました", "error");
    } finally {
      this.progressManager.hide();
    }
  }

  private async generateThumbnails(): Promise<void> {
    try {
      this.progressManager.show("サムネイルを生成中...");
      await this.videoManager.generateThumbnails();
      await this.refreshData();
      this.notificationManager.show("サムネイル生成が完了しました", "success");
    } catch (error) {
      console.error("Error generating thumbnails:", error);
      this.notificationManager.show("サムネイル生成に失敗しました", "error");
    } finally {
      this.progressManager.hide();
    }
  }

  private async regenerateAllThumbnails(): Promise<void> {
    try {
      this.progressManager.show("全サムネイルを再生成中...");
      await this.videoManager.regenerateAllThumbnails();
      await this.refreshData();
      this.notificationManager.show(
        "サムネイル再生成が完了しました",
        "success"
      );
    } catch (error) {
      console.error("Error regenerating thumbnails:", error);
      this.notificationManager.show("サムネイル再生成に失敗しました", "error");
    } finally {
      this.progressManager.hide();
    }
  }

  private async regenerateMainThumbnail(video: Video): Promise<void> {
    try {
      this.progressManager.show("メインサムネイルを再生成中...");
      const result = await this.videoManager.regenerateMainThumbnail(video.id);

      // UIの更新
      const videoElement = document.querySelector(
        `[data-video-id="${video.id}"]`
      );
      if (videoElement) {
        const thumbnail = videoElement.querySelector(
          ".thumbnail img"
        ) as HTMLImageElement;
        if (thumbnail) {
          // キャッシュバスターを追加してブラウザのキャッシュを回避
          thumbnail.src = `file://${result.thumbnail_path}?t=${Date.now()}`;
        }
      }

      this.notificationManager.show(
        "メインサムネイルを再生成しました",
        "success"
      );
    } catch (error) {
      console.error("Error regenerating main thumbnail:", error);
      this.notificationManager.show("サムネイル再生成に失敗しました", "error");
    } finally {
      this.progressManager.hide();
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

      this.notificationManager.show("データを更新しました", "success");
    } catch (error) {
      console.error("Error refreshing data:", error);
      this.notificationManager.show("データの更新に失敗しました", "error");
    } finally {
      this.progressManager.hide();
    }
  }

  private toggleTheme(): void {
    this.themeManager.toggleTheme();
    this.initializeThemeButton();
  }

  private handleSortChange(e: Event): void {
    const target = e.target as HTMLSelectElement;
    const [field, order] = target.value.split(":");
    this.currentSort = { field, order: order as "ASC" | "DESC" };
    this.applyFiltersAndSort();
  }

  private handleSearchInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    // FilterManagerに検索状態を通知
    this.filterManager.updateSearch(target.value);
    // 検索入力時にフィルタリングを実行
    this.applyFiltersAndSort();
  }

  private setView(view) {
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

  private toggleViewMode(): void {
    const viewModeBtn = document.getElementById("viewModeBtn");
    const videoList = document.getElementById("videoList");

    if (viewModeBtn && videoList) {
      const isGrid = videoList.classList.contains("grid-view");

      if (isGrid) {
        videoList.classList.remove("grid-view");
        videoList.classList.add("list-view");
        viewModeBtn.textContent = "グリッド表示";
      } else {
        videoList.classList.remove("list-view");
        videoList.classList.add("grid-view");
        viewModeBtn.textContent = "リスト表示";
      }

      // 設定を保存
      localStorage.setItem("viewMode", isGrid ? "list" : "grid");
    }
  }

  private async playVideo(videoPath: string): Promise<void> {
    try {
      await this.videoManager.playVideo(videoPath);
    } catch (error) {
      console.error("Error playing video:", error);
      this.notificationManager.show("動画の再生に失敗しました", "error");
    }
  }

  private showVideoDetails(video: Video): void {
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
      "refreshMainThumbnailBtn"
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

    // レーティング星のクリックイベント
    ratingStars.forEach((star, index) => {
      star.addEventListener("click", () => {
        this.setVideoRating(index + 1);
      });
    });

    // タグ入力のイベント処理
    const tagInput = document.getElementById("tagInput") as HTMLInputElement;
    if (tagInput) {
      tagInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.addTagToCurrentVideo();
        }
      });
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
      "detailsChapterThumbnails"
    );
    if (chapterContainer) {
      chapterContainer.onclick = (e) => {
        const target = e.target as HTMLElement;
        const chapterThumbnail = target.closest(".chapter-thumbnail");
        if (chapterThumbnail && this.currentVideo) {
          this.showChapterDialog(this.currentVideo);
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
        "detailsTitleInput"
      ) as HTMLInputElement;
      const descriptionInput = document.getElementById(
        "detailsDescriptionInput"
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
    const tagName = tagInput.value.trim();

    if (!tagName) {
      this.notificationManager.show("タグ名を入力してください", "warning");
      return;
    }

    try {
      await this.videoManager.addTagToVideo(this.currentVideo.id, tagName);

      // ローカルデータを更新
      if (!this.currentVideo.tags) {
        this.currentVideo.tags = [];
      }
      if (!this.currentVideo.tags.includes(tagName)) {
        this.currentVideo.tags.push(tagName);
      }

      // UIを更新
      this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags || []);
      this.renderVideoList();
      this.renderSidebar();

      tagInput.value = "";
      this.notificationManager.show("タグを追加しました", "success");
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
          (tag) => tag !== tagName
        );
      }

      // UIを更新
      this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags || []);
      this.renderVideoList();
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

      // UIを更新
      this.uiRenderer.updateDetailsRatingDisplay(rating);
      this.renderVideoList();

      this.notificationManager.show(`評価を${rating}に設定しました`, "success");
    } catch (error) {
      console.error("Error setting rating:", error);
      this.notificationManager.show("評価の設定に失敗しました", "error");
    }
  }

  private showThumbnailTooltip(element: HTMLElement, video: Video): void {
    this.hideThumbnailTooltip();

    // チャプターサムネイルがない場合は何もしない
    if (!video.chapter_thumbnails) return;

    let chapterThumbnails: ThumbnailData[];
    try {
      chapterThumbnails =
        typeof video.chapter_thumbnails === "string"
          ? JSON.parse(video.chapter_thumbnails)
          : video.chapter_thumbnails;
    } catch {
      return;
    }

    if (!chapterThumbnails || chapterThumbnails.length === 0) return;

    this.currentThumbnails = chapterThumbnails;
    this.currentThumbnailIndex = 0;

    // ツールチップを表示
    const tooltip = this.uiRenderer.createThumbnailTooltip(
      chapterThumbnails[0].path,
      FormatUtils.formatTimestamp(chapterThumbnails[0].timestamp)
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
        img.src = `file://${currentThumbnail.path}`;
        timestamp.textContent = FormatUtils.formatTimestamp(
          currentThumbnail.timestamp
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
  private showChapterDialog(video: Video): void {
    if (!video.chapter_thumbnails) {
      this.notificationManager.show("チャプターサムネイルがありません", "info");
      return;
    }

    let chapters: any[] = [];
    try {
      if (Array.isArray(video.chapter_thumbnails)) {
        chapters = video.chapter_thumbnails;
      } else if (typeof video.chapter_thumbnails === "string") {
        const parsed = JSON.parse(video.chapter_thumbnails);
        if (Array.isArray(parsed)) {
          chapters = parsed;
        } else if (typeof parsed === "object" && parsed !== null) {
          chapters = Object.values(parsed).filter(
            (item: any) => item && (item.path || item.thumbnail_path)
          );
        }
      } else if (
        typeof video.chapter_thumbnails === "object" &&
        video.chapter_thumbnails !== null
      ) {
        chapters = Object.values(video.chapter_thumbnails).filter(
          (item: any) => item && (item.path || item.thumbnail_path)
        );
      }
    } catch (error) {
      console.warn("Failed to parse chapter_thumbnails:", error);
      this.notificationManager.show(
        "チャプターサムネイルの読み込みに失敗しました",
        "error"
      );
      return;
    }

    if (chapters.length === 0) {
      this.notificationManager.show("チャプターサムネイルがありません", "info");
      return;
    }

    this.uiRenderer.showChapterDialog(video, chapters);
  }

  // キーボードイベントハンドラー
  private handleEscapeKey(e: KeyboardEvent): void {
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

    if (
      (chapterModal && chapterModal.hasAttribute("is-open")) ||
      (settingsModal && settingsModal.hasAttribute("is-open")) ||
      (tagEditDialog && tagEditDialog.hasAttribute("is-open")) ||
      (bulkTagApplyDialog && bulkTagApplyDialog.hasAttribute("is-open")) ||
      (errorDialog && errorDialog.hasAttribute("is-open"))
    ) {
      // 何らかのモーダル/ダイアログが開いている場合は何もしない
      // 各モーダル/ダイアログ側のキーボードハンドラーが処理する
      e.preventDefault();
      e.stopPropagation();
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
              totalVideos - 1
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

  private handleEnterKey(e: KeyboardEvent): void {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    if (selectedIndex >= 0 && this.filteredVideos[selectedIndex]) {
      this.showVideoDetails(this.filteredVideos[selectedIndex]);
    }
  }

  private handleSpaceKey(e: KeyboardEvent): void {
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
    currentTagName: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      // ダイアログ要素を作成
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";
      overlay.innerHTML = `
        <div class="dialog">
          <h3>タグ名を編集</h3>
          <input type="text" id="tagNameInput" value="${currentTagName}" />
          <div class="dialog-buttons">
            <button id="tagSaveBtn">保存</button>
            <button id="tagCancelBtn">キャンセル</button>
          </div>
        </div>
      `;

      // イベントリスナーを追加
      const input = overlay.querySelector("#tagNameInput") as HTMLInputElement;
      const saveBtn = overlay.querySelector("#tagSaveBtn") as HTMLButtonElement;
      const cancelBtn = overlay.querySelector(
        "#tagCancelBtn"
      ) as HTMLButtonElement;

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
    this.uiRenderer.showSettingsModal();
  }

  private closeSettingsModal(): void {
    this.uiRenderer.hideSettingsModal();
  }

  private async saveSettings(): Promise<void> {
    try {
      const qualityInput = document.getElementById(
        "thumbnailQuality"
      ) as HTMLSelectElement;
      const sizeInput = document.getElementById(
        "thumbnailSize"
      ) as HTMLSelectElement;
      const themeSelect = document.getElementById(
        "themeSelect"
      ) as HTMLSelectElement;
      const saveFilterStateCheckbox = document.getElementById(
        "saveFilterState"
      ) as HTMLInputElement;

      // サムネイル設定があれば保存
      if (qualityInput && sizeInput) {
        const settings = {
          quality: parseInt(qualityInput.value),
          size: sizeInput.value,
        };
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
          saveFilterStateCheckbox.checked
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
      "themeSelect"
    ) as HTMLSelectElement;
    if (themeSelect) {
      const savedTheme = localStorage.getItem("theme") || "system";
      themeSelect.value = savedTheme;
      // 保存されたテーマを適用
      this.applyTheme(savedTheme);
    }

    const saveFilterStateCheckbox = document.getElementById(
      "saveFilterState"
    ) as HTMLInputElement;
    if (saveFilterStateCheckbox) {
      saveFilterStateCheckbox.checked =
        this.filterManager.isSaveFilterStateEnabled();
    }

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
          "(prefers-color-scheme: dark)"
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

  private async applyBulkTags(): Promise<void> {
    console.log("applyBulkTags called");

    const bulkTagApplyDialog = DOMUtils.getElementById("bulkTagApplyDialog");
    if (!bulkTagApplyDialog) return;

    // Get all checkboxes (excluding select-all checkboxes)
    const checkboxes = bulkTagApplyDialog.querySelectorAll(
      ".tag-checkbox"
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

    console.log("Changes to apply:", changes);

    if (changes.length === 0) {
      this.notificationManager.show("変更がありません", "info");
      this.uiRenderer.hideBulkTagApplyDialog();
      return;
    }

    // Confirm changes
    const addCount = changes.filter(
      (c: BulkTagChange) => c.action === "add"
    ).length;
    const removeCount = changes.filter(
      (c: BulkTagChange) => c.action === "remove"
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
              change.tagName
            );
          } else if (change.action === "remove") {
            await this.videoManager.removeTagFromVideo(
              change.videoId,
              change.tagName
            );
          }

          // Update local video data
          const video = this.filteredVideos.find(
            (v) => v.id === change.videoId
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
            error
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
          (v) => v.id === this.currentVideo!.id
        );
        if (updatedCurrentVideo) {
          this.currentVideo = updatedCurrentVideo;
          this.uiRenderer.updateDetailsTagsDisplay(
            this.currentVideo.tags || []
          );
        }
      }

      this.uiRenderer.hideBulkTagApplyDialog();

      if (errorCount === 0) {
        this.notificationManager.show(
          `タグの一括反映が完了しました (${successCount}件の変更)`,
          "success"
        );
      } else {
        this.notificationManager.show(
          `タグの一括反映が完了しました (成功: ${successCount}件、失敗: ${errorCount}件)`,
          "info"
        );
      }
    } catch (error) {
      console.error("Error in applyBulkTags:", error);
      this.notificationManager.show("タグの一括反映に失敗しました", "error");
    }
  }
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.movieApp = new MovieLibraryApp();
});

export default MovieLibraryApp;
