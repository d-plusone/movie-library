/**
 * フィルタ / 検索 / ソート / 表示モードの状態管理
 * （旧 FilterManager + app.ts のソート・ビュー状態の移植）
 *
 * localStorage 永続化の挙動も旧実装に合わせる:
 * - saveFilterState が有効な場合のみ filters / search を保存・復元する
 * - viewMode / sortField / sortOrder は設定に関係なく常時保存する
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { FilterState } from "../types";
import type { SortSpec } from "../lib/filters";

interface FilterContextValue {
  filters: FilterState;
  search: string;
  setSearch: (value: string) => void;
  setRating: (rating: number) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  toggleDirectory: (path: string) => void;
  selectAllDirectories: (paths: string[]) => void;
  deselectAllDirectories: () => void;
  toggleResolution: (label: string) => void;
  selectAllResolutions: (labels: string[]) => void;
  clearResolutions: () => void;
  toggleCodec: (codec: string) => void;
  selectAllCodecs: (codecs: string[]) => void;
  clearCodecs: () => void;

  sort: SortSpec;
  setSortField: (field: SortSpec["field"]) => void;
  setSortOrder: (order: SortSpec["order"]) => void;

  view: "grid" | "list";
  setView: (view: "grid" | "list") => void;

  saveEnabled: boolean;
  setSaveEnabled: (enabled: boolean) => void;

  /** ディレクトリ一覧の同期（選択状態のプルーニングと初回全選択を含む） */
  syncAvailableDirectories: (paths: string[]) => void;
}

const FilterContext = createContext<FilterContextValue | null>(null);

const LS_FILTER_STATE = "filterState";
const LS_SEARCH_QUERY = "searchQuery";
const LS_AVAILABLE_DIRS = "availableDirectories";
const LS_SAVE_ENABLED = "saveFilterState";
const LS_VIEW_MODE = "viewMode";

/** filterState の永続化フォーマット */
interface PersistedFilters {
  rating?: number;
  tags?: string[];
  selectedDirectories?: string[];
  resolutions?: string[];
  codecs?: string[];
}

function readSaveEnabled(): boolean {
  const stored = localStorage.getItem(LS_SAVE_ENABLED);
  return stored === null ? true : stored === "true";
}

function asStringArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function emptyFilters(): FilterState {
  return { rating: 0, tags: [], directories: [], resolutions: [], codecs: [] };
}

function readInitialFilters(): FilterState {
  if (!readSaveEnabled()) return emptyFilters();
  const stored = localStorage.getItem(LS_FILTER_STATE);
  if (!stored) return emptyFilters();
  try {
    // JSON.parse の戻りは型を持たないため、ここで永続化フォーマットへ絞り込む
    const parsed: Partial<PersistedFilters> = JSON.parse(stored);
    const ratingValue = parsed.rating;
    return {
      rating: typeof ratingValue === "number" ? ratingValue : 0,
      tags: asStringArray(parsed.tags),
      directories: asStringArray(parsed.selectedDirectories),
      resolutions: asStringArray(parsed.resolutions),
      codecs: asStringArray(parsed.codecs),
    };
  } catch {
    return emptyFilters();
  }
}

function readInitialSearch(): string {
  if (!readSaveEnabled()) return "";
  return localStorage.getItem(LS_SEARCH_QUERY) ?? "";
}

/** リスト内での値のトグル（なければ追加、あれば除去） */
function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<FilterState>(readInitialFilters);
  const [search, setSearch] = useState<string>(readInitialSearch);
  const [saveEnabled, setSaveEnabledState] = useState<boolean>(readSaveEnabled);
  const [sort, setSort] = useState<SortSpec>(() => ({
    field: (localStorage.getItem("sortField") as SortSpec["field"] | null) ?? "addedAt",
    order: localStorage.getItem("sortOrder") === "ASC" ? "ASC" : "DESC",
  }));
  const [view, setViewState] = useState<"grid" | "list">(() =>
    localStorage.getItem(LS_VIEW_MODE) === "list" ? "list" : "grid",
  );

  /**
   * ディレクトリ一覧の同期。
   * 実際に変化がある場合のみ state を更新する（同一オブジェクトを返すことで
   * 再レンダリングを抑制し、呼び出し側 effect の無限ループを防ぐ）。
   */
  const syncAvailableDirectories = useCallback((paths: string[]): void => {
    localStorage.setItem(LS_AVAILABLE_DIRS, JSON.stringify(paths));

    const sameList = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((item, i) => item === b[i]);

    setFilters((prev) => {
      if (!readSaveEnabled()) {
        // 保存無効時は常に全選択
        return sameList(prev.directories, paths) ? prev : { ...prev, directories: paths };
      }

      const pruned = prev.directories.filter((selected) => paths.includes(selected));
      const hasSavedState = localStorage.getItem(LS_FILTER_STATE) !== null;
      if (!hasSavedState && pruned.length === 0 && paths.length > 0) {
        // 初回起動時のみ全選択
        return sameList(prev.directories, paths) ? prev : { ...prev, directories: paths };
      }
      return sameList(prev.directories, pruned) ? prev : { ...prev, directories: pruned };
    });
  }, []);

  // 永続化（保存が有効な場合のみ）
  useEffect(() => {
    if (!saveEnabled) return;
    localStorage.setItem(
      LS_FILTER_STATE,
      JSON.stringify({
        rating: filters.rating,
        tags: filters.tags,
        selectedDirectories: filters.directories,
        resolutions: filters.resolutions,
        codecs: filters.codecs,
      }),
    );
    localStorage.setItem(LS_SEARCH_QUERY, search);
  }, [filters, search, saveEnabled]);

  const toggleTag = useCallback(
    (tag: string) => setFilters((prev) => ({ ...prev, tags: toggled(prev.tags, tag) })),
    [],
  );
  const toggleDirectory = useCallback(
    (path: string) =>
      setFilters((prev) => ({ ...prev, directories: toggled(prev.directories, path) })),
    [],
  );
  const toggleResolution = useCallback(
    (label: string) =>
      setFilters((prev) => ({ ...prev, resolutions: toggled(prev.resolutions, label) })),
    [],
  );
  const toggleCodec = useCallback(
    (codec: string) => setFilters((prev) => ({ ...prev, codecs: toggled(prev.codecs, codec) })),
    [],
  );

  const value = useMemo<FilterContextValue>(() => {
    const setSaveEnabled = (enabled: boolean): void => {
      setSaveEnabledState(enabled);
      localStorage.setItem(LS_SAVE_ENABLED, String(enabled));
      // 無効化した場合は保存済み状態をクリアする
      // （次回起動時に初期状態で起動することを保証）
      if (!enabled) {
        localStorage.removeItem(LS_FILTER_STATE);
        localStorage.removeItem(LS_SEARCH_QUERY);
      }
    };

    return {
      filters,
      search,
      setSearch,
      setRating: (rating) => setFilters((prev) => ({ ...prev, rating })),
      toggleTag,
      clearTags: () => setFilters((prev) => ({ ...prev, tags: [] })),
      toggleDirectory,
      selectAllDirectories: (paths) => setFilters((prev) => ({ ...prev, directories: paths })),
      deselectAllDirectories: () => setFilters((prev) => ({ ...prev, directories: [] })),
      toggleResolution,
      selectAllResolutions: (labels) =>
        setFilters((prev) => ({ ...prev, resolutions: labels })),
      clearResolutions: () => setFilters((prev) => ({ ...prev, resolutions: [] })),
      toggleCodec,
      selectAllCodecs: (codecs) => setFilters((prev) => ({ ...prev, codecs })),
      clearCodecs: () => setFilters((prev) => ({ ...prev, codecs: [] })),

      sort,
      setSortField: (field) =>
        setSort((prev) => {
          localStorage.setItem("sortField", field);
          return { ...prev, field };
        }),
      setSortOrder: (order) =>
        setSort((prev) => {
          localStorage.setItem("sortOrder", order);
          return { ...prev, order };
        }),

      view,
      setView: (next) => {
        setViewState(next);
        localStorage.setItem(LS_VIEW_MODE, next);
      },

      saveEnabled,
      setSaveEnabled,

      syncAvailableDirectories,
    };
  }, [
    filters,
    search,
    sort,
    view,
    saveEnabled,
    toggleTag,
    toggleDirectory,
    toggleResolution,
    toggleCodec,
    syncAvailableDirectories,
  ]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterContextValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilters must be used within FilterProvider");
  return ctx;
}
