/**
 * 内蔵再生チェックモーダル。
 * 再生できない動画を検出し、無劣化で MP4 へストリームコピーできるものだけを
 * 元ファイルを残したまま変換する。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ipc, queryKeys } from "../api/ipc";
import { formatFileSize } from "../lib/format";
import { useFocusTrap } from "../lib/hooks";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";
import type { ContainerMismatchItem, OperationProgress } from "../../../types/types";

type Phase = "idle" | "checking" | "list" | "converting" | "done";

interface ConvertLogEntry {
  path: string;
  ok: boolean;
  outputPath?: string;
  conversionMode?: "remux" | "transcode";
  error?: string;
}

export function ContainerCheckModal() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<OperationProgress>({ current: 0, total: 0, message: "" });
  const [items, setItems] = useState<ContainerMismatchItem[]>([]);
  /** 変換実行対象として選択された videoId（デフォルト: 変換可能なもの全て） */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [log, setLog] = useState<ConvertLogEntry[]>([]);
  const [summary, setSummary] = useState<{ succeeded: number; failed: number } | null>(
    null,
  );

  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, open);

  // UiContext へモーダル開閉状態を反映する（グローバルなキーボードナビゲーション抑制用）
  useEffect(() => {
    ui.setContainerCheckOpen(open);
  }, [open, ui]);

  // 進捗リスナーはモーダル生存中のみ張る
  useEffect(() => {
    if (!open) return;
    const api = window.electronAPI;

    const onCheck = (data: OperationProgress): void => {
      setProgress(data);
    };
    const onConvert = (data: OperationProgress): void => {
      setProgress(data);
    };

    api.onContainerCheckProgress(onCheck);
    api.onContainerConvertProgress(onConvert);
    return () => {
      api.offContainerCheckProgress(onCheck);
      api.offContainerConvertProgress(onConvert);
    };
  }, [open]);

  const startCheck = async (): Promise<void> => {
    setPhase("checking");
    setItems([]);
    setSelectedIds(new Set());
    setLog([]);
    setSummary(null);
    try {
      const result = await ipc().checkContainerMismatches();
      setItems(result);
      setSelectedIds(
        new Set(result.filter((item) => item.convertible).map((item) => item.videoId)),
      );
      setPhase("list");
      if (result.length === 0) {
        notify("拡張子と合わない・再生できない動画は見つかりませんでした", "success");
        setOpen(false);
      }
    } catch (e) {
      console.error("Failed to check containers:", e);
      notify(
        `拡張子チェックに失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
      setPhase("idle");
      setOpen(false);
    }
  };

  const toggleSelection = (videoId: number): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
  };

  const convertibleItems = useMemo(
    () => items.filter((item) => item.convertible),
    [items],
  );

  const runConversion = async (): Promise<void> => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const confirmed = window.confirm(
      `選択した${ids.length}件を別 MP4 に変換しますか？\n\n` +
        "※ 元ファイルは削除も上書きもせず、一覧からだけ除外します。\n" +
        "※ 対応ストリームは無劣化リマックスし、それ以外は H.264/320kbps MP3 の高品質変換を行います。\n" +
        "※ 変換後は映像品質・解像度・映像/音声トラック数・同期を検証します。",
    );
    if (!confirmed) return;

    if (ui.scanLocked) {
      notify("他のスキャン処理が実行中です。完了までお待ちください", "warning");
      return;
    }

    setPhase("converting");
    try {
      await ui.runScanExclusive(async () => {
        const result = await ipc().convertVideosToMp4(ids);
        setLog(result.items);
        setSummary({ succeeded: result.succeeded, failed: result.failed });
        await qc.invalidateQueries({ queryKey: queryKeys.videos });
        notify(
          `変換が完了しました (成功: ${result.succeeded}件 / 失敗: ${result.failed}件)`,
          result.failed > 0 ? "warning" : "success",
        );
      });
      setPhase("done");
    } catch (e) {
      console.error("Failed to convert videos:", e);
      notify(
        `変換に失敗しました (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
      setPhase("list");
    }
  };

  const close = (): void => {
    if (phase === "checking" || phase === "converting") return; // 処理中は閉じない
    setOpen(false);
    setPhase("idle");
  };

  return (
    <>
      <button
        type="button"
        id="extensionCheckBtn"
        className="btn btn-secondary"
        onClick={() => {
          setOpen(true);
          void startCheck();
        }}
      >
        <span className="icon">🧐</span>
        <span>内蔵再生チェック</span>
      </button>

      {!open && phase !== "checking" && phase !== "converting" ? null : (
        <div ref={modalRef} className="modal container-check-modal" role="dialog" aria-modal="true">
          <div className="modal-content">
            <div className="modal-header">
              <h2>内蔵再生チェック</h2>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="内蔵再生チェックを閉じる"
                disabled={phase === "checking" || phase === "converting"}
                onClick={close}
              >
                <span className="icon">✕</span>
              </button>
            </div>

            <div className="modal-body">
              {(phase === "checking" || phase === "converting") && (
                <div className="container-check-progress">
                  <div className="spinner" />
                  <p>
                    {phase === "checking" ? "内蔵再生可否を確認中..." : "MP4 へ変換中..."}
                    {" "}
                    ({progress.current}/{progress.total})
                    {phase === "converting" && progress.detailTotal
                      ? ` ${Math.round(((progress.detailCurrent ?? 0) / progress.detailTotal) * 100)}%`
                      : ""}
                  </p>
                  <p className="setting-description">{progress.message}</p>
                </div>
              )}

              {(phase === "list" || phase === "converting") && items.length > 0 && (
                <>
                  <p className="setting-description">
                    内蔵プレーヤーで直接再生できない、または拡張子と中身が一致しない動画です。
                    選択できるものを別 MP4 に変換します。対応ストリームは無劣化リマックスし、それ以外は H.264/320kbps MP3 の高品質変換を行います。元ファイルは残し、一覧からのみ除外します。
                  </p>
                  <div className="container-check-controls">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() =>
                        setSelectedIds(new Set(convertibleItems.map((item) => item.videoId)))
                      }
                    >
                      全て選択
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setSelectedIds(new Set())}
                    >
                      全て解除
                    </button>
                    <span className="container-check-count">
                      {selectedIds.size} / {convertibleItems.length} 件選択
                    </span>
                  </div>
                  <div className="container-check-list">
                    {items.map((item) => (
                      <label key={item.videoId} className="container-check-row">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.videoId)}
                          disabled={!item.convertible}
                          onChange={() => toggleSelection(item.videoId)}
                        />
                        <span className="container-check-name" title={item.path}>
                          {item.filename}
                        </span>
                        <span className="container-check-badges">
                          {!item.nativePlayable && (
                            <span className="container-badge badge-error">内蔵再生不可</span>
                          )}
                          {item.extensionMismatch && (
                            <span className="container-badge badge-warning">拡張子不一致</span>
                          )}
                          {item.convertible && item.conversionMode === "remux" && (
                            <span className="container-badge badge-ok">無劣化</span>
                          )}
                          {item.convertible && item.conversionMode === "transcode" && (
                            <span className="container-badge badge-warning">高品質変換</span>
                          )}
                        </span>
                        <span className="container-check-meta">
                          拡張子 {item.extension} / 実際: {item.detectedLabel} /{" "}
                          {formatFileSize(item.size)}
                        </span>
                        {!item.convertible && (
                          <span className="container-badge badge-muted">
                            {item.conversionReason ?? "MP4 変換の対象外"}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </>
              )}

              {phase === "done" && summary !== null && (
                <div>
                  <p>
                    変換完了: 成功 {summary.succeeded} 件 / 失敗 {summary.failed} 件
                  </p>
                  <ul className="container-convert-log">
                    {log.map((entry) => (
                      <li key={`${entry.path}-${entry.ok ? "ok" : "ng"}`}>
                        <span className={`container-badge ${entry.ok ? "badge-ok" : "badge-error"}`}>
                          {entry.ok ? "成功" : "失敗"}
                        </span>{" "}
                        {entry.path}
                        {entry.outputPath !== undefined && (
                          <span> → {entry.outputPath}</span>
                        )}
                        {entry.conversionMode !== undefined && (
                          <span> ({entry.conversionMode === "remux" ? "無劣化" : "高品質変換"})</span>
                        )}
                        {entry.error !== undefined && (
                          <span className="container-convert-error"> — {entry.error}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="modal-actions">
              {phase === "list" && (
                <button
                  type="button"
                  id="runContainerConvertBtn"
                  className="btn btn-success"
                  disabled={selectedIds.size === 0}
                  onClick={() => void runConversion()}
                >
                  選択した{selectedIds.size}件を MP4 に変換
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={phase === "checking" || phase === "converting"}
                onClick={close}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
