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
    this.loadFilterState(); // 保存されたフィルタ状態を復元
  }

  // 設定を読み込み
  loadSettings(): void {
    const saveFilterState = localStorage.getItem("saveFilterState");
    
    if (saveFilterState === null) {
      this.saveFilterStateEnabled = true;
    } else {
      this.saveFilterStateEnabled = saveFilterState === "true";
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
    
    // 検索クエリも保存
    const searchInput = document.getElementById('searchInput') as HTMLInputElement;
    if (searchInput) {
      localStorage.setItem('searchQuery', searchInput.value);
    }
  }

  // フィルター状態を読み込み
  loadFilterState(): void {
    // フィルタ状態保存が有効な場合のみ、保存された状態を復元
    if (!this.saveFilterStateEnabled) return;

    try {
      const saved = localStorage.getItem("filterState");
      if (saved) {
        const filterState = JSON.parse(saved);
        this.currentFilter.rating = filterState.rating || 0;
        this.currentFilter.tags = filterState.tags || [];
        this.selectedDirectories = filterState.selectedDirectories || [];
      }
    } catch (error) {
      console.error("FilterManager.loadFilterState - error:", error);
    }
  }

  // 評価フィルターを設定
  setRatingFilter(rating: number): void {
    this.currentFilter.rating = rating;
    this.saveFilterState();
    this.notifyFilterChange();
  }

  // 検索クエリを更新
  updateSearch(query: string): void {
    // 検索クエリは外部で管理されているが、フィルタ状態保存のためにここでも保存
    this.saveFilterState();
    this.notifyFilterChange();
  }

  // タグフィルターを追加
  addTagFilter(tag: string): void {
    if (!this.currentFilter.tags.includes(tag)) {
      this.currentFilter.tags.push(tag);
      this.saveFilterState();
      this.notifyFilterChange();
    }
  }

  // タグフィルターを削除
  removeTagFilter(tag: string): void {
    this.currentFilter.tags = this.currentFilter.tags.filter((t) => t !== tag);
    this.saveFilterState();
    this.notifyFilterChange();
  }

  // ディレクトリ選択を切り替え
  toggleDirectory(directoryPath: string): void {
    const index = this.selectedDirectories.indexOf(directoryPath);
    if (index > -1) {
      this.selectedDirectories.splice(index, 1);
    } else {
      this.selectedDirectories.push(directoryPath);
    }
    
    // フィルタ状態を保存（保存が有効な場合のみ）
    this.saveFilterState();
    
    // フィルタ変更を通知（保存設定に関係なく常に通知）
    this.notifyFilterChange();
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

  // 外部から状態を復元するメソッド（app.tsから使用）
  restoreState(filterData: any): void {
    if (filterData.selectedDirectories) {
      this.selectedDirectories = filterData.selectedDirectories;
    }
    if (filterData.selectedTags) {
      this.currentFilter.tags = filterData.selectedTags;
    }
    if (filterData.ratingFilter !== undefined) {
      this.currentFilter.rating = filterData.ratingFilter;
    }
  }

  // ディレクトリを初期化
  initializeDirectories(directories: Directory[]): void {
    // 利用可能なディレクトリを保存
    localStorage.setItem('availableDirectories', JSON.stringify(directories));
    
    // 存在しないディレクトリを削除
    this.selectedDirectories = this.selectedDirectories.filter((selected) =>
      directories.some((dir) => dir.path === selected)
    );

    // フィルタ状態保存がオフの場合は常に全選択
    if (!this.saveFilterStateEnabled) {
      this.selectedDirectories = directories.map((dir) => dir.path);
    } else {
      // フィルタ状態保存がオンの場合、初回起動時（フィルタ状態が保存されていない場合）のみ全て選択
      const hasFilterState = localStorage.getItem('filterState') !== null;
      if (!hasFilterState && this.selectedDirectories.length === 0 && directories.length > 0) {
        this.selectedDirectories = directories.map((dir) => dir.path);
      }
    }

    // 状態を保存（フィルタ状態保存が有効な場合のみ）
    if (this.saveFilterStateEnabled) {
      this.saveFilterState();
    }
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
  getFilterData(): { 
    selectedTags: string[], 
    selectedDirectories: string[], 
    searchQuery: string,
    ratingFilter: number,
    hasDirectoryFilter: boolean
  } {
    // 検索クエリを取得
    const searchInput = document.getElementById('searchInput') as HTMLInputElement;
    const searchQuery = searchInput ? searchInput.value.trim() : '';
    
    // ディレクトリフィルタが設定されているかを判定
    // 選択されたディレクトリがある場合は常にフィルタを適用
    const hasDirectoryFilter = this.selectedDirectories.length > 0;
    
    return {
      selectedTags: [...this.currentFilter.tags],
      selectedDirectories: [...this.selectedDirectories],
      searchQuery: searchQuery,
      ratingFilter: this.currentFilter.rating,
      hasDirectoryFilter: hasDirectoryFilter
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
    this.notifyFilterChange();
  }

  // ディレクトリ選択を切り替え（app.jsとの互換性のため）
  toggleDirectorySelection(directoryPath: string): void {
    this.toggleDirectory(directoryPath);
  }

    // すべてのタグフィルターをクリア（app.tsとの互換性のため）
  clearTagsFilter(): void {
    this.currentFilter.tags = [];
    this.saveFilterState();
    this.notifyFilterChange();
  }

  // すべてのディレクトリを選択
  selectAllDirectories(): void {
    // 現在利用可能なディレクトリを取得
    const directories = JSON.parse(localStorage.getItem('availableDirectories') || '[]');
    this.selectedDirectories = directories.map((dir: Directory) => dir.path);
    this.saveFilterState();
    this.notifyFilterChange();
  }

  // すべてのディレクトリの選択を解除
  deselectAllDirectories(): void {
    this.selectedDirectories = [];
    this.saveFilterState();
    this.notifyFilterChange();
  }

  // ディレクトリリストを更新（内部で利用可能なディレクトリを保存）
  updateAvailableDirectories(directories: Directory[]): void {
    localStorage.setItem('availableDirectories', JSON.stringify(directories));
    this.initializeDirectories(directories);
  }
}
