/**
 * フィルター機能を管理するクラス
 * 評価、タグ、ディレクトリフィルターとその永続化を担当
 */
export class FilterManager {
  constructor() {
    this.currentFilter = { rating: 0, tags: [], directories: [] };
    this.selectedDirectories = []; // フォルダフィルター用の選択状態
    this.saveFilterStateEnabled = true; // フィルター状態保存を有効にする

    this.loadSettings();
  }

  // 設定を読み込み
  loadSettings() {
    const saveFilterState = localStorage.getItem("saveFilterState");
    console.log(
      "FilterManager.loadSettings - raw saveFilterState from localStorage:",
      saveFilterState
    );

    // 初回起動時はデフォルトでtrueにする
    if (saveFilterState === null) {
      this.saveFilterStateEnabled = true;
      this.saveSettings(); // デフォルト値を保存
      console.log("FilterManager.loadSettings - first time, set to true");
    } else {
      this.saveFilterStateEnabled = saveFilterState === "true";
      console.log(
        "FilterManager.loadSettings - loaded from storage:",
        this.saveFilterStateEnabled
      );
    }
  }

  // 設定を保存
  saveSettings() {
    localStorage.setItem(
      "saveFilterState",
      this.saveFilterStateEnabled.toString()
    );
  }

  // フィルター状態を保存
  saveFilterState() {
    if (!this.saveFilterStateEnabled) return;

    const filterState = {
      rating: this.currentFilter.rating,
      tags: this.currentFilter.tags,
      directories: this.selectedDirectories,
    };
    localStorage.setItem("filterState", JSON.stringify(filterState));
    console.log("FilterManager - Filter state saved:", filterState);
  }

  // フィルター状態を読み込み
  loadFilterState() {
    console.log(
      "FilterManager.loadFilterState called, saveFilterStateEnabled:",
      this.saveFilterStateEnabled
    );
    if (!this.saveFilterStateEnabled) {
      console.log("FilterManager.loadFilterState - disabled, skipping");
      return;
    }

    const saved = localStorage.getItem("filterState");
    console.log(
      "FilterManager.loadFilterState - raw data from localStorage:",
      saved
    );
    if (saved) {
      try {
        const filterState = JSON.parse(saved);
        this.currentFilter.rating = filterState.rating || 0;
        this.currentFilter.tags = filterState.tags || [];
        this.selectedDirectories = filterState.directories || [];
        console.log("FilterManager - Filter state loaded:", filterState);
        console.log("FilterManager - Applied to:", {
          rating: this.currentFilter.rating,
          tags: this.currentFilter.tags,
          directories: this.selectedDirectories,
        });
      } catch (error) {
        console.error("FilterManager - Failed to load filter state:", error);
      }
    } else {
      console.log("FilterManager.loadFilterState - no saved data found");
    }
  }

  // 評価フィルターを設定
  setRatingFilter(rating) {
    console.log("FilterManager.setRatingFilter called with:", rating);
    this.currentFilter.rating = rating;
    this.saveFilterState();
  }

  // タグフィルターを切り替え
  toggleTagFilter(tagName) {
    if (this.currentFilter.tags.includes(tagName)) {
      this.currentFilter.tags = this.currentFilter.tags.filter(
        (tag) => tag !== tagName
      );
    } else {
      this.currentFilter.tags.push(tagName);
    }
    this.saveFilterState();
  }

  // 全タグフィルターをクリア
  clearAllTagFilters() {
    this.currentFilter.tags = [];
    this.saveFilterState();
  }

  // ディレクトリ選択を切り替え
  toggleDirectorySelection(directoryPath) {
    const index = this.selectedDirectories.indexOf(directoryPath);
    if (index === -1) {
      // 選択されていない場合は追加
      this.selectedDirectories.push(directoryPath);
    } else {
      // 選択されている場合は削除
      this.selectedDirectories.splice(index, 1);
    }
    this.saveDirectoryFilterState();
    this.saveFilterState();
  }

  // 全ディレクトリを選択
  selectAllDirectories(directories) {
    this.selectedDirectories = directories.map((dir) => dir.path);
    this.saveDirectoryFilterState();
    this.saveFilterState();
  }

  // 全ディレクトリの選択を解除
  deselectAllDirectories() {
    this.selectedDirectories = [];
    this.saveDirectoryFilterState();
    this.saveFilterState();
  }

  // ディレクトリフィルターの状態をlocalStorageに保存
  saveDirectoryFilterState() {
    localStorage.setItem(
      "selectedDirectories",
      JSON.stringify(this.selectedDirectories)
    );
  }

  // ディレクトリフィルターの状態をlocalStorageから読み込み
  loadDirectoryFilterState() {
    const saved = localStorage.getItem("selectedDirectories");
    if (saved) {
      this.selectedDirectories = JSON.parse(saved);
    }
  }

  // ディレクトリリストの初期化（loadDirectoriesから呼び出される）
  initializeDirectories(directories) {
    // フィルター状態がロードされていない場合のみデフォルト設定
    if (this.selectedDirectories.length === 0) {
      // デフォルトで全てのフォルダを選択状態にする
      this.selectedDirectories = directories.map((dir) => dir.path);
    }

    // 削除されたフォルダを選択状態から除外
    this.selectedDirectories = this.selectedDirectories.filter((dirPath) =>
      directories.some((dir) => dir.path === dirPath)
    );

    // 新しいフォルダが追加された場合、それもデフォルトで選択状態にする
    directories.forEach((dir) => {
      if (!this.selectedDirectories.includes(dir.path)) {
        this.selectedDirectories.push(dir.path);
      }
    });

    this.saveDirectoryFilterState();
  }

  // フィルターとソートを適用
  applyFiltersAndSort(
    videos,
    searchQuery = "",
    currentSort = { field: "filename", order: "ASC" }
  ) {
    let filtered = [...videos]; // Start from all videos

    // Apply rating filter
    if (this.currentFilter.rating > 0) {
      filtered = filtered.filter(
        (video) => video.rating >= this.currentFilter.rating
      );
    }

    // Search filter (apply after other filters)
    if (searchQuery !== "") {
      filtered = filtered.filter(
        (video) =>
          video.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          video.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (video.description &&
            video.description
              .toLowerCase()
              .includes(searchQuery.toLowerCase())) ||
          (video.tags &&
            video.tags.some((tag) =>
              tag.toLowerCase().includes(searchQuery.toLowerCase())
            ))
      );
    }

    // Apply tag filter (OR search - any matching tag)
    if (this.currentFilter.tags.length > 0) {
      filtered = filtered.filter(
        (video) =>
          video.tags &&
          this.currentFilter.tags.some((tag) => video.tags.includes(tag))
      );
    }

    // Apply directory filter
    if (this.selectedDirectories.length === 0) {
      // フォルダが一つも選択されていない場合は、すべての動画を非表示にする
      filtered = [];
    } else {
      // 選択されたフォルダの動画のみ表示
      filtered = filtered.filter((video) => {
        // ビデオのパスが選択されたディレクトリのいずれかに含まれているかチェック
        return this.selectedDirectories.some((dirPath) =>
          video.path.startsWith(dirPath)
        );
      });
    }

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue = a[currentSort.field];
      let bValue = b[currentSort.field];

      if (typeof aValue === "string") {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (currentSort.order === "ASC") {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    return filtered;
  }

  // フィルター状態保存の有効/無効を切り替え
  setSaveFilterStateEnabled(enabled) {
    this.saveFilterStateEnabled = enabled;
    this.saveSettings();
    if (!this.saveFilterStateEnabled) {
      // フィルター状態保存が無効になった場合、保存されたフィルター状態を削除
      localStorage.removeItem("filterState");
    }
  }

  // 現在のフィルター状態を取得
  getCurrentFilter() {
    return { ...this.currentFilter };
  }

  // 選択されたディレクトリを取得
  getSelectedDirectories() {
    return [...this.selectedDirectories];
  }

  // フィルター状態保存が有効かどうか
  isSaveFilterStateEnabled() {
    return this.saveFilterStateEnabled;
  }
}
