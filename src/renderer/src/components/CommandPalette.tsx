import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addDirectoriesFlow,
  generateThumbnailsOp,
  regenerateAllThumbnailsOp,
} from "../api/operations";
import { useNotify } from "../state/NotificationContext";
import { useUi } from "../state/UiContext";

interface Command {
  id: string;
  label: string;
  description: string;
  keywords: string;
  run: () => Promise<void> | void;
}

export function CommandPalette() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const ui = useUi();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const commands = useMemo<Command[]>(() => [
    {
      id: "search",
      label: "動画を検索",
      description: "パレットを閉じて上部の検索欄へ移動",
      keywords: "search 検索",
      run: () => {
        ui.setCommandPaletteOpen(false);
        document.querySelector<HTMLInputElement>(".search-input")?.focus();
      },
    },
    {
      id: "add-directory",
      label: "フォルダを追加・スキャン",
      description: "フォルダ選択、登録、スキャン、サムネイル生成",
      keywords: "folder directory scan フォルダ スキャン",
      run: () => ui.runScanExclusive(() => addDirectoriesFlow({ qc, notify })),
    },
    {
      id: "scan",
      label: "ライブラリをスキャン",
      description: "差分を確認してから登録済みフォルダをスキャン",
      keywords: "scan rescan スキャン",
      run: () => ui.setScanPreviewOpen(true),
    },
    {
      id: "regenerate-thumbnails",
      label: "サムネイルを再生成",
      description: "全動画のサムネイルを作り直す",
      keywords: "thumbnail regenerate サムネイル 再生成",
      run: () => ui.runScanExclusive(() => regenerateAllThumbnailsOp({ qc, notify })),
    },
    {
      id: "generate-thumbnails",
      label: "不足サムネイルを生成",
      description: "サムネイルがない動画だけを処理する",
      keywords: "thumbnail generate サムネイル 生成",
      run: () => ui.runScanExclusive(() => generateThumbnailsOp({ qc, notify })),
    },
    {
      id: "duplicates",
      label: "重複動画を検索",
      description: "重複検索画面を開く",
      keywords: "duplicate 重複",
      run: () => ui.setDuplicatesOpen(true),
    },
    {
      id: "settings",
      label: "設定を開く",
      description: "アプリ設定を開く",
      keywords: "settings 設定",
      run: () => ui.setSettingsOpen(true),
    },
  ], [notify, qc, ui]);

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.description} ${command.keywords}`.toLowerCase().includes(normalized),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!ui.commandPaletteOpen) return;
    setQuery("");
    setSelectedIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [ui.commandPaletteOpen]);

  useEffect(() => {
    if (!ui.commandPaletteOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        ui.setCommandPaletteOpen(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => filteredCommands.length === 0 ? 0 : (current + 1) % filteredCommands.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => filteredCommands.length === 0 ? 0 : (current - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (event.key === "Enter") {
        const command = filteredCommands[selectedIndex];
        if (!command) return;
        event.preventDefault();
        ui.setCommandPaletteOpen(false);
        void command.run();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [filteredCommands, selectedIndex, ui]);

  if (!ui.commandPaletteOpen) return null;

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={() => ui.setCommandPaletteOpen(false)}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="コマンドパレット" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          placeholder="コマンドを検索..."
          aria-label="コマンドを検索"
        />
        <div className="command-palette-list">
          {filteredCommands.map((command, index) => (
            <button
              type="button"
              key={command.id}
              className={`command-palette-item${index === selectedIndex ? " selected" : ""}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => {
                ui.setCommandPaletteOpen(false);
                void command.run();
              }}
            >
              <span className="command-palette-label">{command.label}</span>
              <span className="command-palette-description">{command.description}</span>
            </button>
          ))}
          {filteredCommands.length === 0 && <div className="command-palette-empty">該当するコマンドがありません</div>}
        </div>
        <div className="command-palette-hint">↑↓ 選択　Enter 実行　Esc 閉じる</div>
      </div>
    </div>
  );
}
