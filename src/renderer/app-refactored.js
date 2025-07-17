import { FilterManager } from './FilterManager.js';
import { VideoManager } from './VideoManager.js';
import { UIRenderer } from './UIRenderer.js';
import { 
  NotificationManager, 
  ProgressManager, 
  ThemeManager, 
  KeyboardManager,
  FormatUtils,
  DOMUtils,
  Utils
} from './Utils.js';

/**
 * メインアプリケーションクラス
 * 各モジュールを統合し、イベントハンドリングを管理
 */
class MovieLibraryApp {
  constructor() {
    // Core data
    this.filteredVideos = [];
    this.currentVideo = null;
    this.currentSort = { field: "filename", order: "ASC" };
    
    // Thumbnail and tooltip state
    this.currentThumbnails = [];
    this.currentThumbnailIndex = 0;
    this.tooltipTimeout = null;
    this.tooltipInterval = null;
    
    // Tag editing state
    this.currentEditingTag = null;

    // Event delegation setup flag
    this.eventDelegationSetup = false;

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
      onSpace: (e) => this.handleSpaceKey(e)
    });

    this.initializeEventListeners();
    this.loadSettings(); // 設定を読み込み
    this.initializeThemeButton(); // テーマボタンの初期化
    
    this.loadInitialData().catch(error => {
      console.error("Failed to load initial data:", error);
    });
  }

  // 安全にイベントリスナーを追加するメソッド
  safeAddEventListener(elementId, event, handler) {
    const element = document.getElementById(elementId);
    if (element && handler) {
      element.addEventListener(event, handler);
      console.log(`Event listener added for ${elementId} - ${event}`);
      return true;
    } else {
      console.warn(`Failed to add event listener for ${elementId} - element found: ${!!element}, handler: ${!!handler}`);
    }
    return false;
  }

  initializeThemeButton() {
    const themeBtn = DOMUtils.getElementById("themeToggleBtn");
    if (themeBtn) {
      const icon = themeBtn.querySelector(".icon");
      if (icon) {
        const currentTheme = this.themeManager.getCurrentTheme();
        icon.textContent = currentTheme === "dark" ? "☀️" : "🌙";
      }
    }
  }

  async loadInitialData() {
    try {
      // Check if electronAPI is available
      if (!window.electronAPI) {
        throw new Error("electronAPI is not available - preload script may not have loaded");
      }
      
      await this.videoManager.loadVideos();
      await this.videoManager.loadTags();
      await this.videoManager.loadDirectories();
      
      // Initialize directories in filter manager
      this.filterManager.initializeDirectories(this.videoManager.getDirectories());
      
      // フィルター状態を復元してからUIを更新（loadDirectories後に実行）
      this.filterManager.loadFilterState();
      
      // タグオートコンプリート候補を設定
      const allTags = this.videoManager.getTags();
      this.uiRenderer.updateTagSuggestions(allTags);
      
      // まずサイドバーとビデオリストを描画してDOM要素を作成
      this.renderVideoList();
      this.renderSidebar();

      // DOM要素が作成された後に少し待ってからUIの状態を更新
      setTimeout(() => {
        console.log("Updating UI with loaded filter state (after DOM creation):");
        const currentFilter = this.filterManager.getCurrentFilter();
        const selectedDirectories = this.filterManager.getSelectedDirectories();
        console.log("- Rating:", currentFilter.rating);
        console.log("- Tags:", currentFilter.tags);
        console.log("- Directories:", selectedDirectories);
        
        this.uiRenderer.updateStarDisplay(currentFilter.rating, false);
        const allBtn = document.querySelector('.rating-btn.all-btn[data-rating="0"]');
        if (allBtn) {
          if (currentFilter.rating === 0) {
            allBtn.classList.add('active');
            console.log("- All button set to active (delayed)");
          } else {
            allBtn.classList.remove('active');
            console.log("- All button set to inactive (delayed)");
          }
        } else {
          console.log("- All button not found (delayed)");
        }
        
        // Initialize theme button
        this.initializeThemeButton();
        
        // タグとディレクトリフィルタを適用
        this.applyFiltersAndSort();
      }, 100); // 100ms後に実行
      
    } catch (error) {
      console.error("Error loading initial data:", error);
      this.showErrorDialog("データの読み込みに失敗しました", error);
    }
  }

  initializeEventListeners() {
    // Header actions - safe event listener addition
    this.safeAddEventListener("addDirectoryBtn", "click", () => this.addDirectory());
    this.safeAddEventListener("scanDirectoriesBtn", "click", () => this.scanDirectories());
    this.safeAddEventListener("generateThumbnailsBtn", "click", () => this.regenerateThumbnails());
    this.safeAddEventListener("themeToggleBtn", "click", () => this.toggleTheme());
    this.safeAddEventListener("settingsBtn", "click", () => this.showSettings());
    
    // 設定ボタンを強制的に再設定（デバッグ用）
    const settingsBtn = document.getElementById("settingsBtn");
    if (settingsBtn) {
      console.log("Settings button found, adding click listener manually");
      settingsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        console.log("Settings button clicked!");
        this.showSettings();
      });
    } else {
      console.error("Settings button not found in DOM!");
    }

    // Search
    this.safeAddEventListener("searchInput", "input", (e) => this.handleSearch(e.target.value));

    // View controls
    this.safeAddEventListener("gridViewBtn", "click", () => this.setView("grid"));
    this.safeAddEventListener("listViewBtn", "click", () => this.setView("list"));

    // Sort controls
    this.safeAddEventListener("sortSelect", "change", (e) => {
      this.currentSort.field = e.target.value;
      this.applyFiltersAndSort();
    });
    
    this.safeAddEventListener("orderSelect", "change", (e) => {
      this.currentSort.order = e.target.value;
      this.applyFiltersAndSort();
    });

    // Rating filter - star hover system
    this.initializeRatingFilter();

    // Folder selection controls
    this.safeAddEventListener("selectAllFoldersBtn", "click", () => this.selectAllDirectories());
    this.safeAddEventListener("deselectAllFoldersBtn", "click", () => this.deselectAllDirectories());

    // Tag controls
    this.safeAddEventListener("clearAllTagsBtn", "click", () => this.clearAllTags());

    // Settings and dialogs
    this.initializeDialogEventListeners();

    // Settings specific events
    this.initializeSettingsEventListeners();

    // Video list and sidebar event delegation - call once during initialization
    this.setupEventDelegation();

    // Progress events
    if (window.electronAPI) {
      window.electronAPI.onScanProgress((data) => this.handleScanProgress(data));
      window.electronAPI.onThumbnailProgress((data) => this.handleThumbnailProgress(data));
      window.electronAPI.onVideoAdded((filePath) => this.handleVideoAdded(filePath));
      window.electronAPI.onVideoRemoved((filePath) => this.handleVideoRemoved(filePath));
    }
  }

  initializeRatingFilter() {
    const ratingFilterContainer = document.querySelector('.rating-filter');
    if (ratingFilterContainer) {
      // Add hover events for star visualization
      ratingFilterContainer.addEventListener('mousemove', (e) => {
        const target = e.target.closest('.rating-btn[data-rating]:not([data-rating="0"])');
        if (target) {
          const rating = parseInt(target.dataset.rating);
          this.uiRenderer.updateStarDisplay(rating, true);
        }
      });
      
      ratingFilterContainer.addEventListener('mouseleave', () => {
        // Reset to current filter rating
        const currentFilter = this.filterManager.getCurrentFilter();
        this.uiRenderer.updateStarDisplay(currentFilter.rating, false);
      });
      
      ratingFilterContainer.addEventListener('click', (e) => {
        const starBtn = e.target.closest('.rating-btn[data-rating]:not([data-rating="0"])');
        if (starBtn) {
          const rating = parseInt(starBtn.dataset.rating);
          this.setRatingFilter(rating);
        }
      });
    }

    // "All" button for rating filter
    const allRatingBtn = document.querySelector('.rating-btn.all-btn[data-rating="0"]');
    if (allRatingBtn) {
      allRatingBtn.addEventListener('click', () => {
        this.setRatingFilter(0);
      });
    }
  }

  initializeDialogEventListeners() {
    // Settings modal
    this.safeAddEventListener("closeSettingsBtn", "click", () => this.hideSettings());
    this.safeAddEventListener("saveSettingsBtn", "click", () => this.saveSettings());
    this.safeAddEventListener("cancelSettingsBtn", "click", () => this.hideSettings());
    this.safeAddEventListener("addDirectorySettingsBtn", "click", () => this.addDirectory());
    this.safeAddEventListener("rescanAllBtn", "click", () => this.rescanAll());
    this.safeAddEventListener("regenerateThumbnailsBtn", "click", () => this.regenerateThumbnails());
    this.safeAddEventListener("cleanupThumbnailsBtn", "click", () => this.cleanupThumbnails());

    // Theme settings (removed auto-save)
    // this.safeAddEventListener("themeSelect", "change", (e) => {
    //   this.themeManager.applyTheme(e.target.value);
    // });

    // Filter settings (removed auto-save)
    // this.safeAddEventListener("saveFilterState", "change", (e) => {
    //   this.filterManager.setSaveFilterStateEnabled(e.target.checked);
    // });

    // Thumbnail settings (removed auto-save)
    // this.safeAddEventListener("thumbnailQuality", "change", () => this.updateThumbnailSettings());
    // this.safeAddEventListener("thumbnailSize", "change", () => this.updateThumbnailSettings());

    // Modal backdrop clicks
    const settingsModal = document.getElementById("settingsModal");
    if (settingsModal) {
      settingsModal.addEventListener("click", (e) => {
        if (e.target.id === "settingsModal") {
          this.hideSettings();
        }
      });
    }

    // Details panel
    this.initializeDetailsEventListeners();

    // Error dialog events
    this.initializeErrorDialogEventListeners();

    // Tag edit dialog events
    this.initializeTagEditDialogEventListeners();

    // Thumbnail modal events
    this.initializeThumbnailModalEventListeners();
  }

  initializeDetailsEventListeners() {
    this.safeAddEventListener("closeDetailsBtn", "click", () => this.hideDetails());
    this.safeAddEventListener("saveDetailsBtn", "click", () => this.saveVideoDetails());
    this.safeAddEventListener("playVideoBtn", "click", () => this.playCurrentVideo());
    this.safeAddEventListener("refreshMainThumbnailBtn", "click", () => this.refreshMainThumbnail());

    // Main thumbnail click to show modal
    this.safeAddEventListener("detailsMainThumbnail", "click", () => {
      if (this.currentVideo) {
        this.showThumbnailModal(this.currentVideo, 0);
      }
    });

    // タグ入力は setupVideoDetailsListeners で処理するため、ここでは設定しない
  }

  initializeErrorDialogEventListeners() {
    this.safeAddEventListener("closeErrorBtn", "click", () => this.hideErrorDialog());
    this.safeAddEventListener("errorOkBtn", "click", () => this.hideErrorDialog());
    this.safeAddEventListener("showErrorDetailsBtn", "click", () => this.toggleErrorDetails());

    const errorDialog = document.getElementById("errorDialog");
    if (errorDialog) {
      errorDialog.addEventListener("click", (e) => {
        if (e.target.id === "errorDialog") {
          this.hideErrorDialog();
        }
      });
    }
  }

  initializeTagEditDialogEventListeners() {
    this.safeAddEventListener("closeTagEditBtn", "click", () => this.hideTagEditDialog());
    this.safeAddEventListener("cancelTagEditBtn", "click", () => this.hideTagEditDialog());
    this.safeAddEventListener("saveTagEditBtn", "click", () => this.saveTagEdit());

    const tagEditDialog = document.getElementById("tagEditDialog");
    if (tagEditDialog) {
      tagEditDialog.addEventListener("click", (e) => {
        if (e.target.id === "tagEditDialog") {
          this.hideTagEditDialog();
        }
      });
    }

    this.safeAddEventListener("tagNameInput", "keypress", (e) => {
      if (e.key === "Enter") {
        this.saveTagEdit();
      }
    });
  }

  initializeSettingsEventListeners() {
    // Theme selection
    this.safeAddEventListener("themeSelect", "change", (e) => {
      const selectedTheme = e.target.value;
      this.themeManager.applyTheme(selectedTheme);
      this.initializeThemeButton(); // Update theme toggle button
    });

    // Save filter state checkbox
    this.safeAddEventListener("saveFilterState", "change", (e) => {
      this.filterManager.setSaveFilterStateEnabled(e.target.checked);
      this.saveSettings();
    });

    // Other settings event listeners can be added here
  }

  initializeThumbnailModalEventListeners() {
    this.safeAddEventListener("closeThumbnailBtn", "click", () => this.hideThumbnailModal());
    this.safeAddEventListener("prevThumbnailBtn", "click", () => this.showPreviousThumbnail());
    this.safeAddEventListener("nextThumbnailBtn", "click", () => this.showNextThumbnail());

    const thumbnailModal = document.getElementById("thumbnailModal");
    if (thumbnailModal) {
      thumbnailModal.addEventListener("click", (e) => {
        if (e.target.id === "thumbnailModal") {
          this.hideThumbnailModal();
        }
      });
    }
  }

  // Event delegation for dynamic content
  setupEventDelegation() {
    // Prevent duplicate event delegation setup
    if (this.eventDelegationSetup) {
      console.log("Event delegation already set up, skipping...");
      return;
    }

    console.log("Setting up event delegation...");
    this.eventDelegationSetup = true;
    // Video list event delegation
    const videoList = document.getElementById("videoList");
    if (videoList) {
      videoList.addEventListener("click", (e) => {
        const videoItem = e.target.closest('.video-item');
        if (videoItem) {
          const index = parseInt(videoItem.dataset.index);
          const video = this.filteredVideos[index];
          if (video) {
            this.uiRenderer.setSelectedVideoIndex(index);
            // filteredVideosの最新データを使用
            this.showDetails(video);
            this.uiRenderer.highlightSelectedVideo();
          }
        }
      });

      videoList.addEventListener("dblclick", (e) => {
        const videoItem = e.target.closest('.video-item');
        if (videoItem) {
          const index = parseInt(videoItem.dataset.index);
          const video = this.filteredVideos[index];
          if (video) {
            this.playVideo(video);
          }
        }
      });

      // Tooltip events
      videoList.addEventListener("mouseenter", (e) => {
        const videoItem = e.target.closest('.video-item');
        if (videoItem) {
          const index = parseInt(videoItem.dataset.index);
          const video = this.filteredVideos[index];
          if (video) {
            // Only show tooltip in list view
            if (this.uiRenderer.getCurrentView() === 'list') {
              this.uiRenderer.showVideoTooltip(e, video);
            }
          }
        }
      }, true);

      videoList.addEventListener("mouseleave", (e) => {
        const videoItem = e.target.closest('.video-item');
        if (videoItem) {
          // Only hide tooltip in list view
          if (this.uiRenderer.getCurrentView() === 'list') {
            this.uiRenderer.hideTooltip();
          }
        }
      }, true);
    }

    // Sidebar event delegation - use .sidebar class instead of #sidebar
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      sidebar.addEventListener("click", (e) => {
        // Tag filter clicks
        const tagItem = e.target.closest('.tag-item');
        if (tagItem) {
          const tagName = tagItem.dataset.tagName;
          if (e.target.classList.contains('tag-name') || e.target.classList.contains('search-btn')) {
            this.filterByTag(tagName);
          } else if (e.target.classList.contains('edit-btn')) {
            this.editTag(tagName);
          } else if (e.target.classList.contains('delete-btn')) {
            this.deleteTag(tagName);
          }
          return;
        }

        // Directory selection clicks
        const directoryItem = e.target.closest('.directory-item');
        if (directoryItem) {
          const directoryPath = directoryItem.dataset.directoryPath;
          if (e.target.classList.contains('directory-name')) {
            this.toggleDirectorySelection(directoryPath);
          } else if (e.target.classList.contains('remove-btn')) {
            this.removeDirectory(directoryPath);
          }
        }
      });
    } else {
      console.warn("setupEventDelegation - sidebar element not found");
    }

    // Settings dialog event delegation
    const settingsModal = document.getElementById("settingsModal");
    if (settingsModal) {
      settingsModal.addEventListener("click", (e) => {
        if (e.target.classList.contains('remove-btn') && e.target.dataset.directoryPath) {
          this.removeDirectory(e.target.dataset.directoryPath);
        }
      });
    }

    // Details panel event delegation for tag removal
    const detailsPanel = document.getElementById("detailsPanel");
    if (detailsPanel) {
      detailsPanel.addEventListener("click", (e) => {
        if (e.target.classList.contains('remove-tag-btn')) {
          const tagName = e.target.dataset.tag;
          if (tagName) {
            this.removeTagFromCurrentVideo(tagName);
          }
        }
      });
    }
  }

  // Core functionality methods
  handleSearch(query) {
    this.applyFiltersAndSort();
  }

  applyFiltersAndSort() {
    const searchQuery = DOMUtils.getElementById("searchInput")?.value.trim() || "";
    const videos = this.videoManager.getVideos();
    
    this.filteredVideos = this.filterManager.applyFiltersAndSort(
      videos, 
      searchQuery, 
      this.currentSort
    );
    
    this.renderVideoList();
    this.uiRenderer.updateVideoCount(this.filteredVideos.length);
  }

  // Lightweight filter application without full sort and render
  applyFilters() {
    const searchQuery = DOMUtils.getElementById("searchInput")?.value.trim() || "";
    const videos = this.videoManager.getVideos();
    
    this.filteredVideos = this.filterManager.applyFiltersAndSort(
      videos, 
      searchQuery, 
      this.currentSort
    );
    
    // Only update video list count and content, no event delegation setup
    this.uiRenderer.renderVideoList(this.filteredVideos);
    this.uiRenderer.updateVideoCount(this.filteredVideos.length);
  }

  setView(view) {
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

  renderVideoList() {
    const count = this.uiRenderer.renderVideoList(this.filteredVideos);
    
    // Initialize selected video index if not set and there are videos
    if (this.uiRenderer.getSelectedVideoIndex() === -1 && this.filteredVideos.length > 0) {
      this.uiRenderer.setSelectedVideoIndex(0);
      this.uiRenderer.highlightSelectedVideo();
    }
    
    // Don't setup event delegation repeatedly - it's already set up in initializeEventListeners
    return count;
  }

  renderSidebar() {
    const tags = this.videoManager.getTags();
    const directories = this.videoManager.getDirectories();
    const currentFilter = this.filterManager.getCurrentFilter();
    const selectedDirectories = this.filterManager.getSelectedDirectories();
    
    this.uiRenderer.renderSidebar(tags, directories, currentFilter, selectedDirectories);
  }

  // Filter methods
  setRatingFilter(rating) {
    console.log("setRatingFilter called with:", rating);
    this.filterManager.setRatingFilter(rating);
    
    // Update visual state
    const allBtn = document.querySelector('.rating-btn.all-btn[data-rating="0"]');
    if (allBtn) {
      if (rating === 0) {
        allBtn.classList.add('active');
      } else {
        allBtn.classList.remove('active');
      }
    }
    
    // Update star display
    this.uiRenderer.updateStarDisplay(rating, false);
    
    this.applyFiltersAndSort();
  }

  filterByTag(tagName) {
    // console.log("filterByTag called with:", tagName);
    this.filterManager.toggleTagFilter(tagName);
    
    // Apply filters to update video list
    this.applyFilters();
    this.updateSidebarStates();
  }

  clearAllTags() {
    // console.log("clearAllTags called");
    this.filterManager.clearAllTagFilters();
    
    // Apply filters to update video list
    this.applyFilters();
    this.updateSidebarStates();
  }

  toggleDirectorySelection(directoryPath) {
    // console.log("toggleDirectorySelection called with:", directoryPath);
    this.filterManager.toggleDirectorySelection(directoryPath);
    
    // Apply filters to update video list
    this.applyFilters();
    this.updateSidebarStates();
  }

  // Update sidebar active states without full re-render
  updateSidebarStates() {
    const currentFilter = this.filterManager.getCurrentFilter();
    const selectedDirectories = this.filterManager.getSelectedDirectories();

    // Update tag active states
    document.querySelectorAll('.tag-item').forEach(tagElement => {
      const tagName = tagElement.dataset.tagName;
      if (currentFilter.tags.includes(tagName)) {
        tagElement.classList.add('active');
      } else {
        tagElement.classList.remove('active');
      }
    });

    // Update directory active states
    document.querySelectorAll('.directory-item').forEach(directoryElement => {
      const directoryPath = directoryElement.dataset.directoryPath;
      if (selectedDirectories.includes(directoryPath)) {
        directoryElement.classList.add('active');
      } else {
        directoryElement.classList.remove('active');
      }
    });
  }

  selectAllDirectories() {
    const directories = this.videoManager.getDirectories();
    this.filterManager.selectAllDirectories(directories);
    this.applyFiltersAndSort();
    this.updateSidebarStates();
  }

  deselectAllDirectories() {
    this.filterManager.deselectAllDirectories();
    this.applyFiltersAndSort();
    this.updateSidebarStates();
  }

  // Directory management
  async addDirectory() {
    try {
      const addedDirectories = await this.videoManager.addDirectory();
      addedDirectories.forEach(directory => {
        this.notificationManager.show(`フォルダを追加しました: ${directory}`, "success");
      });
      
      // Update filter manager with new directories
      this.filterManager.initializeDirectories(this.videoManager.getDirectories());
      this.renderSidebar();
    } catch (error) {
      console.error("Error adding directory:", error);
      this.showErrorDialog("フォルダの追加に失敗しました", error);
    }
  }

  async removeDirectory(path) {
    try {
      await this.videoManager.removeDirectory(path);
      
      // Update filter manager with updated directories
      this.filterManager.initializeDirectories(this.videoManager.getDirectories());
      this.renderSidebar();
      this.notificationManager.show("フォルダを削除しました", "success");
    } catch (error) {
      console.error("Error removing directory:", error);
      this.showErrorDialog("フォルダの削除に失敗しました", error);
    }
  }

  // Scanning and thumbnail operations
  async scanDirectories() {
    try {
      this.progressManager.showProgress("ディレクトリをスキャン中...", 0);
      await this.videoManager.scanDirectories();
    } catch (error) {
      console.error("Error scanning directories:", error);
      this.showErrorDialog("スキャンに失敗しました", error);
      this.progressManager.hideProgress();
    }
  }

  async regenerateThumbnails() {
    if (confirm("全てのサムネイルを再生成しますか？時間がかかる場合があります。")) {
      try {
        await this.videoManager.regenerateAllThumbnails();
      } catch (error) {
        console.error("Error regenerating thumbnails:", error);
        this.showErrorDialog("サムネイル再生成に失敗しました", error);
      }
    }
  }

  async updateThumbnailSettings() {
    const quality = parseInt(DOMUtils.getElementById("thumbnailQuality")?.value || "1");
    const size = DOMUtils.getElementById("thumbnailSize")?.value || "1280x720";
    const [width, height] = size.split("x").map(Number);

    const settings = { quality, width, height };

    try {
      await this.videoManager.updateThumbnailSettings(settings);
      this.notificationManager.show("サムネイル設定を更新しました", "success");
    } catch (error) {
      console.error("Error updating thumbnail settings:", error);
      this.showErrorDialog("サムネイル設定の更新に失敗しました", error);
    }
  }

  async cleanupThumbnails() {
    if (confirm("不要なサムネイルファイルを削除しますか？")) {
      // This would need to be implemented in the main process
      this.notificationManager.show("サムネイルのクリーンアップが完了しました", "success");
    }
  }

  // Progress handlers
  handleScanProgress(data) {
    const result = this.progressManager.handleScanProgress(data);
    switch (data.type) {
      case "scan-complete":
        this.notificationManager.show(`スキャン完了: ${data.count}個の動画を発見`, "success");
        this.loadVideosAndRefresh();
        break;
      case "scan-error":
        this.notificationManager.show(`スキャンエラー: ${data.error}`, "error");
        break;
    }
    return result;
  }

  handleThumbnailProgress(data) {
    const result = this.progressManager.handleThumbnailProgress(data);
    switch (data.type) {
      case "thumbnail-complete":
        this.notificationManager.show(`サムネイル生成完了: ${data.completed}個`, "success");
        this.loadVideosAndRefresh();
        break;
    }
    return result;
  }

  async handleVideoAdded(filePath) {
    await this.videoManager.handleVideoAdded(filePath);
    this.notificationManager.show(`新しい動画が追加されました: ${filePath}`, "info");
    this.applyFiltersAndSort();
  }

  async handleVideoRemoved(filePath) {
    await this.videoManager.handleVideoRemoved(filePath);
    this.notificationManager.show(`動画が削除されました: ${filePath}`, "info");
    this.applyFiltersAndSort();
  }

  async loadVideosAndRefresh() {
    await this.videoManager.loadVideos();
    this.applyFiltersAndSort();
  }

  // Settings and dialogs
  showSettings() {
    console.log("showSettings called");
    const directories = this.videoManager.getDirectories();
    this.uiRenderer.renderSettingsDirectories(directories);
    
    // サムネイル設定を読み込み（フォールバック付き）
    if (typeof this.uiRenderer.loadThumbnailSettings === 'function') {
      this.uiRenderer.loadThumbnailSettings();
    } else {
      console.warn("loadThumbnailSettings method not found, using fallback");
      // フォールバック: 直接ローカルストレージから設定を読み込み
      try {
        const thumbnailQuality = localStorage.getItem('thumbnailQuality') || '3';
        const qualitySelect = document.getElementById('thumbnailQuality');
        if (qualitySelect) {
          qualitySelect.value = thumbnailQuality;
        }

        const thumbnailSize = localStorage.getItem('thumbnailSize') || '1280x720';
        const sizeSelect = document.getElementById('thumbnailSize');
        if (sizeSelect) {
          sizeSelect.value = thumbnailSize;
        }
        console.log('Fallback: Thumbnail settings loaded directly');
      } catch (error) {
        console.error('Error loading thumbnail settings:', error);
      }
    }
    
    // フィルター設定の状態を復元
    const saveFilterStateCheckbox = DOMUtils.getElementById("saveFilterState");
    if (saveFilterStateCheckbox) {
      saveFilterStateCheckbox.checked = this.filterManager.isSaveFilterStateEnabled();
      console.log("showSettings - checkbox updated to:", this.filterManager.isSaveFilterStateEnabled());
    } else {
      console.log("showSettings - checkbox element not found");
    }
    
    // テーマ設定の状態を復元
    const themeSelect = DOMUtils.getElementById("themeSelect");
    if (themeSelect) {
      themeSelect.value = this.themeManager.getCurrentTheme() || 'system';
      console.log("showSettings - theme select updated to:", themeSelect.value);
    }
    
    const modal = DOMUtils.getElementById("settingsModal");
    console.log("Settings modal element found:", !!modal);
    if (modal) {
      modal.style.display = "flex";
      console.log("Settings modal should now be visible");
    } else {
      console.error("Settings modal element not found");
    }
  }

  hideSettings() {
    const modal = DOMUtils.getElementById("settingsModal");
    if (modal) {
      modal.style.display = "none";
    }
  }

  toggleTheme() {
    this.themeManager.toggleTheme();
    
    // Update theme toggle button icon
    const themeBtn = DOMUtils.getElementById("themeToggleBtn");
    if (themeBtn) {
      const icon = themeBtn.querySelector(".icon");
      if (icon) {
        const currentTheme = this.themeManager.getCurrentTheme();
        icon.textContent = currentTheme === "dark" ? "☀️" : "🌙";
      }
    }
  }

  async rescanAll() {
    if (confirm("全ての動画を再スキャンしますか？時間がかかる場合があります。")) {
      await this.scanDirectories();
    }
  }

  loadSettings() {
    try {
      const settingsStr = localStorage.getItem('movieLibrarySettings');
      if (settingsStr) {
        const settings = JSON.parse(settingsStr);
        this.filterManager.setSaveFilterStateEnabled(settings.saveFilterState !== false);
        
        // テーマ設定の復元
        if (settings.theme) {
          this.themeManager.applyTheme(settings.theme);
        }
      }
    } catch (error) {
      console.error("Error loading settings:", error);
    }
  }

  saveSettings() {
    try {
      // フィルター設定の保存
      const saveFilterCheckbox = DOMUtils.getElementById("saveFilterState");
      if (saveFilterCheckbox) {
        const enabled = saveFilterCheckbox.checked;
        this.filterManager.setSaveFilterStateEnabled(enabled);
      }
      
      // テーマ設定の保存
      const themeSelect = DOMUtils.getElementById("themeSelect");
      if (themeSelect) {
        this.themeManager.applyTheme(themeSelect.value);
      }
      
      // サムネイル設定は自動保存されているが、確認のため一度実行
      this.updateThumbnailSettings();
      
      // すべての設定をlocalStorageに保存
      const settings = {
        saveFilterState: saveFilterCheckbox?.checked !== false,
        theme: themeSelect?.value || 'system'
      };
      
      localStorage.setItem('movieLibrarySettings', JSON.stringify(settings));
      
      this.notificationManager.show("設定を保存しました", "success");
      this.hideSettings();
    } catch (error) {
      console.error("Error saving settings:", error);
      this.showErrorDialog("設定の保存に失敗しました", error);
    }
  }

  // Error dialog methods (continued from existing code)
  showErrorDialog(message, error = null) {
    const errorDialog = DOMUtils.getElementById("errorDialog");
    const errorMessage = DOMUtils.getElementById("errorMessage");
    const errorDetails = DOMUtils.getElementById("errorDetails");
    const showDetailsBtn = DOMUtils.getElementById("showErrorDetailsBtn");

    if (!errorDialog || !errorMessage) {
      console.error("Error dialog elements not found");
      return;
    }

    errorMessage.textContent = message;

    if (error && errorDetails && showDetailsBtn) {
      const detailsText = error.stack || error.message || error.toString();
      errorDetails.textContent = detailsText;
      showDetailsBtn.style.display = "inline-flex";
      errorDetails.style.display = "none";
    } else if (showDetailsBtn) {
      showDetailsBtn.style.display = "none";
    }

    errorDialog.style.display = "flex";
  }

  hideErrorDialog() {
    const errorDialog = DOMUtils.getElementById("errorDialog");
    if (errorDialog) {
      errorDialog.style.display = "none";
    }
  }

  toggleErrorDetails() {
    const errorDetails = DOMUtils.getElementById("errorDetails");
    const showDetailsBtn = DOMUtils.getElementById("showErrorDetailsBtn");

    if (!errorDetails || !showDetailsBtn) return;

    if (errorDetails.style.display === "none") {
      errorDetails.style.display = "block";
      showDetailsBtn.textContent = "詳細を隠す";
    } else {
      errorDetails.style.display = "none";
      showDetailsBtn.textContent = "詳細を表示";
    }
  }

  // Keyboard navigation handlers
  handleEscapeKey(e) {
    // Close any open modals or dialogs
    const openModal = document.querySelector('[style*="display: flex"]');
    if (openModal) {
      if (openModal.id === "settingsModal") this.hideSettings();
      else if (openModal.id === "errorDialog") this.hideErrorDialog();
      else if (openModal.id === "tagEditDialog") this.hideTagEditDialog();
      else if (openModal.id === "thumbnailModal") this.hideThumbnailModal();
      else if (openModal.id === "detailsPanel") this.hideDetails();
    }
  }

  handleArrowKeys(e) {
    // Navigate through video grid
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    const totalVideos = this.filteredVideos.length;
    
    if (totalVideos === 0) return;

    let newIndex = selectedIndex;
    const currentView = this.uiRenderer.getCurrentView();
    
    if (currentView === 'grid') {
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
            newIndex = Math.min(bottomRowStartIndex + currentCol, totalVideos - 1);
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
          this.showDetails(selectedVideo);
        }
      }
      
      e.preventDefault();
    }
  }

  // Calculate videos per row for grid view
  calculateVideosPerRow() {
    const videoList = document.getElementById("videoList");
    if (!videoList) return 4; // Default fallback
    
    const videoItems = videoList.querySelectorAll('.video-item');
    if (videoItems.length === 0) return 4;
    
    const containerWidth = videoList.clientWidth;
    const itemWidth = videoItems[0].offsetWidth + 20; // Include margin
    
    return Math.floor(containerWidth / itemWidth) || 1;
  }

  // Scroll to selected video if it's out of view
  scrollToSelectedVideo() {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    const videoItems = document.querySelectorAll('.video-item');
    
    if (selectedIndex >= 0 && videoItems[selectedIndex]) {
      const selectedItem = videoItems[selectedIndex];
      const container = document.getElementById("videoList");
      
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const itemRect = selectedItem.getBoundingClientRect();
        
        if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
          selectedItem.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          });
        }
      }
    }
  }

  handleEnterKey(e) {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    if (selectedIndex >= 0 && this.filteredVideos[selectedIndex]) {
      this.showDetails(this.filteredVideos[selectedIndex]);
    }
  }

  handleSpaceKey(e) {
    const selectedIndex = this.uiRenderer.getSelectedVideoIndex();
    if (selectedIndex >= 0 && this.filteredVideos[selectedIndex]) {
      this.playVideo(this.filteredVideos[selectedIndex]);
    }
  }

  // Tag management
  editTag(tagName) {
    this.showTagEditDialog(tagName);
  }

  async deleteTag(tagName) {
    try {
      const videosWithTag = this.videoManager.getVideos().filter(
        (video) => video.tags && video.tags.includes(tagName)
      );

      let confirmMessage = `タグ「${tagName}」を削除しますか？`;
      if (videosWithTag.length > 0) {
        confirmMessage += `\n\n注意: このタグは${
          videosWithTag.length
        }個の動画に設定されています。\n削除すると、これらの動画からもタグが削除されます。\n\n対象動画:\n${videosWithTag
          .slice(0, 5)
          .map((v) => `• ${v.title}`)
          .join("\n")}${
          videosWithTag.length > 5 ? `\n...他${videosWithTag.length - 5}個` : ""
        }`;
      }

      if (confirm(confirmMessage)) {
        await this.videoManager.deleteTag(tagName);

        // Remove tag from current filter if it's active
        const currentFilter = this.filterManager.getCurrentFilter();
        if (currentFilter.tags.includes(tagName)) {
          this.filterManager.toggleTagFilter(tagName); // This will remove it
        }

        // Update current video if it had this tag
        if (this.currentVideo && this.currentVideo.tags) {
          this.currentVideo.tags = this.currentVideo.tags.filter(
            (tag) => tag !== tagName
          );
          this.updateTagsDisplay(this.currentVideo.tags);
        }

        // Update UI immediately
        this.renderSidebar();
        this.renderVideoList();
        this.applyFiltersAndSort();

        this.notificationManager.show(`タグ「${tagName}」を削除しました`, "success");
      }
    } catch (error) {
      console.error("Error deleting tag:", error);
      this.showErrorDialog("タグの削除に失敗しました", error);
    }
  }

  // Tag edit dialog methods
  showTagEditDialog(tagName) {
    this.currentEditingTag = tagName;
    const tagNameInput = DOMUtils.getElementById("tagNameInput");
    const tagEditDialog = DOMUtils.getElementById("tagEditDialog");
    
    if (tagNameInput && tagEditDialog) {
      tagNameInput.value = tagName;
      tagEditDialog.style.display = "flex";

      // Focus the input and select all text
      setTimeout(() => {
        tagNameInput.focus();
        tagNameInput.select();
      }, 100);
    }
  }

  hideTagEditDialog() {
    const tagEditDialog = DOMUtils.getElementById("tagEditDialog");
    if (tagEditDialog) {
      tagEditDialog.style.display = "none";
    }
    this.currentEditingTag = null;
  }

  async saveTagEdit() {
    const tagNameInput = DOMUtils.getElementById("tagNameInput");
    if (!tagNameInput) return;

    const newTagName = tagNameInput.value.trim();

    if (!newTagName || newTagName === this.currentEditingTag) {
      this.hideTagEditDialog();
      return;
    }

    // Check if tag already exists
    const existingTag = this.videoManager.getTagByName(newTagName);
    if (existingTag) {
      this.showErrorDialog(
        "そのタグ名は既に存在します。別の名前を選択してください。"
      );
      return;
    }

    try {
      await this.videoManager.updateTag(this.currentEditingTag, newTagName);

      // Update filter if the edited tag was active
      const currentFilter = this.filterManager.getCurrentFilter();
      if (currentFilter.tags.includes(this.currentEditingTag)) {
        // Remove old tag and add new tag to filter
        this.filterManager.toggleTagFilter(this.currentEditingTag); // Remove
        this.filterManager.toggleTagFilter(newTagName); // Add
      }

      // Update current video if it had this tag
      if (this.currentVideo && this.currentVideo.tags) {
        const tagIndex = this.currentVideo.tags.indexOf(this.currentEditingTag);
        if (tagIndex !== -1) {
          this.currentVideo.tags[tagIndex] = newTagName;
          this.updateTagsDisplay(this.currentVideo.tags);
        }
      }

      // Update UI immediately
      this.renderSidebar();
      this.renderVideoList();
      this.applyFiltersAndSort();

      this.hideTagEditDialog();
      this.notificationManager.show(
        `タグ「${this.currentEditingTag}」を「${newTagName}」に変更しました`,
        "success"
      );
    } catch (error) {
      console.error("Error updating tag:", error);
      this.showErrorDialog("タグの編集に失敗しました", error);
    }
  }

  // Video details and playback
  async playVideo(video) {
    try {
      await this.videoManager.playVideo(video.path);
    } catch (error) {
      console.error("Error playing video:", error);
      this.showErrorDialog("動画の再生に失敗しました", error);
    }
  }

  async playCurrentVideo() {
    if (this.currentVideo) {
      await this.playVideo(this.currentVideo);
    }
  }

  // Video details panel methods
  showDetails(video) {
    console.log("showDetails: Starting for video:", video?.id, video?.title || video?.filename);
    
    // VideoManagerから最新のビデオデータを取得
    const latestVideo = this.videoManager.getVideoById(video.id);
    if (latestVideo) {
      this.currentVideo = latestVideo;
      console.log("showDetails: Using latest video data from VideoManager");
    } else {
      this.currentVideo = video;
      console.log("showDetails: Using provided video data");
    }
    
    this.uiRenderer.renderVideoDetails(this.currentVideo);
    
    // タグオートコンプリート候補を更新
    const allTags = this.videoManager.getTags();
    console.log("showDetails: Updating tag suggestions with", allTags.length, "tags");
    this.uiRenderer.updateTagSuggestions(allTags);
    
    // ビデオ詳細パネルを表示
    const detailsPanel = DOMUtils.getElementById("detailsPanel");
    if (detailsPanel) {
      detailsPanel.style.display = "block";
      console.log("showDetails: Details panel displayed");
    } else {
      console.error("showDetails: Details panel not found");
    }
    
    // 詳細パネルのイベントリスナーを設定
    console.log("showDetails: Setting up video details listeners");
    this.setupVideoDetailsListeners();
    
    // 評価星の表示を初期化
    this.updateRatingDisplay(this.currentVideo.rating || 0, false);
    
    // プレースホルダー色を確実に適用
    this.themeManager.updatePlaceholderColors();
    
    console.log("showDetails: Complete");
  }

  hideDetails() {
    this.currentVideo = null;
    const detailsPanel = DOMUtils.getElementById("detailsPanel");
    if (detailsPanel) {
      detailsPanel.style.display = "none";
    }
  }

  setupVideoDetailsListeners() {
    if (!this.currentVideo) return;

    console.log("Setting up video details listeners for video:", this.currentVideo.id);

    // レーティング星の設定
    const stars = document.querySelectorAll('#detailsPanel .rating-input .star');
    console.log("Found rating stars:", stars.length);
    
    stars.forEach((star, index) => {
      // 既存のイベントリスナーを削除（cloneNodeを使わない方法）
      star.replaceWith(star.cloneNode(true));
    });
    
    // 再取得（cloneNodeで置き換わった要素を取得）
    const newStars = document.querySelectorAll('#detailsPanel .rating-input .star');
    
    newStars.forEach((star, index) => {
      const rating = index + 1;
      console.log("Setting up star", rating);
      
      star.addEventListener('click', async () => {
        console.log("Star clicked:", rating, "Current rating:", this.currentVideo.rating);
        // 同じ評価をクリックした場合は評価を解除（0にする）
        if (this.currentVideo.rating === rating) {
          console.log("Removing rating");
          await this.setRating(0);
        } else {
          console.log("Setting rating to:", rating);
          await this.setRating(rating);
        }
      });
      
      star.addEventListener('mouseenter', () => {
        console.log("Star hovered:", rating);
        this.updateRatingDisplay(rating, true);
      });
      
      star.addEventListener('mouseleave', () => {
        console.log("Star unhovered, restoring rating:", this.currentVideo.rating || 0);
        this.updateRatingDisplay(this.currentVideo.rating || 0, false);
      });
    });

    // 評価解除エリアを追加（星の前に配置）
    const ratingContainer = document.querySelector('#detailsPanel .rating-input');
    if (ratingContainer) {
      // 既存の解除エリアがあれば削除
      const existingClearArea = ratingContainer.querySelector('.rating-clear-area');
      if (existingClearArea) {
        existingClearArea.remove();
      }
      
      // 評価解除エリアを作成
      const clearArea = document.createElement('span');
      clearArea.className = 'rating-clear-area';
      clearArea.textContent = '✕';
      clearArea.title = '評価を解除';
      clearArea.style.cssText = `
        font-size: 16px;
        cursor: pointer;
        opacity: 0.5;
        margin-right: 8px;
        padding: 2px 4px;
        border-radius: 4px;
        transition: all 0.2s ease;
        user-select: none;
      `;
      
      // 評価解除エリアのイベント
      clearArea.addEventListener('click', async () => {
        console.log("Clear area clicked");
        await this.setRating(0);
      });
      
      clearArea.addEventListener('mouseenter', () => {
        clearArea.style.opacity = '1';
        clearArea.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
        clearArea.style.color = '#ff4444';
      });
      
      clearArea.addEventListener('mouseleave', () => {
        clearArea.style.opacity = '0.5';
        clearArea.style.backgroundColor = 'transparent';
        clearArea.style.color = 'inherit';
      });
      
      // 最初の星の前に挿入
      const firstStar = ratingContainer.querySelector('.star');
      if (firstStar) {
        ratingContainer.insertBefore(clearArea, firstStar);
      }
    }

    // タグ追加
    const tagInput = document.getElementById("tagInput");

    if (tagInput) {
      console.log("setupVideoDetailsListeners: Setting up tag input for video:", this.currentVideo.id);
      
      // 既存のイベントリスナーを削除してからクリーンアップ
      const newTagInput = tagInput.cloneNode(true);
      tagInput.parentNode.replaceChild(newTagInput, tagInput);
      
      // IME変換状態を追跡する変数
      let isComposing = false;
      let lastInputValue = '';
      
      // IME変換開始
      newTagInput.addEventListener('compositionstart', (e) => {
        console.log("setupVideoDetailsListeners: compositionstart event");
        isComposing = true;
      });
      
      // IME変換終了
      newTagInput.addEventListener('compositionend', (e) => {
        console.log("setupVideoDetailsListeners: compositionend event, value:", e.target.value);
        isComposing = false;
        lastInputValue = e.target.value;
        
        // 変換確定のEnterの場合、少し待ってからkeydownイベントを無視するフラグをリセット
        setTimeout(() => {
          console.log("setupVideoDetailsListeners: composition settled");
        }, 10);
      });
      
      // 入力値の変化を追跡
      newTagInput.addEventListener('input', (e) => {
        console.log("setupVideoDetailsListeners: input event triggered, value:", e.target.value, "isComposing:", isComposing);
        if (!isComposing) {
          lastInputValue = e.target.value;
        }
      });
      
      // キーダウンイベント（メインのEnter処理）
      newTagInput.addEventListener('keydown', (e) => {
        console.log("setupVideoDetailsListeners: keydown event triggered, key:", e.key, "isComposing:", isComposing);
        
        if (e.key === "Enter") {
          // IME変換中のEnterは無視
          if (isComposing) {
            console.log("setupVideoDetailsListeners: Ignoring Enter during IME composition");
            return;
          }
          
          // datalist候補選択時のEnterを検出
          // 候補選択の場合、inputイベントが発火された直後にkeydownが来る
          const currentValue = newTagInput.value.trim();
          
          // 値が変わったばかり（候補選択など）の場合は一度無視
          if (currentValue !== lastInputValue.trim()) {
            console.log("setupVideoDetailsListeners: Value changed from candidate selection, ignoring Enter");
            lastInputValue = currentValue;
            return;
          }
          
          e.preventDefault();
          e.stopPropagation();
          
          console.log("setupVideoDetailsListeners: Processing Enter for tag addition, value:", currentValue);
          if (currentValue) {
            console.log("setupVideoDetailsListeners: Calling addTagToCurrentVideo");
            this.addTagToCurrentVideo(currentValue);
            newTagInput.value = "";
            lastInputValue = "";
          }
        }
      });
      
      // フォーカス時の初期化
      newTagInput.addEventListener('focus', (e) => {
        console.log("setupVideoDetailsListeners: focus event triggered");
        lastInputValue = e.target.value;
        isComposing = false;
      });
      
      console.log("setupVideoDetailsListeners: Tag input event listeners attached successfully");
    } else {
      console.warn("setupVideoDetailsListeners: tagInput element not found");
    }
  }

  async setRating(rating) {
    console.log("setRating called with:", rating);
    if (this.currentVideo) {
      console.log("Setting rating for video:", this.currentVideo.id, "from", this.currentVideo.rating, "to", rating);
      this.currentVideo.rating = rating;
      this.updateRatingDisplay(rating, false);
      
      // データベースに評価を保存
      try {
        await this.videoManager.updateVideo(this.currentVideo.id, { rating: rating });
        console.log("Rating saved to database successfully");
      } catch (error) {
        console.error("Failed to save rating to database:", error);
      }
    } else {
      console.log("No current video available");
    }
  }

  updateRatingDisplay(rating, isHover = false) {
    console.log("updateRatingDisplay called with rating:", rating, "isHover:", isHover);
    const stars = document.querySelectorAll('#detailsPanel .rating-input .star');
    const clearArea = document.querySelector('#detailsPanel .rating-clear-area');
    
    console.log("Found stars for update:", stars.length);
    
    stars.forEach((star, index) => {
      const starRating = index + 1;
      // Remove existing classes
      star.classList.remove('active', 'hover');
      
      if (starRating <= rating) {
        star.textContent = '⭐';
        if (isHover) {
          star.classList.add('hover');
        } else {
          star.classList.add('active');
        }
      } else {
        star.textContent = '☆';
      }
    });
    
    // 評価解除エリアの状態更新
    if (clearArea) {
      if (rating === 0 && !isHover) {
        clearArea.style.opacity = '1';
        clearArea.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
        clearArea.style.color = '#ff4444';
      } else if (rating > 0) {
        clearArea.style.opacity = '0.5';
        clearArea.style.backgroundColor = 'transparent';
        clearArea.style.color = 'inherit';
      }
    }
    
    console.log("Rating display updated");
  }

  updateTagsDisplay(tags) {
    if (!this.currentVideo) return;
    
    const tagsContainer = DOMUtils.getElementById("videoTagsList");
    if (tagsContainer) {
      tagsContainer.innerHTML = "";
      
      tags.forEach(tag => {
        const tagElement = document.createElement("span");
        tagElement.className = "tag-item";
        tagElement.innerHTML = `
          ${Utils.escapeHtml(tag)}
          <button class="remove-tag" data-tag="${Utils.escapeHtml(tag)}">×</button>
        `;
        tagsContainer.appendChild(tagElement);
      });
      
      // 削除ボタンのイベントリスナーを再設定
      this.setupVideoDetailsListeners();
    }
  }

  // 特定の動画のタグ表示を即座に更新する関数
  updateVideoTagsDisplay(videoId) {
    console.log("updateVideoTagsDisplay: Starting update for video:", videoId);
    
    // 現在表示されている動画アイテムを検索
    const videoItems = document.querySelectorAll('.video-item');
    
    videoItems.forEach((item, index) => {
      const video = this.filteredVideos[index];
      if (video && video.id === videoId) {
        console.log("updateVideoTagsDisplay: Found video item at index", index);
        
        // タグコンテナを取得
        const tagsContainer = item.querySelector('.video-tags');
        if (tagsContainer) {
          console.log("updateVideoTagsDisplay: Updating tags for video", video.title || video.filename);
          
          // タグコンテナをクリア
          tagsContainer.innerHTML = "";
          
          // タグを再描画
          if (video.tags && video.tags.length > 0) {
            const currentView = this.uiRenderer.getCurrentView();
            
            if (currentView === 'grid') {
              // Grid view: show up to 3 tags plus overflow indicator
              const maxVisibleTags = 3;
              const visibleTags = video.tags.slice(0, maxVisibleTags);
              const hiddenTags = video.tags.slice(maxVisibleTags);
              
              // Add visible tags
              visibleTags.forEach((tag) => {
                const tagSpan = document.createElement("span");
                tagSpan.className = "video-tag";
                tagSpan.textContent = tag;
                tagsContainer.appendChild(tagSpan);
              });
              
              // Add overflow indicator if there are hidden tags
              if (hiddenTags.length > 0) {
                const overflowSpan = document.createElement("span");
                overflowSpan.className = "video-tag tag-overflow";
                overflowSpan.textContent = `+${hiddenTags.length}`;
                overflowSpan.title = `他のタグ: ${hiddenTags.join(", ")}`;
                tagsContainer.appendChild(overflowSpan);
              }
            } else {
              // List view: show all tags
              video.tags.forEach((tag) => {
                const tagSpan = document.createElement("span");
                tagSpan.className = "video-tag";
                tagSpan.textContent = tag;
                tagsContainer.appendChild(tagSpan);
              });
            }
            
            console.log("updateVideoTagsDisplay: Tags updated to:", video.tags);
          } else {
            console.log("updateVideoTagsDisplay: No tags to display");
          }
        } else {
          console.warn("updateVideoTagsDisplay: Tags container not found for video item");
        }
        
        return; // 見つかったので終了
      }
    });
    
    console.log("updateVideoTagsDisplay: Complete for video:", videoId);
  }

  async addTagToCurrentVideo(tagName) {
    if (!tagName || !this.currentVideo) {
      console.log("addTagToCurrentVideo: invalid input", { tagName, currentVideo: !!this.currentVideo });
      return;
    }

    console.log("addTagToCurrentVideo: Starting tag addition", { tagName, videoId: this.currentVideo.id });

    // 先にローカルでの重複チェックを行う
    if (!this.currentVideo.tags) {
      this.currentVideo.tags = [];
      console.log("addTagToCurrentVideo: Initialized currentVideo.tags array");
    }
    
    if (this.currentVideo.tags.includes(tagName)) {
      console.log("addTagToCurrentVideo: Tag already exists locally, skipping:", tagName);
      return;
    }

    try {
      // データベースに追加（重複チェックはデータベース側でも実行される）
      console.log("addTagToCurrentVideo: Calling videoManager.addTagToVideo");
      await this.videoManager.addTagToVideo(this.currentVideo.id, tagName);
      console.log("addTagToCurrentVideo: Tag added to database successfully");
      
      // ローカルデータの更新：currentVideoとfilteredVideosの両方を更新
      this.currentVideo.tags.push(tagName);
      console.log("addTagToCurrentVideo: Tag added to currentVideo.tags", this.currentVideo.tags);
      
      // filteredVideosの該当ビデオも更新
      const filteredIndex = this.filteredVideos.findIndex(video => video.id === this.currentVideo.id);
      if (filteredIndex !== -1) {
        if (!this.filteredVideos[filteredIndex].tags) {
          this.filteredVideos[filteredIndex].tags = [];
        }
        if (!this.filteredVideos[filteredIndex].tags.includes(tagName)) {
          this.filteredVideos[filteredIndex].tags.push(tagName);
          console.log("addTagToCurrentVideo: Tag added to filteredVideos", this.filteredVideos[filteredIndex].tags);
        }
      }
      
      // VideoManagerのローカルデータも更新
      console.log("addTagToCurrentVideo: Updating VideoManager local data");
      this.videoManager.updateLocalVideoData(this.currentVideo);
      
      // UI更新
      this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags);
      this.updateVideoTagsDisplay(this.currentVideo.id);
      
      // オートコンプリート候補を更新
      const allTags = this.videoManager.getTags();
      this.uiRenderer.updateTagSuggestions(allTags);
      
      // サイドバーを更新
      this.renderSidebar();
      
      console.log("addTagToCurrentVideo: Tag added and UI updated successfully:", tagName);
    } catch (error) {
      console.error("addTagToCurrentVideo: Error adding tag:", error);
      
      // エラーが「すでに存在する」場合は、ローカルデータを同期
      if (error.message && error.message.includes('already exists')) {
        console.log("addTagToCurrentVideo: Tag already exists in database, syncing local data");
        if (!this.currentVideo.tags.includes(tagName)) {
          this.currentVideo.tags.push(tagName);
          this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags);
          this.updateVideoTagsDisplay(this.currentVideo.id);
        }
      } else {
        this.showErrorDialog("タグの追加に失敗しました", error);
      }
    }
  }

  async removeTagFromCurrentVideo(tagName) {
    if (!this.currentVideo) {
      console.log("removeTagFromCurrentVideo: No current video");
      return;
    }

    console.log("removeTagFromCurrentVideo: Starting tag removal", { tagName, videoId: this.currentVideo.id });

    try {
      // データベースから削除
      await this.videoManager.removeTagFromVideo(this.currentVideo.id, tagName);
      console.log("removeTagFromCurrentVideo: Tag removed from database successfully");
      
      // ローカルデータを更新
      if (this.currentVideo.tags) {
        this.currentVideo.tags = this.currentVideo.tags.filter(tag => tag !== tagName);
        console.log("removeTagFromCurrentVideo: Tag removed from currentVideo", this.currentVideo.tags);
        
        // filteredVideosも更新
        const filteredIndex = this.filteredVideos.findIndex(video => video.id === this.currentVideo.id);
        if (filteredIndex !== -1 && this.filteredVideos[filteredIndex].tags) {
          this.filteredVideos[filteredIndex].tags = this.filteredVideos[filteredIndex].tags.filter(tag => tag !== tagName);
          console.log("removeTagFromCurrentVideo: Tag removed from filteredVideos", this.filteredVideos[filteredIndex].tags);
        }
        
        // VideoManagerのローカルデータも更新
        this.videoManager.updateLocalVideoData(this.currentVideo);
        
        // UI更新
        this.uiRenderer.updateDetailsTagsDisplay(this.currentVideo.tags);
        this.updateVideoTagsDisplay(this.currentVideo.id);
        
        // オートコンプリート候補を更新
        const allTags = this.videoManager.getTags();
        this.uiRenderer.updateTagSuggestions(allTags);
        
        // サイドバーを更新
        this.renderSidebar();
        
        console.log("removeTagFromCurrentVideo: Tag removed and UI updated successfully:", tagName);
      }
    } catch (error) {
      console.error("removeTagFromCurrentVideo: Error removing tag:", error);
      this.showErrorDialog("タグの削除に失敗しました", error);
    }
  }

  async saveVideoDetails() {
    if (!this.currentVideo) return;

    try {
      const titleInput = DOMUtils.getElementById("detailsTitleInput");
      const descriptionInput = DOMUtils.getElementById("detailsDescriptionInput");
      
      const updatedData = {
        title: titleInput?.value || this.currentVideo.title,
        description: descriptionInput?.value || this.currentVideo.description,
        rating: this.currentVideo.rating || 0,
      };

      console.log("Saving video details:", updatedData); // デバッグ用

      await this.videoManager.updateVideo(this.currentVideo.id, updatedData);
      Object.assign(this.currentVideo, updatedData);

      this.renderVideoList(); // ビデオリストの評価表示を更新
      this.notificationManager.show("動画情報を保存しました", "success");
    } catch (error) {
      console.error("Error saving video details:", error);
      this.showErrorDialog("保存に失敗しました", error);
    }
  }

  // Thumbnail modal methods
  async showThumbnailModal(video, startIndex = 0) {
    this.currentThumbnails = [];
    this.currentThumbnailIndex = 0;
    
    try {
      console.log("showThumbnailModal - video object:", video);
      console.log("showThumbnailModal - chapter_thumbnails:", video.chapter_thumbnails);
      
      // Always include main thumbnail as the first item
      if (video && video.thumbnail_path) {
        this.currentThumbnails.push({
          path: video.thumbnail_path,
          timestamp: 0,
          isMain: true
        });
      }
      
      // Use chapter thumbnails if available
      if (video && video.chapter_thumbnails) {
        let chapters = [];
        
        if (Array.isArray(video.chapter_thumbnails)) {
          chapters = video.chapter_thumbnails;
        } else if (typeof video.chapter_thumbnails === 'string') {
          try {
            const parsed = JSON.parse(video.chapter_thumbnails);
            if (Array.isArray(parsed)) {
              chapters = parsed;
            } else if (typeof parsed === 'object' && parsed !== null) {
              chapters = Object.values(parsed).filter(item => 
                item && typeof item === 'object' && item.path && item.timestamp !== undefined
              );
            }
          } catch (error) {
            console.warn("Failed to parse chapter_thumbnails:", error);
          }
        } else if (typeof video.chapter_thumbnails === 'object' && video.chapter_thumbnails !== null) {
          chapters = Object.values(video.chapter_thumbnails).filter(item => 
            item && typeof item === 'object' && item.path && item.timestamp !== undefined
          );
        }
        
        const validChapters = chapters.filter(item => 
          item && typeof item === 'object' && item.path && item.timestamp !== undefined
        );
        
        // Add chapter thumbnails after main thumbnail
        this.currentThumbnails.push(...validChapters);
        
        console.log("showThumbnailModal - processed thumbnails:", this.currentThumbnails);
      }
      
      if (this.currentThumbnails.length === 0) {
        console.warn("No valid thumbnails found for video:", video?.title || video?.filename);
        this.notificationManager.show("サムネイルが見つかりません", "warning");
        return;
      }
      
      // Set the correct starting index
      if (startIndex === 0) {
        // Start with main thumbnail (index 0)
        this.currentThumbnailIndex = 0;
      } else {
        // startIndex refers to chapter index, so add 1 for main thumbnail
        this.currentThumbnailIndex = startIndex + 1;
        // Ensure the index is within bounds
        if (this.currentThumbnailIndex >= this.currentThumbnails.length) {
          this.currentThumbnailIndex = 0;
        }
      }
      
      // モーダルを表示
      const modal = DOMUtils.getElementById("thumbnailModal");
      if (modal) {
        modal.style.display = "flex";
        this.updateThumbnailModalContent();
        this.setupThumbnailModalKeyboardListeners();
      }
    } catch (error) {
      console.error("Error loading thumbnails:", error);
      this.showErrorDialog("サムネイルの読み込みに失敗しました", error);
    }
  }

  hideThumbnailModal() {
    const modal = DOMUtils.getElementById("thumbnailModal");
    if (modal) {
      modal.style.display = "none";
    }
    
    // Remove keyboard listener
    if (this.thumbnailModalKeyboardHandler) {
      document.removeEventListener('keydown', this.thumbnailModalKeyboardHandler);
      this.thumbnailModalKeyboardHandler = null;
    }
    
    this.currentThumbnails = [];
    this.currentThumbnailIndex = 0;
  }

  updateThumbnailModalContent() {
    if (this.currentThumbnails.length === 0) return;
    
    const thumbnail = this.currentThumbnails[this.currentThumbnailIndex];
    const img = DOMUtils.getElementById("modalThumbnailImage");
    const info = DOMUtils.getElementById("thumbnailInfo");
    
    if (img && thumbnail.path) {
      img.src = `file://${thumbnail.path}`;
    }
    
    if (info) {
      const timestamp = DOMUtils.getElementById("thumbnailTimestamp");
      const index = DOMUtils.getElementById("thumbnailIndex");
      
      if (timestamp) {
        if (thumbnail.isMain) {
          timestamp.textContent = "メインサムネイル";
        } else {
          timestamp.textContent = FormatUtils.formatDuration(thumbnail.timestamp || 0);
        }
      }
      
      if (index) {
        if (thumbnail.isMain) {
          index.textContent = `メインサムネイル (1 / ${this.currentThumbnails.length})`;
        } else {
          const chapterNumber = this.currentThumbnailIndex; // Since main is at index 0
          index.textContent = `チャプター ${chapterNumber} (${this.currentThumbnailIndex + 1} / ${this.currentThumbnails.length})`;
        }
      }
    }
  }

  setupThumbnailModalListeners() {
    const modal = DOMUtils.getElementById("thumbnailModal");
    const prevBtn = DOMUtils.getElementById("modalPrevBtn");
    const nextBtn = DOMUtils.getElementById("modalNextBtn");
    const closeBtn = DOMUtils.getElementById("modalCloseBtn");
    const setMainBtn = DOMUtils.getElementById("setMainThumbnailBtn");

    // モーダル外クリックで閉じる
    if (modal) {
      DOMUtils.removeAllEventListeners(modal);
      DOMUtils.addEventListeners(modal, {
        click: (e) => {
          if (e.target === modal) {
            this.hideThumbnailModal();
          }
        }
      });
    }

    // ナビゲーションボタン
    if (prevBtn) {
      DOMUtils.removeAllEventListeners(prevBtn);
      DOMUtils.addEventListeners(prevBtn, {
        click: () => this.showPreviousThumbnail()
      });
    }

    if (nextBtn) {
      DOMUtils.removeAllEventListeners(nextBtn);
      DOMUtils.addEventListeners(nextBtn, {
        click: () => this.showNextThumbnail()
      });
    }

    if (closeBtn) {
      DOMUtils.removeAllEventListeners(closeBtn);
      DOMUtils.addEventListeners(closeBtn, {
        click: () => this.hideThumbnailModal()
      });
    }

    if (setMainBtn) {
      DOMUtils.removeAllEventListeners(setMainBtn);
      DOMUtils.addEventListeners(setMainBtn, {
        click: () => this.setMainThumbnail()
      });
    }
  }

  showPreviousThumbnail() {
    if (this.currentThumbnails.length === 0) return;
    
    this.currentThumbnailIndex = 
      (this.currentThumbnailIndex - 1 + this.currentThumbnails.length) % this.currentThumbnails.length;
    this.updateThumbnailModalContent();
  }

  showNextThumbnail() {
    if (this.currentThumbnails.length === 0) return;
    
    this.currentThumbnailIndex = 
      (this.currentThumbnailIndex + 1) % this.currentThumbnails.length;
    this.updateThumbnailModalContent();
  }

  async setMainThumbnail() {
    if (!this.currentVideo || this.currentThumbnails.length === 0) return;
    
    try {
      const thumbnail = this.currentThumbnails[this.currentThumbnailIndex];
      await window.electronAPI.setMainThumbnail(this.currentVideo.filePath, thumbnail.timestamp);
      
      this.notificationManager.show("メインサムネイルを設定しました", "success");
      this.hideThumbnailModal();
      
      // ビデオリストを更新してサムネイルの変更を反映
      setTimeout(() => {
        this.renderVideoList();
      }, 500);
    } catch (error) {
      console.error("Error setting main thumbnail:", error);
      this.showErrorDialog("サムネイルの設定に失敗しました", error);
    }
  }

  async refreshMainThumbnail() {
    if (!this.currentVideo) return;
    
    try {
      const updatedVideo = await window.electronAPI.regenerateMainThumbnail(this.currentVideo.id);
      this.notificationManager.show("サムネイルを更新しました", "success");
      
      // 現在のビデオを更新し、ローカルデータも更新
      this.currentVideo = updatedVideo;
      const updatedLocalVideo = this.videoManager.updateLocalVideoData(updatedVideo);
      
      // filteredVideosも更新
      const filteredIndex = this.filteredVideos.findIndex(video => video.id === updatedVideo.id);
      if (filteredIndex !== -1) {
        this.filteredVideos[filteredIndex] = { ...this.filteredVideos[filteredIndex], ...updatedVideo };
        console.log("Updated filteredVideos entry:", this.filteredVideos[filteredIndex]);
        console.log("Updated thumbnail_path:", this.filteredVideos[filteredIndex].thumbnail_path);
      } else {
        console.warn("Video not found in filteredVideos:", updatedVideo.id);
      }
      
      // キャッシュをクリアしてサムネイルを強制的に更新
      const timestamp = Date.now();
      
      // 即座にサムネイルを強制更新
      this.forceUpdateThumbnails(updatedVideo, timestamp);
      
      // ビデオリストとサイドバーを再描画
      setTimeout(() => {
        this.renderVideoList();
        this.renderSidebar();
        
        // レンダリング後に再度サムネイル更新を確実に実行
        setTimeout(() => {
          this.forceUpdateThumbnails(updatedVideo, timestamp);
        }, 50);
        
        // 詳細パネルが開いている場合は更新
        const detailsPanel = document.getElementById("detailsPanel");
        if (detailsPanel && detailsPanel.style.display !== "none" && this.currentVideo) {
          // 詳細パネルを再描画
          this.showDetails(this.currentVideo);
        }
      }, 100);
    } catch (error) {
      console.error("Error refreshing thumbnail:", error);
      this.showErrorDialog("サムネイルの更新に失敗しました", error);
    }
  }

  // グリッド/リスト表示のサムネイルを強制更新
  forceUpdateThumbnails(updatedVideo, timestamp) {
    console.log("forceUpdateThumbnails called for video:", updatedVideo?.id, "timestamp:", timestamp);
    
    // 現在表示されている動画アイテムのサムネイルを更新
    const videoItems = document.querySelectorAll('.video-item');
    videoItems.forEach(item => {
      const videoIndex = parseInt(item.dataset.index);
      const video = this.filteredVideos[videoIndex];
      
      if (video && video.id === updatedVideo?.id) {
        // .video-thumbnail div内のimg要素を取得
        const thumbnailImg = item.querySelector('.video-thumbnail img');
        if (thumbnailImg) {
          const newSrc = `file://${updatedVideo.thumbnail_path}?t=${timestamp}`;
          console.log("Updating thumbnail img src from:", thumbnailImg.src, "to:", newSrc);
          thumbnailImg.src = newSrc;
          
          // 画像の読み込みを強制
          thumbnailImg.onload = () => {
            console.log("Thumbnail successfully updated for video:", video.id);
          };
          thumbnailImg.onerror = () => {
            console.error("Failed to load updated thumbnail for video:", video.id);
          };
        } else {
          console.warn("Thumbnail img element not found for video:", video.id);
        }
      }
    });
  }

  // Tooltip methods
  showTooltip(e, video) {
    this.hideTooltip(); // 既存のツールチップを隠す
    
    const tooltip = DOMUtils.getElementById("videoTooltip");
    if (!tooltip) return;
    
    // ツールチップの内容を設定
    const titleElement = tooltip.querySelector(".tooltip-title");
    const infoElement = tooltip.querySelector(".tooltip-info");
    const tagsElement = tooltip.querySelector(".tooltip-tags");
    
    if (titleElement) {
      titleElement.textContent = video.title || video.filename;
    }
    
    if (infoElement) {
      const info = [];
      if (video.duration) {
        info.push(`時間: ${FormatUtils.formatDuration(video.duration)}`);
      }
      if (video.fileSize) {
        info.push(`サイズ: ${FormatUtils.formatFileSize(video.fileSize)}`);
      }
      if (video.rating > 0) {
        info.push(`評価: ${"★".repeat(video.rating)}${"☆".repeat(5 - video.rating)}`);
      }
      infoElement.textContent = info.join(" | ");
    }
    
    if (tagsElement) {
      if (video.tags && video.tags.length > 0) {
        tagsElement.textContent = `タグ: ${video.tags.join(", ")}`;
        tagsElement.style.display = "block";
      } else {
        tagsElement.style.display = "none";
      }
    }
    
    // ツールチップの位置を調整
    this.positionTooltip(e, tooltip);
    
    // ツールチップを表示
    tooltip.style.display = "block";
    
    // 一定時間後に自動で隠す
    this.tooltipTimeout = setTimeout(() => {
      this.hideTooltip();
    }, 3000);
  }

  positionTooltip(e, tooltip) {
    const rect = e.target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    let top = rect.top - tooltipRect.height - 10;
    
    // 画面端の調整
    if (left < 10) left = 10;
    if (left + tooltipRect.width > viewportWidth - 10) {
      left = viewportWidth - tooltipRect.width - 10;
    }
    
    if (top < 10) {
      top = rect.bottom + 10;
    }
    
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  hideTooltip() {
    const tooltip = DOMUtils.getElementById("videoTooltip");
    if (tooltip) {
      tooltip.style.display = "none";
    }
    
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }
    
    if (this.tooltipInterval) {
      clearInterval(this.tooltipInterval);
      this.tooltipInterval = null;
    }
  }

  safeAddEventListener(elementId, event, handler) {
    const element = DOMUtils.getElementById(elementId);
    if (element) {
      element.addEventListener(event, handler);
    } else {
      console.warn(`Element not found for event listener: ${elementId}`);
    }
  }

  setupThumbnailModalKeyboardListeners() {
    // Remove any existing keyboard listener
    if (this.thumbnailModalKeyboardHandler) {
      document.removeEventListener('keydown', this.thumbnailModalKeyboardHandler);
    }
    
    // Create new keyboard handler
    this.thumbnailModalKeyboardHandler = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.showPreviousThumbnail();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.showNextThumbnail();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hideThumbnailModal();
      }
    };
    
    // Add keyboard listener
    document.addEventListener('keydown', this.thumbnailModalKeyboardHandler);
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.movieApp = new MovieLibraryApp();
});

export default MovieLibraryApp;
