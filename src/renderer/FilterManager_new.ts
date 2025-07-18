/**
 * フィルター機能を管理するクラス
 * 評価、タグ、ディレクトリフィルターとその永続化を担当
 */

export interface FilterState {
  rating: number;
  tags: string[];
  directories: string[];
}

export interface SortState {
  field: string;
  order: "ASC" | "DESC";
}

export interface Video {
  id: number;
  path: string;
  title: string;
  filename: string;
  description?: string;
  rating?: number;
  tags?: string[];
  [key: string]: any; // その他のプロパティ
}

export interface Directory {
  path: string;
  added_at: string;
}

export class FilterManager {
  private currentFilter: FilterState;
  private selectedDirectories: string[];
  private saveFilterStateEnabled: boolean;
  private filterChangeCallback: ((filter: FilterState) => void) | null = null;

  constructor() {
    this.currentFilter = { rating: 0, tags: [], directories: [] };
    this.selectedDirectories = []; // フォルダフィルター用の選択状態
    this.saveFilterStateEnabled = true; // フィルター状態保存を有効にする

    this.loadSettings();
  }

  // 設定を読み込み
  loadSettings(): void {
    const saveFilterState = localStorage.getItem("saveFilterState");
    console.log(
      "FilterManager.loadSettings - raw saveFilterState from localStorage:",
      saveFilterState
    );

    if (saveFilterState === null) {
      this.saveFilterStateEnabled = true;
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
  saveSettings(): void {
    localStorage.setItem(
      "saveFilterState",
      this.saveFilterStateEnabled.toString()
    );
  }

  // フィルター状態を保存
  saveFilterState(): void {
    if (!this.saveFilterStateEnabled) return;

    const filterState = {
      rating: this.currentFilter.rating,
      tags: this.currentFilter.tags,
      selectedDirectories: this.selectedDirectories,
    };
    localStorage.setItem("filterState", JSON.stringify(filterState));
    console.log("FilterManager.saveFilterState - saved:", filterState);
    this.notifyFilterChange();
  }

  // フィルター状態を読み込み
  loadFilterState(): void {
    if (!this.saveFilterStateEnabled) return;

    try {
      const saved = localStorage.getItem("filterState");
      if (saved) {
        const filterState = JSON.parse(saved);
        this.currentFilter.rating = filterState.rating || 0;
        this.currentFilter.tags = filterState.tags || [];
        this.selectedDirectories = filterState.selectedDirectories || [];

        console.log("FilterManager.loadFilterState - loaded:", filterState);
      }
    } catch (error) {
      console.error("FilterManager.loadFilterState - error:", error);
    }
  }

  // 評価フィルターを設定
  setRatingFilter(rating: number): void {
    this.currentFilter.rating = rating;
    this.saveFilterState();
  }

  // タグフィルターを追加
  addTagFilter(tag: string): void {
    if (!this.currentFilter.tags.includes(tag)) {
      this.currentFilter.tags.push(tag);
      this.saveFilterState();
    }
  }

  // タグフィルターを削除
  removeTagFilter(tag: string): void {
    this.currentFilter.tags = this.currentFilter.tags.filter((t) => t !== tag);
    this.saveFilterState();
  }

  // ディレクトリ選択を切り替え
  toggleDirectory(directoryPath: string): void {
    const index = this.selectedDirectories.indexOf(directoryPath);
    if (index > -1) {
      this.selectedDirectories.splice(index, 1);
    } else {
      this.selectedDirectories.push(directoryPath);
    }
    this.saveFilterState();
  }

  // 現在のフィルター状態を取得
  getCurrentFilter(): FilterState {
    return { ...this.currentFilter };
  }

  // 選択されたディレクトリを取得
  getSelectedDirectories(): string[] {
    return [...this.selectedDirectories];
  }

  // フィルターを適用
  applyFilters(
    videos: Video[],
    searchQuery: string = "",
    currentSort: SortState = { field: "title", order: "ASC" }
  ): Video[] {
    let filteredVideos = [...videos];

    // 評価フィルター
    if (this.currentFilter.rating > 0) {
      filteredVideos = filteredVideos.filter(
        (video) => (video.rating || 0) >= this.currentFilter.rating
      );
    }

    // タグフィルター
    if (this.currentFilter.tags.length > 0) {
      filteredVideos = filteredVideos.filter((video) =>
        this.currentFilter.tags.every(
          (tag) => video.tags && video.tags.includes(tag)
        )
      );
    }

    // ディレクトリフィルター
    if (this.selectedDirectories.length > 0) {
      filteredVideos = filteredVideos.filter((video) =>
        this.selectedDirectories.some((dir) => video.path.startsWith(dir))
      );
    }

    // 検索クエリ
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filteredVideos = filteredVideos.filter(
        (video) =>
          video.title.toLowerCase().includes(query) ||
          video.filename.toLowerCase().includes(query) ||
          (video.description && video.description.toLowerCase().includes(query))
      );
    }

    // ソート
    filteredVideos.sort((a, b) => {
      let aValue: any = a[currentSort.field];
      let bValue: any = b[currentSort.field];

      if (typeof aValue === "string") {
        aValue = aValue.toLowerCase();
      }
      if (typeof bValue === "string") {
        bValue = bValue.toLowerCase();
      }

      if (aValue < bValue) {
        return currentSort.order === "ASC" ? -1 : 1;
      }
      if (aValue > bValue) {
        return currentSort.order === "ASC" ? 1 : -1;
      }
      return 0;
    });

    return filteredVideos;
  }

  // フィルター状態を保存するかどうかを設定
  setSaveFilterStateEnabled(enabled: boolean): void {
    this.saveFilterStateEnabled = enabled;
    this.saveSettings();
  }

  // フィルター状態保存が有効かどうか
  isSaveFilterStateEnabled(): boolean {
    return this.saveFilterStateEnabled;
  }

  // ディレクトリを初期化
  initializeDirectories(directories: Directory[]): void {
    // 現在の選択状態を保持
    const currentSelection = [...this.selectedDirectories];

    // 存在しないディレクトリを削除
    this.selectedDirectories = this.selectedDirectories.filter((selected) =>
      directories.some((dir) => dir.path === selected)
    );

    // 初回または空の場合は全て選択
    if (currentSelection.length === 0 && directories.length > 0) {
      this.selectedDirectories = directories.map((dir) => dir.path);
    }

    this.saveFilterState();
  }

  // フィルター変更時のコールバックを設定
  onFilterChange(callback: (filter: FilterState) => void): void {
    this.filterChangeCallback = callback;
  }

  // フィルター状態が変更された時に呼び出す
  private notifyFilterChange(): void {
    if (this.filterChangeCallback) {
      this.filterChangeCallback(this.currentFilter);
    }
  }

  // フィルターデータを取得
  getFilterData(): { tags: string[], directories: string[], rating: number } {
    return {
      tags: [...this.currentFilter.tags],
      directories: [...this.selectedDirectories],
      rating: this.currentFilter.rating
    };
  }

  // 後方互換性のためのエイリアス
  applyFiltersAndSort(
    videos: Video[],
    searchQuery: string = "",
    currentSort: SortState = { field: "title", order: "ASC" }
  ): Video[] {
    return this.applyFilters(videos, searchQuery, currentSort);
  }

  // タグフィルターを切り替え（app.jsとの互換性のため）
  toggleTagFilter(tagName: string): void {
    const index = this.currentFilter.tags.indexOf(tagName);
    if (index > -1) {
      this.currentFilter.tags.splice(index, 1);
    } else {
      this.currentFilter.tags.push(tagName);
    }
    this.saveFilterState();
  }

  // すべてのタグフィルターをクリア（app.jsとの互換性のため）
  clearAllTagFilters(): void {
    this.currentFilter.tags = [];
    this.saveFilterState();
  }

  // ディレクトリ選択を切り替え（app.jsとの互換性のため）
  toggleDirectorySelection(directoryPath: string): void {
    this.toggleDirectory(directoryPath);
  }
}
