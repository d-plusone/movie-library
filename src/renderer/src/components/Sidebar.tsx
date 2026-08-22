/**
 * サイドバー: 評価・ソート・タグ・フォルダ・解像度・コーデックの各フィルタ
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import {
  codecOptions,
  filterVideos,
  readStoredDirectoryCount,
  resolutionOptions,
  type SortField,
} from "../lib/filters";
import { useDebouncedValue } from "../lib/hooks";
import { useFilters } from "../state/FilterContext";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

const SORT_FIELDS: ReadonlyArray<{ value: SortField; label: string }> = [
  { value: "filename", label: "ファイル名" },
  { value: "title", label: "タイトル" },
  { value: "duration", label: "再生時間" },
  { value: "size", label: "ファイルサイズ" },
  { value: "createdAt", label: "作成日" },
  { value: "rating", label: "評価" },
  { value: "addedAt", label: "追加日" },
];

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function Sidebar() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();
  const filtersState = useFilters();
  const { filters, sort, search } = filtersState;

  const [tagKeyword, setTagKeyword] = useState("");

  const videosQuery = useQuery({
    queryKey: queryKeys.videos,
    queryFn: () => ipc().getVideos(),
    staleTime: Infinity,
  });
  const tagsQuery = useQuery({
    queryKey: queryKeys.tags,
    queryFn: () => ipc().getTags(),
    staleTime: Infinity,
  });
  const directoriesQuery = useQuery({
    queryKey: queryKeys.directories,
    queryFn: () => ipc().getDirectories(),
    staleTime: Infinity,
  });

  const videos = videosQuery.data ?? [];
  const tags = tagsQuery.data ?? [];
  const directories = directoriesQuery.data ?? [];

  // ファセット件数: 各軸の件数は「その軸以外のフィルタを反映した結果」で集計する
  // （例: 解像度の件数は、フォルダ/タグ/検索などの選択状態を反映する）
  const debouncedSearch = useDebouncedValue(search, 200);
  const directoryCount = readStoredDirectoryCount();

  const facetBase = useMemo(
    () =>
      ({
        tags: filterVideos(videos, filters, directoryCount, debouncedSearch, { skip: ["tags"] }),
        resolutions: filterVideos(videos, filters, directoryCount, debouncedSearch, {
          skip: ["resolutions"],
        }),
        codecs: filterVideos(videos, filters, directoryCount, debouncedSearch, { skip: ["codecs"] }),
      }) as const,
    [videos, filters, directoryCount, debouncedSearch],
  );

  // タグの件数は動画データから集計する（旧 get-tags の count:0 固定を解消）
  const tagCounts = new Map<string, number>();
  for (const video of facetBase.tags) {
    for (const tag of video.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const filteredTags = tagKeyword
    ? tags.filter((tag) => tag.name.toLowerCase().includes(tagKeyword.toLowerCase()))
    : tags;

  const deleteTag = useMutation({
    mutationFn: (name: string) => ipc().deleteTag(name),
    onSuccess: async (_result, name) => {
      notify("タグを削除しました", "success");
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
      ]);
      // 削除されたタグが選択中の場合はフィルタから外す
      if (filters.tags.includes(name)) {
        filtersState.toggleTag(name);
      }
    },
    onError: (e) => notify(`タグの削除に失敗しました (${e.message})`, "error"),
  });

  const removeDirectory = useMutation({
    mutationFn: (path: string) => ipc().removeDirectory(path),
    onSuccess: async () => {
      notify("ディレクトリを削除しました", "success");
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.directories }),
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
      ]);
    },
    onError: (e) => notify(`ディレクトリの削除に失敗しました (${e.message})`, "error"),
  });

  const onDeleteTag = (name: string): void => {
    if (!window.confirm(`タグ "${name}" を削除しますか？`)) return;
    void deleteTag.mutateAsync(name);
  };

  const onRemoveDirectory = (path: string): void => {
    const name = basename(path);
    if (!window.confirm(`ディレクトリ "${name}" をライブラリから削除しますか？`)) return;
    void removeDirectory.mutateAsync(path);
  };

  const resOptions = useMemo(
    () => resolutionOptions(facetBase.resolutions),
    [facetBase.resolutions],
  );
  const codecOpts = useMemo(() => codecOptions(facetBase.codecs), [facetBase.codecs]);
  const directoryPaths = directories.map((d) => d.path);

  return (
    <aside id="sidebar" className={`sidebar${ui.sidebarCollapsed ? " collapsed" : ""}`}>
      <div className="sidebar-inner">
        <div className="sidebar-section">
          <h3>フィルター</h3>
          <div className="filter-group">
            <label>評価</label>
            <div className="rating-filter">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rating-btn${filters.rating > 0 && value <= filters.rating ? " active" : ""}`}
                  data-rating={value}
                  aria-label={`評価${value}以上でフィルタ`}
                  aria-pressed={filters.rating > 0 && value <= filters.rating ? "true" : "false"}
                  onClick={() => filtersState.setRating(filters.rating === value ? 0 : value)}
                >
                  {filters.rating > 0 && value <= filters.rating ? "⭐" : "☆"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`rating-btn all-btn${filters.rating === 0 ? " active" : ""}`}
              data-rating={0}
              aria-label="評価フィルターをクリア"
              aria-pressed={filters.rating === 0 ? "true" : "false"}
              onClick={() => filtersState.setRating(0)}
            >
              すべて
            </button>
          </div>

          <div className="filter-group">
            <label>ソート</label>
            <select
              id="sortSelect"
              className="sort-select"
              aria-label="ソート順"
              value={sort.field}
              onChange={(e) => filtersState.setSortField(e.target.value as SortField)}
            >
              {SORT_FIELDS.map((field) => (
                <option key={field.value} value={field.value}>
                  {field.label}
                </option>
              ))}
            </select>
            <select
              id="orderSelect"
              className="sort-select"
              aria-label="並び順"
              value={sort.order}
              onChange={(e) => filtersState.setSortOrder(e.target.value as "ASC" | "DESC")}
            >
              <option value="ASC">昇順</option>
              <option value="DESC">降順</option>
            </select>
          </div>
        </div>

        <div className="sidebar-section">
          <h3>タグ</h3>
          <div className="tag-filter-container">
            <input
              type="text"
              id="tagFilterInput"
              className="tag-filter-input"
              placeholder="タグを検索..."
              aria-label="タグを検索"
              value={tagKeyword}
              onChange={(e) => setTagKeyword(e.target.value)}
            />
            {tagKeyword !== "" && (
              <button
                type="button"
                className="tag-filter-clear-btn"
                title="クリア"
                aria-label="タグ検索をクリア"
                onClick={() => setTagKeyword("")}
              >
                ✕
              </button>
            )}
          </div>
          <div className="tag-controls">
            <button
              type="button"
              id="clearAllTagsBtn"
              className="btn btn-small"
              onClick={() => filtersState.clearTags()}
            >
              全て解除
            </button>
          </div>
          <div id="tagsList" className="tags-list">
            {filteredTags.map((tag) => (
              <div
                key={tag.name}
                className={`tag-item${filters.tags.includes(tag.name) ? " selected" : ""}`}
                data-tag-name={tag.name}
                role="button"
                tabIndex={0}
                onClick={() => filtersState.toggleTag(tag.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") filtersState.toggleTag(tag.name);
                }}
              >
                <span className="tag-name">{tag.name}</span>
                <span className="tag-count">{tagCounts.get(tag.name) ?? 0}</span>
                <div className="tag-actions">
                  <button
                    type="button"
                    className="tag-edit-btn"
                    title="編集"
                    aria-label={`タグ「${tag.name}」を編集`}
                    onClick={(e) => {
                      e.stopPropagation();
                      ui.openTagEdit(tag.name);
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    type="button"
                    className="tag-delete-btn"
                    title="削除"
                    aria-label={`タグ「${tag.name}」を削除`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteTag(tag.name);
                    }}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
            {filteredTags.length === 0 && tagKeyword !== "" && (
              <div className="no-results-message">一致するタグがありません</div>
            )}
          </div>
        </div>

        <div className="sidebar-section">
          <h3>フォルダ</h3>
          <div className="folder-controls">
            <button
              type="button"
              id="selectAllFoldersBtn"
              className="btn btn-small"
              onClick={() => filtersState.selectAllDirectories(directoryPaths)}
            >
              全て選択
            </button>
            <button
              type="button"
              id="deselectAllFoldersBtn"
              className="btn btn-small"
              onClick={() => filtersState.deselectAllDirectories()}
            >
              全て解除
            </button>
          </div>
          <div id="directoriesList" className="directories-list">
            {directories.map((directory) => (
              <div
                key={directory.path}
                className={`directory-item${filters.directories.includes(directory.path) ? " selected" : ""}`}
                data-path={directory.path}
                role="button"
                tabIndex={0}
                onClick={() => filtersState.toggleDirectory(directory.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    filtersState.toggleDirectory(directory.path);
                }}
              >
                <span className="directory-path" title={directory.path}>
                  {basename(directory.path)}
                </span>
                <div className="directory-actions">
                  <button
                    type="button"
                    className="directory-remove-btn"
                    title="削除"
                    aria-label={`フォルダ「${basename(directory.path)}」を削除`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveDirectory(directory.path);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-section">
          <h3>解像度</h3>
          <div className="filter-controls">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => filtersState.selectAllResolutions(resOptions.map((o) => o.label))}
            >
              全て選択
            </button>
            <button
              type="button"
              id="clearResolutionsBtn"
              className="btn btn-small"
              onClick={() => filtersState.clearResolutions()}
            >
              全て解除
            </button>
          </div>
          <div id="resolutionsList" className="resolutions-list">
            {resOptions.map((option) => (
              <div
                key={option.label}
                className={`resolution-item${filters.resolutions.includes(option.label) ? " selected" : ""}`}
                data-resolution={option.label}
                role="button"
                tabIndex={0}
                onClick={() => filtersState.toggleResolution(option.label)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    filtersState.toggleResolution(option.label);
                }}
              >
                <span className="filter-option-name">{option.label}</span>
                <span className="filter-option-count">{option.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-section">
          <h3>コーデック</h3>
          <div className="filter-controls">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => filtersState.selectAllCodecs(codecOpts.map((o) => o.label))}
            >
              全て選択
            </button>
            <button
              type="button"
              id="clearCodecsBtn"
              className="btn btn-small"
              onClick={() => filtersState.clearCodecs()}
            >
              全て解除
            </button>
          </div>
          <div id="codecsList" className="codecs-list">
            {codecOpts.map((option) => (
              <div
                key={option.label}
                className={`codec-item${filters.codecs.includes(option.label) ? " selected" : ""}`}
                data-codec={option.label}
                role="button"
                tabIndex={0}
                onClick={() => filtersState.toggleCodec(option.label)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    filtersState.toggleCodec(option.label);
                }}
              >
                <span className="filter-option-name">{option.label}</span>
                <span className="filter-option-count">{option.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-section">
          <h3>キーボードナビゲーション</h3>
          <div className="keyboard-help">
            <div className="help-group">
              <div className="help-title">グリッドビュー</div>
              <div className="help-item">
                <span className="help-key">↑↓←→</span>
                <span className="help-desc">2次元選択</span>
              </div>
            </div>
            <div className="help-group">
              <div className="help-title">リストビュー</div>
              <div className="help-item">
                <span className="help-key">↑↓←→</span>
                <span className="help-desc">上下選択</span>
              </div>
            </div>
            <div className="help-item">
              <span className="help-key">Enter</span>
              <span className="help-desc">再生</span>
            </div>
            <div className="help-item">
              <span className="help-key">Esc</span>
              <span className="help-desc">詳細を閉じる</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
