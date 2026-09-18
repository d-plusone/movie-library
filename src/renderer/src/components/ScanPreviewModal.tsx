import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../api/ipc";
import { scanDirectoriesFlow } from "../api/operations";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

export function ScanPreviewModal() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const previewQuery = useQuery({
    queryKey: ["scan-preview"],
    queryFn: () => ipc().previewScan(),
    enabled: ui.scanPreviewOpen,
    staleTime: 0,
    retry: false,
    refetchOnMount: true,
  });

  useFocusTrap(modalRef, ui.scanPreviewOpen);

  if (!ui.scanPreviewOpen) return null;

  const preview = previewQuery.data;
  const close = (): void => {
    if (ui.scanLocked) return;
    ui.setScanPreviewOpen(false);
  };
  const runScan = (): void => {
    if (!preview || previewQuery.isFetching || ui.scanLocked) return;
    if (
      preview.totalDeleted > 0 &&
      !window.confirm(
        `削除候補が${preview.totalDeleted}件あります。\nこの内容でスキャンを実行しますか？`,
      )
    ) {
      return;
    }
    ui.setScanPreviewOpen(false);
    void ui.runScanExclusive(() => scanDirectoriesFlow({ qc, notify }));
  };

  return (
    <div className="modal scan-preview-modal" role="dialog" aria-modal="true" aria-labelledby="scanPreviewTitle">
      <div ref={modalRef} className="modal-content">
        <div className="modal-header">
          <h2 id="scanPreviewTitle">スキャンの差分プレビュー</h2>
          <button type="button" className="btn btn-icon" aria-label="閉じる" onClick={close}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {previewQuery.isFetching && <p className="scan-preview-loading">現在のファイル状態を確認しています...</p>}
          {previewQuery.isError && (
            <div className="scan-preview-error">
              差分の確認に失敗しました。DBやファイルは変更されていません。
              <div className="setting-description">{previewQuery.error instanceof Error ? previewQuery.error.message : String(previewQuery.error)}</div>
            </div>
          )}
          {preview && !previewQuery.isFetching && (
            <>
              <p className="scan-preview-description">
                {preview.scannedDirectories}個の接続済みフォルダを確認しました。実行前の試算であり、この時点ではDBを変更していません。
              </p>
              <div className="scan-preview-summary">
                <div className="scan-preview-count new"><strong>{preview.totalNew}</strong><span>新規</span></div>
                <div className="scan-preview-count updated"><strong>{preview.totalUpdated}</strong><span>更新</span></div>
                <div className="scan-preview-count deleted"><strong>{preview.totalDeleted}</strong><span>削除</span></div>
                {preview.totalReprocessed > 0 && (
                  <div className="scan-preview-count reprocessed"><strong>{preview.totalReprocessed}</strong><span>再処理</span></div>
                )}
              </div>
              {preview.totalErrors > 0 && (
                <div className="scan-preview-warning">
                  {preview.totalErrors}件のアクセスエラーがあります。該当箇所は差分判定から除外されています。
                  <ul>
                    {preview.errors.slice(0, 3).map((error) => <li key={`${error.filePath}-${error.error}`}>{error.filePath}: {error.error}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void previewQuery.refetch()} disabled={previewQuery.isFetching || ui.scanLocked}>
            再確認
          </button>
          <button type="button" className="btn btn-secondary" onClick={close} disabled={ui.scanLocked}>
            キャンセル
          </button>
          <button type="button" className="btn btn-primary" onClick={runScan} disabled={!preview || previewQuery.isFetching || ui.scanLocked}>
            この内容でスキャン
          </button>
        </div>
      </div>
    </div>
  );
}
