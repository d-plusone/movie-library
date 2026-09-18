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
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FilterState, SavedFilter, TagMatchMode } from "../types";
import type { SortSpec } from "../lib/filters";

interface FilterContextValue {
  filters: FilterState;
  search: string;
  setSearch: (value: string) => void;
  setRating: (rating: number) => void;
  setTagMatchMode: (mode: TagMatchMode) => void;
  setUnratedOnly: (enabled: boolean) => void;
  setUntaggedOnly: (enabled: boolean) => void;
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
  syncAvailableDirectories: (paths: string[], unavailablePaths?: string[]) => void;
  /** 現在登録されている利用可能ディレクトリ。描画中に localStorage を読まないための state */
  availableDirectories: string[];

  savedFilters: SavedFilter[];
  saveCurrentFilter: (name: string) => boolean;
  applySavedFilter: (id: string) => boolean;
  deleteSavedFilter: (id: string) => void;
}

const FilterContext = createContext<FilterContextValue | null>(null);

const LS_FILTER_STATE = "filterState";
const LS_SEARCH_QUERY = "searchQuery";
const LS_AVAILABLE_DIRS = "availableDirectories";
const LS_SAVE_ENABLED = "saveFilterState";
const LS_VIEW_MODE = "viewMode";
const LS_SAVED_FILTERS = "savedFilters";

/** filterState の永続化フォーマット */
interface PersistedFilters {
  rating?: number;
  tags?: string[];
  selectedDirectories?: string[];
  resolutions?: string[];
  codecs?: string[];
  tagMatchMode?: TagMatchMode;
  unratedOnly?: boolean;
  untaggedOnly?: boolean;
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
  return {
    rating: 0,
    tags: [],
    directories: [],
    resolutions: [],
    codecs: [],
    tagMatchMode: "OR",
    unratedOnly: false,
    untaggedOnly: false,
  };
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
      tagMatchMode: parsed.tagMatchMode === "AND" ? "AND" : "OR",
      unratedOnly: parsed.unratedOnly === true,
      untaggedOnly: parsed.untaggedOnly === true,
    };
  } catch {
    return emptyFilters();
  }
}

function readInitialSavedFilters(): SavedFilter[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_SAVED_FILTERS) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): SavedFilter[] => {
      if (entry === null || typeof entry !== "object") return [];
      const candidate = entry as Partial<SavedFilter>;
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
      if (typeof candidate.search !== "string" || candidate.filters === null || typeof candidate.filters !== "object") return [];
      const raw = candidate.filters as Partial<FilterState>;
      const filters: FilterState = {
        rating: typeof raw.rating === "number" ? raw.rating : 0,
        tags: asStringArray(raw.tags),
        directories: asStringArray(raw.directories),
        resolutions: asStringArray(raw.resolutions),
        codecs: asStringArray(raw.codecs),
        tagMatchMode: raw.tagMatchMode === "AND" ? "AND" : "OR",
        unratedOnly: raw.unratedOnly === true,
        untaggedOnly: raw.untaggedOnly === true,
      };
      const now = new Date().toISOString();
      return [{
        id: candidate.id,
        name: candidate.name.trim(),
        filters,
        search: candidate.search,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now,
      }];
    }).filter((entry) => entry.name.length > 0);
  } catch {
    return [];
  }
}

function createSavedFilterId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readInitialSearch(): string {
  if (!readSaveEnabled()) return "";
  return localStorage.getItem(LS_SEARCH_QUERY) ?? "";
}

function readInitialAvailableDirectories(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(LS_AVAILABLE_DIRS) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** リスト内での値のトグル（なければ追加、あれば除去） */
function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<FilterState>(readInitialFilters);
  const [search, setSearch] = useState<string>(readInitialSearch);
  const [saveEnabled, setSaveEnabledState] = useState<boolean>(readSaveEnabled);
  const [availableDirectories, setAvailableDirectories] = useState<string[]>(
    readInitialAvailableDirectories,
  );
  const [sort, setSort] = useState<SortSpec>(() => ({
    field: (localStorage.getItem("sortField") as SortSpec["field"] | null) ?? "addedAt",
    order: localStorage.getItem("sortOrder") === "ASC" ? "ASC" : "DESC",
  }));
  const [view, setViewState] = useState<"grid" | "list">(() =>
    localStorage.getItem(LS_VIEW_MODE) === "list" ? "list" : "grid",
  );
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(readInitialSavedFilters);

  /** 接続エラーで選択から外れたディレクトリ（復帰時に自動で選択へ戻す） */
  const pendingSelectionRef = useRef<Set<string>>(new Set());

  /**
   * ディレクトリ一覧の同期。
   * 実際に変化がある場合のみ state を更新する（同一オブジェクトを返すことで
   * 再レンダリングを抑制し、呼び出し側 effect の無限ループを防ぐ）。
   *
   * unavailablePaths（NAS 切断中など）は選択対象から除外する。
   * 除外した選択は記憶しておき、復帰時に自動で選択へ戻す。
   */
  const syncAvailableDirectories = useCallback(
    (paths: string[], unavailablePaths: string[] = []): void => {
      localStorage.setItem(LS_AVAILABLE_DIRS, JSON.stringify(paths));
      setAvailableDirectories((current) =>
        current.length === paths.length && current.every((path, i) => path === paths[i])
          ? current
          : paths,
      );

      const sameList = (a: string[], b: string[]): boolean =>
        a.length === b.length && a.every((item, i) => item === b[i]);

      const unavailable = new Set(unavailablePaths);
      const selectablePaths = paths.filter((path) => !unavailable.has(path));

      setFilters((prev) => {
        if (!readSaveEnabled()) {
          // 保存無効時は常に全選択（ただし切断中のディレクトリは除く）
          return sameList(prev.directories, selectablePaths)
            ? prev
            : { ...prev, directories: selectablePaths };
        }

        const selectable = new Set(selectablePaths);
        const pruned = prev.directories.filter((selected) => selectable.has(selected));
        for (const removed of prev.directories) {
          if (!selectable.has(removed)) {
            // 切断で選択から外れたディレクトリは、復帰時に戻せるよう記憶しておく
            pendingSelectionRef.current.add(removed);
          }
        }
        const restored: string[] = [];
        for (const pending of pendingSelectionRef.current) {
          if (selectable.has(pending) && !pruned.includes(pending)) {
            restored.push(pending);
            pendingSelectionRef.current.delete(pending);
          }
        }
        const next =
          restored.length > 0 ? [...pruned, ...restored] : pruned;

        const hasSavedState = localStorage.getItem(LS_FILTER_STATE) !== null;
        if (!hasSavedState && next.length === 0 && selectablePaths.length > 0) {
          // 初回起動時のみ全選択
          return sameList(prev.directories, selectablePaths)
            ? prev
            : { ...prev, directories: selectablePaths };
        }
        return sameList(prev.directories, next) ? prev : { ...prev, directories: next };
      });
    },
    [],
  );

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
        tagMatchMode: filters.tagMatchMode,
        unratedOnly: filters.unratedOnly,
        untaggedOnly: filters.untaggedOnly,
      }),
    );
    localStorage.setItem(LS_SEARCH_QUERY, search);
  }, [filters, search, saveEnabled]);

  useEffect(() => {
    localStorage.setItem(LS_SAVED_FILTERS, JSON.stringify(savedFilters));
  }, [savedFilters]);

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
      setTagMatchMode: (tagMatchMode) => setFilters((prev) => ({ ...prev, tagMatchMode })),
      setUnratedOnly: (unratedOnly) => setFilters((prev) => ({ ...prev, unratedOnly })),
      setUntaggedOnly: (untaggedOnly) => setFilters((prev) => ({ ...prev, untaggedOnly })),
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
      availableDirectories,
      savedFilters,
      saveCurrentFilter: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        const now = new Date().toISOString();
        setSavedFilters((current) => {
          const existing = current.find((entry) => entry.name === trimmed);
          const next: SavedFilter = {
            id: existing?.id ?? createSavedFilterId(),
            name: trimmed,
            filters: { ...filters, tags: [...filters.tags], directories: [...filters.directories], resolutions: [...filters.resolutions], codecs: [...filters.codecs] },
            search,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          return existing
            ? current.map((entry) => (entry.id === existing.id ? next : entry))
            : [...current, next];
        });
        return true;
      },
      applySavedFilter: (id) => {
        const saved = savedFilters.find((entry) => entry.id === id);
        if (!saved) return false;
        setFilters({
          ...saved.filters,
          tags: [...saved.filters.tags],
          directories: [...saved.filters.directories],
          resolutions: [...saved.filters.resolutions],
          codecs: [...saved.filters.codecs],
        });
        setSearch(saved.search);
        return true;
      },
      deleteSavedFilter: (id) => setSavedFilters((current) => current.filter((entry) => entry.id !== id)),
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
    availableDirectories,
    savedFilters,
  ]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterContextValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilters must be used within FilterProvider");
  return ctx;
}
