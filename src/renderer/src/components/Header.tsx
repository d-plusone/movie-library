/**
 * アプリヘッダー: サイドバートグル・操作ボタン・検索・テーマ・設定
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  addDirectoriesFlow,
  generateThumbnailsOp,
} from "../api/operations";
import { useFilters } from "../state/FilterContext";
import { useNotify } from "../state/NotificationContext";
import { useTheme } from "../state/ThemeContext";
import { useUi } from "../state/UiContext";
import { ContainerCheckModal } from "./ContainerCheckModal";

export function Header() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const { search, setSearch } = useFilters();
  const { theme, toggleTheme } = useTheme();
  const ui = useUi();

  const deps = { qc, notify };

  const onAddDirectory = (): void => {
    void ui.runScanExclusive(async () => {
      await addDirectoriesFlow(deps);
    });
  };

  const onScan = (): void => {
    if (ui.scanLocked) {
      notify("他のスキャン処理が実行中です。完了までお待ちください", "warning");
      return;
    }
    ui.setScanPreviewOpen(true);
  };

  const onGenerateThumbnails = (): void => {
    void ui.runScanExclusive(async () => {
      await generateThumbnailsOp(deps);
    });
  };

  const toggleSidebar = (): void => {
    ui.toggleSidebarCollapsed();
  };

  return (
    <header className="app-header">
      <div className="header-main">
        <div className="header-left">
          <button
            type="button"
            id="sidebarToggleBtn"
            className={`btn btn-icon sidebar-toggle-btn${ui.sidebarCollapsed ? " collapsed" : ""}`}
            title="サイドメニュー切り替え"
            aria-label="サイドバーを切り替え"
            onClick={toggleSidebar}
          >
            <span className="icon">◀</span>
          </button>
        </div>

        <div className="header-center">
          <div className="header-actions">
            <button type="button" id="addDirectoryBtn" className="btn btn-primary" onClick={onAddDirectory}>
              <span className="icon">📁</span>
              <span>フォルダを追加</span>
            </button>
            <button
              type="button"
              id="scanDirectoriesBtn"
              className="btn btn-secondary"
              disabled={ui.scanLocked}
              onClick={onScan}
            >
              <span className="icon">🔄</span>
              <span>再スキャン</span>
            </button>
            <button
              type="button"
              id="generateThumbnailsBtn"
              className="btn btn-secondary"
              disabled={ui.scanLocked}
              onClick={onGenerateThumbnails}
            >
              <span className="icon">🖼️</span>
              <span>サムネイル再生成</span>
            </button>
            <button
              type="button"
              id="bulkTagApplyBtn"
              className="btn btn-secondary"
              onClick={() => ui.setBulkTagOpen(true)}
            >
              <span className="icon">🏷️</span>
              <span>タグ一括反映</span>
            </button>
            <button
              type="button"
              id="findDuplicatesBtn"
              className="btn btn-secondary"
              onClick={() => ui.setDuplicatesOpen(true)}
            >
              <span className="icon">🔍</span>
              <span>重複を検索</span>
            </button>
            <ContainerCheckModal />
          </div>
        </div>

        <div className="header-right">
          <div className="search-container">
            <input
              type="text"
              id="searchInput"
              className="search-input"
              placeholder="動画を検索..."
              aria-label="動画を検索"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="search-icon">🔍</span>
            {search !== "" && (
              <button
                type="button"
                className="search-clear-btn"
                id="searchClearBtn"
                title="クリア"
                aria-label="検索をクリア"
                onClick={() => setSearch("")}
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            id="themeToggleBtn"
            className="btn btn-icon"
            title="テーマ切り替え"
            aria-label="テーマを切り替え"
            onClick={toggleTheme}
          >
            <span className="icon">{theme === "dark" ? "☀️" : "🌙"}</span>
          </button>
          <button
            type="button"
            id="settingsBtn"
            className="btn btn-icon"
            aria-label="設定を開く"
            onClick={() => ui.setSettingsOpen(true)}
          >
            <span className="icon">⚙️</span>
          </button>
        </div>
      </div>
    </header>
  );
}
