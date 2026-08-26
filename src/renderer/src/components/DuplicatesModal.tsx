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
import { useUi } from "../state/UiContext";
import type { DeleteProgress, DuplicateGroup } from "../../../types/types";

interface ProgressMessage {
  current: number;
  total: number;
  message: string;
}

/** グループ内を解像度の高い順に並べ替える */
function sortByQuality(group: DuplicateGroup): DuplicateGroup {
  const videos = [...group.videos].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );
  return { ...group, videos };
}

export function DuplicatesModal() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();

  const [phase, setPhase] = useState<"idle" | "searching" | "done">("idle");
  const [searchProgress, setSearchProgress] = useState<ProgressMessage | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  /** 削除対象として選択された videoId の集合 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, ui.duplicatesOpen);

  // モーダルが開いたら検索を開始する
  useEffect(() => {
    if (!ui.duplicatesOpen) return;

    setPhase("searching");
    setGroups([]);
    setSelectedIds(new Set());
    setSearchProgress(null);
    setDeleteProgress(null);

    const onProgress = (data: ProgressMessage): void => {
      setSearchProgress(data);
    };
    ipc().onDuplicateSearchProgress(onProgress);

    const onDelete = (data: DeleteProgress): void => {
      setDeleteProgress(data);
    };
    ipc().onDeleteProgress(onDelete);

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
          ui.setDuplicatesOpen(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      ipc().offDuplicateSearchProgress(onProgress);
      ipc().offDeleteProgress(onDelete);
    };
  }, [ui.duplicatesOpen]);

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
  const buildDeleteRequests = (): Array<{ videoId: number; verifyAgainstVideoId: number }> =>
    groups.flatMap((group) => {
      const keep = group.videos.find((video) => !selectedIds.has(video.id));
      if (!keep) return [];
      return group.videos
        .filter((video) => selectedIds.has(video.id))
        .map((video) => ({ videoId: video.id, verifyAgainstVideoId: keep.id }));
    });

  const deleteSelected = async (): Promise<void> => {
    const requests = buildDeleteRequests();
    if (requests.length === 0) return;
    const confirmed = window.confirm(
      `選択した${requests.length}件の動画を削除しますか？\n\n動画ファイルはゴミ箱に移動されます。`,
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      const result = await ipc().deleteVideos(requests, true);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
        qc.invalidateQueries({ queryKey: queryKeys.directories }),
      ]);
      ui.setDuplicatesOpen(false);

      if (result.failed === 0) {
        notify(`${result.success}件の重複動画を削除しました`, "success");
      } else {
        notify(`${result.success}件削除しました（${result.failed}件失敗）`, "warning");
      }
    } catch (e) {
      console.error("Failed to delete duplicates:", e);
      notify(
        `動画の削除に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    } finally {
      setDeleting(false);
      setDeleteProgress(null);
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

        <div className="modal-body">
          {phase === "searching" && (
            <div className="duplicate-searching">
              <div className="spinner" />
              <p>
                重複動画を検索中...
                {searchProgress !== null &&
                  ` (${searchProgress.current}/${searchProgress.total} ${searchProgress.message})`}
              </p>
            </div>
          )}

          {phase === "done" && (
            <div className="duplicate-results">
              <div className="duplicate-summary">
                <p>
                  <strong>{groups.length}</strong> グループの重複が見つかりました
                </p>
              </div>
              <div id="duplicateGroupsList" className="duplicate-groups-list">
                {groups.length === 0 && (
                  <div className="no-duplicates-message">
                    <div className="icon">✓</div>
                    <p>重複する動画は見つかりませんでした</p>
                  </div>
                )}
                {groups.map((group) => (
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
              </div>
              {deleting && deleteProgress !== null && (
                <p>
                  削除中... ({deleteProgress.current}/{deleteProgress.total})
                </p>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            id="deleteDuplicatesBtn"
            className="btn btn-danger"
            disabled={totalSelectedCount(selectedIds) === 0 || deleting}
            onClick={() => void deleteSelected()}
          >
            {totalSelectedCount(selectedIds) > 0
              ? `選択した${totalSelectedCount(selectedIds)}件の動画を削除`
              : "選択した動画を削除"}
          </button>
          <button
            type="button"
            id="cancelDuplicateBtn"
            className="btn btn-secondary"
            disabled={deleting}
            onClick={() => ui.setDuplicatesOpen(false)}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

function totalSelectedCount(selected: Set<number>): number {
  return selected.size;
}
