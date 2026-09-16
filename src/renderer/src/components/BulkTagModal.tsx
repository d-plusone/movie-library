/**
 * タグ一括反映ダイアログ: 表示中の動画 × タグのマトリクスでチェックを編集し、差分のみ適用する
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";
import type { Tag, Video } from "../types";

interface BulkTagModalProps {
  videos: Video[];
}

/** checks[tag][videoId] の形で現在のチェック状態を保持する */
type CheckMatrix = Map<string, Map<number, boolean>>;

function buildInitialMatrix(videos: Video[], tags: Tag[]): CheckMatrix {
  const matrix: CheckMatrix = new Map();
  for (const tag of tags) {
    const row = new Map<number, boolean>();
    for (const video of videos) {
      row.set(video.id, video.tags?.includes(tag.name) ?? false);
    }
    matrix.set(tag.name, row);
  }
  return matrix;
}

export function BulkTagModal({ videos }: BulkTagModalProps) {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();

  const tagsQuery = useQuery({
    queryKey: queryKeys.tags,
    queryFn: () => ipc().getTags(),
    staleTime: Infinity,
    enabled: ui.bulkTagOpen,
  });

  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data]);
  const [matrix, setMatrix] = useState<CheckMatrix>(new Map());
  const [initialMatrix, setInitialMatrix] = useState<CheckMatrix>(new Map());
  const [keyword, setKeyword] = useState("");

  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, ui.bulkTagOpen);

  // 開くたびに表示中動画 × 全タグで初期化する
  useEffect(() => {
    if (!ui.bulkTagOpen) return;
    const initial = buildInitialMatrix(videos, tags);
    setInitialMatrix(initial);
    setMatrix(new Map([...initial.entries()].map(([tag, row]) => [tag, new Map(row)])));
    setKeyword("");
  }, [ui.bulkTagOpen, videos, tags]);

  const applyMutation = useMutation({
    mutationFn: async (changes: Array<{ videoId: number; tagName: string; action: "add" | "remove" }>) => {
      let successCount = 0;
      let errorCount = 0;
      for (const change of changes) {
        try {
          if (change.action === "add") {
            await ipc().addTagToVideo(change.videoId, change.tagName);
          } else {
            await ipc().removeTagFromVideo(change.videoId, change.tagName);
          }
          successCount++;
        } catch (e) {
          console.error(`Error applying change (${change.action}) for video ${change.videoId}:`, e);
          errorCount++;
        }
      }
      return { successCount, errorCount };
    },
    onSuccess: async ({ successCount, errorCount }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
      ]);
      if (errorCount === 0) {
        notify(`タグの一括反映が完了しました (${successCount}件の変更)`, "success");
      } else {
        notify(
          `タグの一括反映が完了しました (成功: ${successCount}件、失敗: ${errorCount}件)`,
          "warning",
        );
      }
      ui.setBulkTagOpen(false);
    },
    onError: (e) => notify(`タグの一括反映に失敗しました (${e.message})`, "error"),
  });

  if (!ui.bulkTagOpen) return null;

  const visibleTags = keyword
    ? tags.filter((tag) => tag.name.toLowerCase().includes(keyword.toLowerCase()))
    : tags;

  const isChecked = (tagName: string, videoId: number): boolean =>
    matrix.get(tagName)?.get(videoId) ?? false;

  const toggle = (tagName: string, videoId: number): void => {
    setMatrix((current) => {
      const next = new Map([...current.entries()].map(([tag, row]) => [tag, new Map(row)]));
      const row = next.get(tagName);
      if (row !== undefined) row.set(videoId, !(row.get(videoId) ?? false));
      return next;
    });
  };

  const columnState = (
    tagName: string,
  ): { allChecked: boolean; noneChecked: boolean; someChecked: boolean } => {
    const row = matrix.get(tagName);
    if (row === undefined) return { allChecked: false, noneChecked: true, someChecked: false };
    const values = [...row.values()];
    const checked = values.filter((value) => value).length;
    return {
      allChecked: checked === values.length && values.length > 0,
      noneChecked: checked === 0,
      someChecked: checked > 0,
    };
  };

  const toggleColumn = (tagName: string): void => {
    const state = columnState(tagName);
    const target = !state.allChecked; // 全選択なら全解除へ、それ以外は全選択へ
    setMatrix((current) => {
      const next = new Map([...current.entries()].map(([tag, row]) => [tag, new Map(row)]));
      const row = next.get(tagName);
      if (row !== undefined) {
        for (const video of visibleVideosForColumn()) {
          row.set(video.id, target);
        }
      }
      return next;
    });
  };

  function visibleVideosForColumn(): Video[] {
    return videos;
  }

  const apply = (): void => {
    const changes: Array<{ videoId: number; tagName: string; action: "add" | "remove" }> = [];
    for (const video of videos) {
      for (const tag of tags) {
        const current = isChecked(tag.name, video.id);
        const original = initialMatrix.get(tag.name)?.get(video.id) ?? false;
        if (current && !original) {
          changes.push({ videoId: video.id, tagName: tag.name, action: "add" });
        } else if (!current && original) {
          changes.push({ videoId: video.id, tagName: tag.name, action: "remove" });
        }
      }
    }

    if (changes.length === 0) {
      notify("変更がありません", "info");
      ui.setBulkTagOpen(false);
      return;
    }

    const addCount = changes.filter((c) => c.action === "add").length;
    const removeCount = changes.filter((c) => c.action === "remove").length;
    if (!window.confirm(`${addCount}個のタグ追加と${removeCount}個のタグ削除を実行しますか？`)) {
      return;
    }
    void applyMutation.mutateAsync(changes);
  };

  return (
    <div ref={modalRef} id="bulkTagApplyDialog" className="modal" role="dialog" aria-modal="true" aria-labelledby="bulkTagApplyDialogTitle">
      <div className="modal-content bulk-tag-apply-modal">
        <div className="modal-header">
          <h2 id="bulkTagApplyDialogTitle">タグ一括反映</h2>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="タグ一括反映ダイアログを閉じる"
            onClick={() => ui.setBulkTagOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="bulk-tag-apply-container">
            <div className="bulk-tag-filter-container">
              <input
                type="text"
                id="bulkTagFilterInput"
                className="bulk-tag-filter-input"
                placeholder="タグを絞り込む..."
                aria-label="タグを絞り込む"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
            <div className="bulk-tag-apply-table-container">
              <table id="bulkTagApplyTable" className="bulk-tag-apply-table">
                <thead>
                  <tr>
                    <th className="video-name-header sticky-header">動画名</th>
                    {visibleTags.map((tag) => {
                      const state = columnState(tag.name);
                      return (
                        <th key={tag.name} data-tag-name={tag.name}>
                          <input
                            type="checkbox"
                            className="select-all-checkbox"
                            data-tag-name={tag.name}
                            checked={state.allChecked}
                            ref={(element) => {
                              if (element !== null) element.indeterminate = state.someChecked && !state.allChecked;
                            }}
                            onChange={() => toggleColumn(tag.name)}
                            aria-label={`「${tag.name}」を全て${state.allChecked ? "解除" : "選択"}`}
                          />
                          {tag.name}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {videos.map((video) => (
                    <tr key={video.id}>
                      <td className="video-name-cell">{video.title}</td>
                      {visibleTags.map((tag) => (
                        <td key={tag.name} data-tag-name={tag.name}>
                          <input
                            type="checkbox"
                            className="tag-checkbox"
                            data-video-id={video.id}
                            data-tag-name={tag.name}
                            aria-label={`${video.title} の ${tag.name}`}
                            checked={isChecked(tag.name, video.id)}
                            onChange={() => toggle(tag.name, video.id)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            id="applyBulkTagsBtn"
            className="btn btn-success bulk-tag-apply-btn"
            disabled={applyMutation.isPending || videos.length === 0 || tags.length === 0}
            onClick={apply}
          >
            反映
          </button>
          <button
            type="button"
            id="cancelBulkTagApplyBtn"
            className="btn btn-secondary"
            onClick={() => ui.setBulkTagOpen(false)}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
