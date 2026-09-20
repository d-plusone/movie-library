/**
 * 重複動画検索モーダル
 * 開いた時点で検索を開始し、部分ハッシュ一致グループを表示する。
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { formatDuration, formatFileSize, pathToFileUrl } from "../lib/format";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useProgress } from "../state/ProgressContext";
import { useUi } from "../state/UiContext";
import type {
  DeleteVideoRequest,
  DuplicateGroup,
  DuplicateSearchProgress,
} from "../../../types/types";

type DuplicateViewMode = "file" | "directory";

interface DirectoryDuplicateGroup {
  key: string;
  directories: string[];
  groups: DuplicateGroup[];
}

function directoryForPath(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separatorIndex < 0) return trimmed;
  if (separatorIndex === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, separatorIndex);
}

function buildDirectoryDuplicateGroups(groups: DuplicateGroup[]): DirectoryDuplicateGroup[] {
  const grouped = new Map<string, DirectoryDuplicateGroup>();

  for (const group of groups) {
    const directories = [...new Set(group.videos.map((video) => directoryForPath(video.path)))].sort(
      (a, b) => a.localeCompare(b),
    );
    if (directories.length < 2) continue;

    const key = JSON.stringify(directories);
    const current = grouped.get(key);
    if (current) {
      current.groups.push(group);
    } else {
      grouped.set(key, { key, directories, groups: [group] });
    }
  }

  return [...grouped.values()].sort((a, b) => a.directories.join("\n").localeCompare(b.directories.join("\n")));
}

function sortVideosByQuality(group: DuplicateGroup): DuplicateGroup["videos"] {
  return [...group.videos].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );
}

function directoryDeleteCount(
  group: DirectoryDuplicateGroup,
  targetDirectory: string,
): number {
  return group.groups.reduce((total, duplicateGroup) => {
    const keep = sortVideosByQuality(duplicateGroup).find(
      (video) => directoryForPath(video.path) === targetDirectory,
    );
    return total + (keep === undefined ? 0 : duplicateGroup.videos.length - 1);
  }, 0);
}

interface DirectoryDuplicateBrowserProps {
  groups: DirectoryDuplicateGroup[];
  targets: Record<string, string>;
  selectedGroupKey: string | null;
  onSelectGroup: (key: string) => void;
  onTargetChange: (key: string, target: string) => void;
}

function DirectoryDuplicateBrowser({
  groups,
  targets,
  selectedGroupKey,
  onSelectGroup,
  onTargetChange,
}: DirectoryDuplicateBrowserProps) {
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? groups[0];
  if (selectedGroup === undefined) return null;

  const selectedIndex = groups.findIndex((group) => group.key === selectedGroup.key);
  const targetDirectory = targets[selectedGroup.key] ?? selectedGroup.directories[0]!;
  const targetDeleteCount = directoryDeleteCount(selectedGroup, targetDirectory);

  return (
    <div className="duplicate-directory-browser">
      <aside className="duplicate-directory-navigator" aria-label="ディレクトリ重複グループ一覧">
        <div className="duplicate-directory-navigator-header">
          <strong>{groups.length}</strong>
          <span>グループ</span>
        </div>
        <div className="duplicate-directory-navigator-list">
          {groups.map((group, index) => {
            const groupTarget = targets[group.key] ?? group.directories[0]!;
            const deleteCount = directoryDeleteCount(group, groupTarget);
            const active = group.key === selectedGroup.key;
            return (
              <button
                key={group.key}
                type="button"
                className={`duplicate-directory-navigator-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelectGroup(group.key)}
              >
                <span className="duplicate-directory-navigator-number">{index + 1}</span>
                <span className="duplicate-directory-navigator-info">
                  <strong title={group.directories.join(" ↔ ")}>
                    {group.directories.join(" ↔ ")}
                  </strong>
                  <small>
                    {group.groups.length}グループ · {deleteCount}件を整理
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="duplicate-directory-detail" aria-label="選択中のディレクトリ重複">
        <div className="duplicate-directory-detail-header">
          <div>
            <span className="duplicate-directory-detail-position">
              グループ {selectedIndex + 1} / {groups.length}
            </span>
            <h3>ディレクトリ間の重複</h3>
          </div>
          <div className="duplicate-directory-detail-navigation">
            <button
              type="button"
              className="btn btn-small btn-secondary"
              disabled={selectedIndex <= 0}
              onClick={() => onSelectGroup(groups[selectedIndex - 1]!.key)}
            >
              ← 前へ
            </button>
            <button
              type="button"
              className="btn btn-small btn-secondary"
              disabled={selectedIndex >= groups.length - 1}
              onClick={() => onSelectGroup(groups[selectedIndex + 1]!.key)}
            >
              次へ →
            </button>
          </div>
        </div>

        <div className="duplicate-directory-target-panel">
          <div className="duplicate-directory-target-heading">
            <span>寄せ先</span>
            <strong>{targetDeleteCount}件をゴミ箱へ移動</strong>
          </div>
          {selectedGroup.directories.length <= 2 ? (
            <div className="duplicate-directory-target-buttons" role="group" aria-label="寄せ先ディレクトリ">
              {selectedGroup.directories.map((directory) => (
                <button
                  key={directory}
                  type="button"
                  className={`duplicate-directory-target-button${directory === targetDirectory ? " active" : ""}`}
                  aria-pressed={directory === targetDirectory}
                  title={directory}
                  onClick={() => onTargetChange(selectedGroup.key, directory)}
                >
                  {directory}
                </button>
              ))}
            </div>
          ) : (
            <select
              className="duplicate-directory-target-select"
              value={targetDirectory}
              aria-label="寄せ先ディレクトリ"
              onChange={(event) => onTargetChange(selectedGroup.key, event.target.value)}
            >
              {selectedGroup.directories.map((directory) => (
                <option key={directory} value={directory}>
                  {directory}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="duplicate-directory-content-list">
          {selectedGroup.groups.map((group) => {
            const sortedVideos = sortVideosByQuality(group);
            const keep = sortedVideos.find(
              (video) => directoryForPath(video.path) === targetDirectory,
            );
            return (
              <div key={group.hash} className="duplicate-directory-content-group">
                <div className="duplicate-directory-content-title">
                  グループ {group.hash.substring(0, 8)}（{group.videos.length}件）
                </div>
                <div className="duplicate-directory-comparison">
                  {selectedGroup.directories.map((directory) => {
                    const directoryVideos = sortedVideos.filter(
                      (video) => directoryForPath(video.path) === directory,
                    );
                    return (
                      <div
                        key={directory}
                        className={`duplicate-directory-column${directory === targetDirectory ? " target" : ""}`}
                      >
                        <div className="duplicate-directory-column-header">
                          <strong title={directory}>{directory}</strong>
                          <span>{directoryVideos.length}件</span>
                        </div>
                        {directoryVideos.length === 0 && (
                          <div className="duplicate-directory-column-empty">このグループにはありません</div>
                        )}
                        {directoryVideos.map((item) => {
                          const isKept = item.id === keep?.id;
                          return (
                            <div
                              key={item.id}
                              className={`duplicate-directory-file-row${isKept ? " kept" : " to-delete"}`}
                            >
                              {item.thumbnailPath && (
                                <img
                                  src={pathToFileUrl(item.thumbnailPath)}
                                  alt={item.filename}
                                />
                              )}
                              <div className="duplicate-directory-file-info">
                                <strong title={item.filename}>{item.filename}</strong>
                                <span title={item.path}>{item.path}</span>
                                <small>
                                  {item.width}×{item.height} · {formatFileSize(item.size)} · {formatDuration(item.duration)}
                                </small>
                              </div>
                              <em>{isKept ? "保持" : "整理"}</em>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** グループ内を解像度の高い順に並べ替える */
function sortByQuality(group: DuplicateGroup): DuplicateGroup {
  return { ...group, videos: sortVideosByQuality(group) };
}

export function DuplicatesModal() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const { entries: progressEntries } = useProgress();
  const ui = useUi();
  const { duplicatesOpen, setDuplicatesOpen } = ui;

  const [phase, setPhase] = useState<"idle" | "searching" | "done">("idle");
  const [searchProgress, setSearchProgress] =
    useState<DuplicateSearchProgress | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [viewMode, setViewMode] = useState<DuplicateViewMode>("file");
  const [directoryTargets, setDirectoryTargets] = useState<Record<string, string>>({});
  const [selectedDirectoryGroupKey, setSelectedDirectoryGroupKey] = useState<string | null>(null);
  /** 削除対象として選択された videoId の集合 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const deleteRunning = progressEntries.some(
    (entry) => entry.id === "delete-progress" && !entry.completed,
  );

  const directoryGroups = buildDirectoryDuplicateGroups(groups);

  useEffect(() => {
    setDirectoryTargets((current) => {
      let changed = false;
      const next = { ...current };
      const validKeys = new Set(directoryGroups.map((group) => group.key));

      for (const key of Object.keys(next)) {
        if (!validKeys.has(key)) {
          delete next[key];
          changed = true;
        }
      }
      for (const group of directoryGroups) {
        const currentTarget = next[group.key];
        if (currentTarget === undefined || !group.directories.includes(currentTarget)) {
          next[group.key] = group.directories[0]!;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [directoryGroups]);

  useEffect(() => {
    setSelectedDirectoryGroupKey((current) => {
      if (current !== null && directoryGroups.some((group) => group.key === current)) {
        return current;
      }
      return directoryGroups[0]?.key ?? null;
    });
  }, [directoryGroups]);

  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, ui.duplicatesOpen);

  // モーダルが開いたら検索を開始する
  useEffect(() => {
    if (!duplicatesOpen) return;

    setPhase("searching");
    setGroups([]);
    setSelectedIds(new Set());
    setSearchProgress(null);

    const onProgress = (data: DuplicateSearchProgress): void => {
      setSearchProgress(data);
    };
    ipc().onDuplicateSearchProgress(onProgress);

    let cancelled = false;
    void (async () => {
      try {
        const result = await ipc().findDuplicates();
        if (cancelled) return;

        setGroups(result.map(sortByQuality));
        // 各グループで最良品質の 1 件を保持とし、それ以外を選択状態にする
        const initialSelection = new Set<number>();
        for (const group of result) {
          for (const candidate of sortByQuality(group).videos.slice(1)) {
            initialSelection.add(candidate.id);
          }
        }
        setSelectedIds(initialSelection);
        setPhase("done");
      } catch (e) {
        if (!cancelled) {
          console.error("Failed to find duplicates:", e);
          notify(
            `重複動画の検索に失敗しました (${e instanceof Error ? e.message : String(e)})`,
            "error",
          );
          setDuplicatesOpen(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      void ipc().cancelDuplicateSearch();
      ipc().offDuplicateSearchProgress(onProgress);
    };
  }, [duplicatesOpen, notify, setDuplicatesOpen]);

  const toggleSelection = (group: DuplicateGroup, videoId: number): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(videoId)) {
        next.delete(videoId);
        return next;
      }
      // グループ内の全件が選択される場合は、別の選択済み 1 件を自動解除する
      const groupIds = group.videos.map((item) => item.id);
      const checkedInGroup = groupIds.filter((id) => next.has(id));
      if (checkedInGroup.length === groupIds.length - 1 && !next.has(videoId)) {
        const firstOtherChecked = checkedInGroup.find((id) => id !== videoId);
        if (firstOtherChecked !== undefined) next.delete(firstOtherChecked);
      }
      next.add(videoId);
      return next;
    });
  };

  /**
   * 選択された videoId ごとに、同一グループ内で保持される（未選択の）動画を
   * 検証基準として組にする。main 側はこの basis とバイト単位で内容が一致することを
   * 削除前に確認するため、対応する組を作れない id（保持候補がいないグループ）は
   * 安全側に倒して削除対象から外す。
   */
  const buildDeleteRequests = (): DeleteVideoRequest[] =>
    groups.flatMap((group) => {
      const keep = group.videos.find((video) => !selectedIds.has(video.id));
      if (!keep) return [];
      return group.videos
        .filter((video) => selectedIds.has(video.id))
        .map((video) => ({ videoId: video.id, verifyAgainstVideoId: keep.id }));
    });

  /** 選択したディレクトリ側の最良コピーを残し、他方の重複コピーを整理する。 */
  const buildDirectoryDeleteRequests = (): DeleteVideoRequest[] => {
    const requests: DeleteVideoRequest[] = [];
    const seenVideoIds = new Set<number>();

    for (const directoryGroup of directoryGroups) {
      const targetDirectory = directoryTargets[directoryGroup.key] ?? directoryGroup.directories[0];
      if (targetDirectory === undefined) continue;

      for (const group of directoryGroup.groups) {
        const targetVideos = sortVideosByQuality(group).filter(
          (video) => directoryForPath(video.path) === targetDirectory,
        );
        const keep = targetVideos[0];
        if (keep === undefined) continue;

        for (const video of group.videos) {
          if (video.id === keep.id || seenVideoIds.has(video.id)) continue;
          seenVideoIds.add(video.id);
          requests.push({
            videoId: video.id,
            verifyAgainstVideoId: keep.id,
          });
        }
      }
    }

    return requests;
  };

  const activeDeleteRequests =
    viewMode === "directory" ? buildDirectoryDeleteRequests() : buildDeleteRequests();

  const deleteSelected = async (): Promise<void> => {
    const requests = activeDeleteRequests;
    if (requests.length === 0 || deleteRunning) return;
    const confirmed = window.confirm(
      viewMode === "directory"
        ? `選択したディレクトリに重複動画を寄せますか？\n\n重複する${requests.length}件の動画ファイルはゴミ箱に移動されます。`
        : `選択した${requests.length}件の動画を削除しますか？\n\n動画ファイルはゴミ箱に移動されます。`,
    );
    if (!confirmed) return;

    // 削除処理は Main 側で継続させ、モーダルを閉じて他の操作を可能にする。
    ui.setDuplicatesOpen(false);
    try {
      const result = await ipc().deleteVideos(requests, true);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
        qc.invalidateQueries({ queryKey: queryKeys.directories }),
      ]);

      if (result.failed === 0) {
        notify(
          viewMode === "directory"
            ? `${result.success}件の重複動画を寄せました`
            : `${result.success}件の重複動画を削除しました`,
          "success",
        );
      } else {
        notify(
          viewMode === "directory"
            ? `${result.success}件寄せました（${result.failed}件失敗）`
            : `${result.success}件削除しました（${result.failed}件失敗）`,
          "warning",
        );
      }
    } catch (e) {
      console.error("Failed to delete duplicates:", e);
      notify(
        `動画の削除に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    }
  };

  if (!ui.duplicatesOpen) return null;

  return (
    <div ref={modalRef} id="duplicateModal" className="modal" role="dialog" aria-modal="true" aria-labelledby="duplicateModalTitle">
      <div className="modal-content duplicate-modal">
        <div className="modal-header">
          <h2 id="duplicateModalTitle">重複動画の検索結果</h2>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="重複検索結果を閉じる"
            onClick={() => ui.setDuplicatesOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="duplicate-view-mode" role="group" aria-label="重複表示モード">
          <span className="duplicate-view-mode-label">表示単位</span>
          <button
            type="button"
            className={`duplicate-view-mode-btn${viewMode === "file" ? " active" : ""}`}
            aria-pressed={viewMode === "file"}
            onClick={() => setViewMode("file")}
          >
            ファイル
          </button>
          <button
            type="button"
            className={`duplicate-view-mode-btn${viewMode === "directory" ? " active" : ""}`}
            aria-pressed={viewMode === "directory"}
            onClick={() => setViewMode("directory")}
          >
            ディレクトリ
          </button>
        </div>

        <div className="modal-body">
          {phase === "searching" && (
            <div className="duplicate-searching">
              <div className="spinner" />
              <p>重複動画を検索中...</p>
              {searchProgress !== null && (
                <div className="duplicate-search-progress">
                  <p className="duplicate-search-progress-message">
                    {searchProgress.message}
                  </p>
                  {searchProgress.detailTotal !== undefined &&
                  searchProgress.detailTotal > 0 ? (
                    <>
                      <div
                        className="duplicate-search-progress-track"
                        role="progressbar"
                        aria-label="部分ハッシュの更新状況"
                        aria-valuemin={0}
                        aria-valuemax={searchProgress.detailTotal}
                        aria-valuenow={searchProgress.detailCurrent ?? 0}
                      >
                        <div
                          className="duplicate-search-progress-fill"
                          style={{
                            width: `${Math.min(
                              100,
                              ((searchProgress.detailCurrent ?? 0) /
                                searchProgress.detailTotal) *
                                100,
                            )}%`,
                          }}
                        />
                      </div>
                      <span className="duplicate-search-progress-count">
                        部分ハッシュ: {searchProgress.detailCurrent ?? 0}/
                        {searchProgress.detailTotal}
                      </span>
                    </>
                  ) : (
                    <span className="duplicate-search-progress-step">
                      ステップ {Math.min(searchProgress.current + 1, searchProgress.total)}/
                      {searchProgress.total}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {phase === "done" && (
            <div className="duplicate-results">
              <div className="duplicate-summary">
                <p>
                  <strong>{viewMode === "directory" ? directoryGroups.length : groups.length}</strong>{" "}
                  {viewMode === "directory"
                    ? "ディレクトリ間の重複グループが見つかりました"
                    : "グループの重複が見つかりました"}
                </p>
              </div>
              <div id="duplicateGroupsList" className="duplicate-groups-list">
                {(viewMode === "directory" ? directoryGroups.length : groups.length) === 0 && (
                  <div className="no-duplicates-message">
                    <div className="icon">✓</div>
                    <p>
                      {viewMode === "directory"
                        ? "ディレクトリをまたぐ重複動画は見つかりませんでした"
                        : "重複する動画は見つかりませんでした"}
                    </p>
                  </div>
                )}
                {viewMode === "file" && groups.map((group) => (
                  <div key={group.hash} className="duplicate-group">
                    <div className="duplicate-group-header">
                      <div className="duplicate-group-title">
                        グループ {group.hash.substring(0, 8)}
                      </div>
                      <div className="duplicate-group-stats">{group.videos.length} 件の重複</div>
                    </div>
                    <div className="duplicate-videos-list">
                      {group.videos.map((item, index) => {
                        const checked = selectedIds.has(item.id);
                        return (
                          <div
                            key={item.id}
                            className={`duplicate-video-item${checked ? " selected" : ""}`}
                            data-video-id={item.id}
                            onClick={(e) => {
                              const target = e.target as HTMLInputElement;
                              if (target.type === "checkbox") return;
                              if (target.closest(".duplicate-video-checkbox")) return;
                              toggleSelection(group, item.id);
                            }}
                          >
                            <div className="duplicate-video-checkbox">
                              <input
                                type="checkbox"
                                data-video-id={item.id}
                                checked={checked}
                                onChange={() => toggleSelection(group, item.id)}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`削除対象: ${item.filename}`}
                              />
                            </div>

                            {item.thumbnailPath && (
                              <img
                                src={pathToFileUrl(item.thumbnailPath)}
                                className="duplicate-video-thumbnail"
                                alt={item.filename}
                              />
                            )}

                            <div className="duplicate-video-info">
                              <div className="duplicate-video-filename">{item.filename}</div>
                              <div className="duplicate-video-path">{item.path}</div>
                              <div className="duplicate-video-details">
                                <div className="duplicate-video-detail">
                                  <span>📐</span>
                                  <span>{item.width}×{item.height}</span>
                                </div>
                                <div className="duplicate-video-detail">
                                  <span>💾</span>
                                  <span>{formatFileSize(item.size)}</span>
                                </div>
                                <div className="duplicate-video-detail">
                                  <span>⏱️</span>
                                  <span>{formatDuration(item.duration)}</span>
                                </div>
                                {index === 0 && (
                                  <div className="duplicate-video-detail recommended">推奨: 保持</div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {viewMode === "directory" && (
                  <DirectoryDuplicateBrowser
                    groups={directoryGroups}
                    targets={directoryTargets}
                    selectedGroupKey={selectedDirectoryGroupKey}
                    onSelectGroup={setSelectedDirectoryGroupKey}
                    onTargetChange={(key, target) => {
                      setDirectoryTargets((current) => ({
                        ...current,
                        [key]: target,
                      }));
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            id="deleteDuplicatesBtn"
            className="btn btn-danger"
            disabled={activeDeleteRequests.length === 0 || deleteRunning}
            onClick={() => void deleteSelected()}
          >
            {viewMode === "directory"
              ? activeDeleteRequests.length > 0
                ? `選択したディレクトリに寄せる（${activeDeleteRequests.length}件）`
                : "寄せる対象の重複はありません"
              : activeDeleteRequests.length > 0
                ? `選択した${activeDeleteRequests.length}件の動画を削除`
                : "選択した動画を削除"}
          </button>
          <button
            type="button"
            id="cancelDuplicateBtn"
            className="btn btn-secondary"
            onClick={() => ui.setDuplicatesOpen(false)}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
