/**
 * タグ名変更ダイアログ
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { useFilters } from "../state/FilterContext";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

export function TagEditDialog() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();
  const filtersState = useFilters();

  const [value, setValue] = useState("");
  const oldName = ui.tagEditName;

  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, oldName !== null);

  useEffect(() => {
    if (oldName !== null) setValue(oldName);
  }, [oldName]);

  const renameMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => ipc().updateTag(from, to),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tags }),
        qc.invalidateQueries({ queryKey: queryKeys.videos }),
      ]);
      // 選択中フィルタも新しい名前に追従
      if (filtersState.filters.tags.includes(variables.from)) {
        filtersState.toggleTag(variables.from);
        filtersState.toggleTag(variables.to);
      }
      notify("タグを更新しました", "success");
      ui.closeTagEdit();
    },
    onError: (e) => notify(`タグの更新に失敗しました (${e.message})`, "error"),
  });

  if (oldName === null) return null;

  const submit = (): void => {
    const newName = value.trim();
    if (!newName || newName === oldName) {
      ui.closeTagEdit();
      return;
    }
    void renameMutation.mutateAsync({ from: oldName, to: newName });
  };

  return (
    <div ref={modalRef} id="tagEditDialog" className="modal" role="dialog" aria-modal="true" aria-labelledby="tagEditDialogTitle">
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="tagEditDialogTitle">タグを編集</h2>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="タグ編集ダイアログを閉じる"
            onClick={() => ui.closeTagEdit()}
          >
            <span className="icon">✕</span>
          </button>
        </div>
        <div className="modal-body">
          <div className="input-group">
            <label htmlFor="tagNameInput">タグ名</label>
            <input
              type="text"
              id="tagNameInput"
              className="modal-input"
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") ui.closeTagEdit();
              }}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => ui.closeTagEdit()}>
            キャンセル
          </button>
          <button
            type="button"
            id="saveTagEditBtn"
            className="btn btn-primary"
            disabled={renameMutation.isPending}
            onClick={submit}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
