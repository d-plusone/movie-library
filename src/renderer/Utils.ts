/**
 * ユーティリティ関数とヘルパークラス
 * フォーマット、通知、進捗表示などの共通機能
 */

/**
 * renderer 用のロガー
 * src/utils/logger.ts は main プロセス用（CommonJS）としてビルドされるため、
 * ESM としてビルドされるレンダラーから実行時 import すると
 * Chromium のモジュールローダーで解決できない。
 * そのためレンダラー側にも同じ実装を持つ（main 側と内容を同期すること）。
 */

export interface AppLogger {
  debug(...args: Parameters<typeof console.debug>): void;
  log(...args: Parameters<typeof console.log>): void;
  info(...args: Parameters<typeof console.info>): void;
  warn(...args: Parameters<typeof console.warn>): void;
  error(...args: Parameters<typeof console.error>): void;
}

// renderer 用のロガー生成（production ビルドではデバッグログを抑制）
function createRendererLogger(isProduction: boolean): AppLogger {
  if (isProduction) {
    return {
      debug: () => {},
      log: () => {},
      info: () => {},
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };
  }
  return {
    debug: (...args) => console.debug(...args),
    log: (...args) => console.log(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

// renderer 用のロガー（production ビルドではデバッグログを抑制）
export const logger = createRendererLogger(
  window.electronAPI?.isProduction ?? false,
);

// 通知管理クラス
export class NotificationManager {
  private maxToasts: number;
  private recentMessages: Set<string>;

  constructor() {
    this.maxToasts = 3;
    this.recentMessages = new Set();
  }

  show(message: string, type: string = "info"): void {
    const container = document.getElementById("notificationContainer");
    if (!container) {
      console.error("NotificationManager - notification container not found");
      return;
    }

    // 重複通知の防止（1秒以内の同じメッセージは無視）
    const messageKey = `${message}-${type}`;
    if (this.recentMessages.has(messageKey)) {
      return;
    }

    this.recentMessages.add(messageKey);
    setTimeout(() => {
      this.recentMessages.delete(messageKey);
    }, 1000);

    // 通知の制限: 最大3個まで表示
    const existingNotifications = container.querySelectorAll(".notification");
    if (existingNotifications.length >= this.maxToasts) {
      // 最も古い通知を削除
      existingNotifications[0].remove();
    }

    const notification = document.createElement("div");
    notification.className = `notification ${type}`;

    // Create message element
    const messageElement = document.createElement("div");
    messageElement.className = "notification-message";
    messageElement.textContent = message;

    // Create close button
    const closeButton = document.createElement("button");
    closeButton.className = "notification-close";
    closeButton.textContent = "×";
    closeButton.title = "閉じる";
    closeButton.setAttribute("aria-label", "通知を閉じる");
    closeButton.addEventListener("click", () => {
      notification.remove();
    });

    notification.appendChild(messageElement);
    notification.appendChild(closeButton);
    container.appendChild(notification);

    // Auto-remove after 5 seconds
    const autoRemoveTimeout = setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 5000);

    // Clear timeout if manually closed
    closeButton.addEventListener("click", () => {
      clearTimeout(autoRemoveTimeout);
    });
  }

  success(message: string): void {
    this.show(message, "success");
  }

  error(message: string): void {
    this.show(message, "error");
  }

  warning(message: string): void {
    this.show(message, "warning");
  }

  info(message: string): void {
    this.show(message, "info");
  }
}

// 統一進捗モーダル管理クラス
export class UnifiedProgressManager {
  private static instance: UnifiedProgressManager | null = null;
  private progressContainer: HTMLElement | null = null;
  private progressList: HTMLElement | null = null;
  private activeProgresses: Map<string, ProgressItem> = new Map();
  private ownerProgresses: Set<string> = new Set(); // オーナープログレスを管理
  private isVisible: boolean = false;

  static getInstance(): UnifiedProgressManager {
    if (!UnifiedProgressManager.instance) {
      UnifiedProgressManager.instance = new UnifiedProgressManager();
    }
    return UnifiedProgressManager.instance;
  }

  constructor() {
    this.createProgressModal();

    // ウィンドウリサイズ時のサイズ調整
    window.addEventListener("resize", () => {
      if (this.isVisible && this.progressContainer) {
        this.adjustModalSize();
      }
    });
  }

  private createProgressModal(): void {
    // 既存のモーダルがあれば削除（新旧問わず）
    const existingUnified = document.getElementById("unifiedProgressModal");
    if (existingUnified) {
      existingUnified.remove();
    }

    // 古い形式のプログレスモーダルも削除
    const existingLegacy = document.getElementById("progressContainer");
    if (existingLegacy) {
      existingLegacy.remove();
    }

    // 他の古いプログレスモーダルも削除
    const oldModals = document.querySelectorAll(".progress-modal");
    oldModals.forEach((modal) => modal.remove());

    // 統一進捗モーダルを作成（ヘッダー・ドラッグ機能なし）
    this.progressContainer = document.createElement("div");
    this.progressContainer.id = "unifiedProgressModal";
    this.progressContainer.className = "unified-progress-modal hidden";

    // 初期位置を明示的に設定
    this.progressContainer.style.position = "fixed";
    this.progressContainer.style.left = "50%";
    this.progressContainer.style.transform = "translateX(-50%)";
    this.progressContainer.style.bottom = "20px";
    this.progressContainer.style.display = "none";
    this.progressContainer.style.visibility = "hidden";

    // 進捗リスト
    this.progressList = document.createElement("div");
    this.progressList.className = "progress-list";

    this.progressContainer.appendChild(this.progressList);

    // ボディに追加
    document.body.appendChild(this.progressContainer);
  }

  // 新しい進捗を追加
  addProgress(id: string, message: string, total: number = 100): void {
    this._addProgress(id, message, total, false);
  }

  // オーナー進捗を追加（この進捗が残っている間はモーダルを閉じない）
  addOwnerProgress(id: string, message: string, total: number = 100): void {
    this._addProgress(id, message, total, true);
  }

  // 内部的な進捗追加メソッド
  private _addProgress(
    id: string,
    message: string,
    total: number,
    isOwner: boolean,
  ): void {
    if (this.activeProgresses.has(id)) {
      return; // 既に存在する場合は何もしない
    }

    const progressItem = new ProgressItem(id, message, total);
    this.activeProgresses.set(id, progressItem);

    if (isOwner) {
      this.ownerProgresses.add(id);
    }

    // DOM要素を作成してリストに追加
    const progressElement = this.createProgressElement(progressItem);
    if (this.progressList) {
      this.progressList.appendChild(progressElement);
    }

    // モーダルを表示
    this.show();

    // サイズを調整
    this.adjustModalSize();
  }

  // 進捗を更新
  updateProgress(id: string, current: number, message?: string): void {
    const progressItem = this.activeProgresses.get(id);
    if (!progressItem) return;

    progressItem.update(current, message);
    this.updateProgressElement(id, progressItem);
  }

  // 指定IDのプログレスが存在するかチェック
  hasProgress(id: string): boolean {
    return this.activeProgresses.has(id);
  }

  // 進捗の総数を更新
  updateProgressTotal(id: string, total: number): void {
    const progressItem = this.activeProgresses.get(id);
    if (!progressItem) return;

    progressItem.updateTotal(total);
    this.updateProgressElement(id, progressItem);
  }

  // 進捗を完了
  completeProgress(id: string): void {
    const progressItem = this.activeProgresses.get(id);
    if (!progressItem) return;

    progressItem.complete();

    // 1秒後に進捗を削除
    // その間に同じIDで新しいプログレスが登録された場合は削除しない
    setTimeout(() => {
      // 現在登録されているオブジェクトが完了時と同じ場合のみ削除する
      if (this.activeProgresses.get(id) === progressItem) {
        this.removeProgress(id);
      }
    }, 1000);
  }

  // 進捗を削除
  removeProgress(id: string): void {
    const progressItem = this.activeProgresses.get(id);
    if (!progressItem) return;

    // DOM要素を削除
    const element = document.getElementById(`progress-item-${id}`);
    if (element) {
      element.remove();
    }

    // マップから削除
    this.activeProgresses.delete(id);
    this.ownerProgresses.delete(id); // オーナーセットからも削除

    // サイズを調整
    if (this.activeProgresses.size > 0) {
      this.adjustModalSize();
    }

    // オーナープログレスが残っている場合は閉じない
    // 全ての進捗が完了し、かつオーナープログレスがない場合のみモーダルを隠す
    if (this.activeProgresses.size === 0 && this.ownerProgresses.size === 0) {
      this.hide();
    }
  }

  // 進捗要素を作成
  private createProgressElement(progressItem: ProgressItem): HTMLElement {
    const element = document.createElement("div");
    element.id = `progress-item-${progressItem.id}`;
    element.className = "progress-item";

    const messageElement = document.createElement("div");
    messageElement.className = "progress-message";
    messageElement.textContent = progressItem.message;

    const progressBarWrapper = document.createElement("div");
    progressBarWrapper.className = "progress-bar-wrapper";

    const progressBar = document.createElement("div");
    progressBar.className = "progress-bar";
    progressBar.style.width = "0%";

    const progressPercentage = document.createElement("div");
    progressPercentage.className = "progress-percentage";
    progressPercentage.textContent = "0%";

    progressBarWrapper.appendChild(progressBar);
    progressBarWrapper.appendChild(progressPercentage);

    element.appendChild(messageElement);
    element.appendChild(progressBarWrapper);

    return element;
  }

  // 進捗要素を更新
  private updateProgressElement(id: string, progressItem: ProgressItem): void {
    const element = document.getElementById(`progress-item-${id}`);
    if (!element) return;

    const messageElement = element.querySelector(".progress-message");
    const progressBar = element.querySelector(".progress-bar") as HTMLElement;
    const progressPercentage = element.querySelector(".progress-percentage");

    if (messageElement) {
      messageElement.textContent = progressItem.getDisplayMessage();
    }

    if (progressBar) {
      progressBar.style.width = `${progressItem.getPercentage()}%`;
    }

    if (progressPercentage) {
      progressPercentage.textContent = `${Math.round(
        progressItem.getPercentage(),
      )}%`;
    }

    // 完了時のスタイル
    if (progressItem.isCompleted()) {
      element.classList.add("completed");
    }
  }

  // モーダルを表示
  show(): void {
    if (this.progressContainer && !this.isVisible) {
      // 初期位置を確実に設定
      this.progressContainer.style.left = "50%";
      this.progressContainer.style.transform = "translateX(-50%)";
      this.progressContainer.style.bottom = "20px";

      this.progressContainer.classList.remove("hidden");
      this.progressContainer.classList.remove("minimized");
      this.progressContainer.style.display = "flex";
      this.progressContainer.style.visibility = "visible";
      this.isVisible = true;

      // レイアウトを強制的に再計算させる
      this.progressContainer.offsetHeight;

      // モーダルサイズを調整
      this.adjustModalSize();
    }
  }

  // モーダルサイズを調整
  private adjustModalSize(): void {
    if (!this.progressContainer || !this.progressList) return;

    // 一時的に高さ制限を解除してコンテンツの自然な高さを測定
    this.progressContainer.style.maxHeight = "none";
    this.progressList.style.maxHeight = "none";

    // 少し遅延させてレイアウトが確定してから調整
    setTimeout(() => {
      if (!this.progressContainer || !this.progressList) return;

      const windowHeight = window.innerHeight;
      const maxModalHeight = windowHeight * 0.8; // 画面高さの80%まで
      const containerRect = this.progressContainer.getBoundingClientRect();

      if (containerRect.height > maxModalHeight) {
        this.progressContainer.style.maxHeight = `${maxModalHeight}px`;
        // パディングのみ考慮
        const padding = 32; // 上下のパディング
        this.progressList.style.maxHeight = `${maxModalHeight - padding}px`;
      } else {
        this.progressContainer.style.maxHeight = "80vh";
        this.progressList.style.maxHeight = "none";
      }
    }, 10);
  }

  // モーダルを隠す
  hide(): void {
    if (this.progressContainer && this.isVisible) {
      this.progressContainer.classList.add("hidden");
      this.progressContainer.style.display = "none";
      this.progressContainer.style.visibility = "hidden";
      this.isVisible = false;
    }
  }

  // ヘッダーが削除されたため、最小化・展開機能は削除されました

  // ドラッグ機能は削除されました（モーダルサイズ調整の問題を解決するため）
}

// 個別の進捗アイテムクラス
class ProgressItem {
  public id: string;
  public message: string;
  private total: number;
  private current: number;
  private completed: boolean;

  constructor(id: string, message: string, total: number = 100) {
    this.id = id;
    this.message = message;
    this.total = total;
    this.current = 0;
    this.completed = false;
  }

  update(current: number, message?: string): void {
    this.current = Math.min(current, this.total);
    if (message) {
      this.message = message;
    }
  }

  // 総数を更新（動的に総数が変わる場合に使用）
  updateTotal(total: number): void {
    this.total = total;
    this.current = Math.min(this.current, this.total);
  }

  complete(): void {
    this.current = this.total;
    this.completed = true;
  }

  getPercentage(): number {
    return this.total > 0 ? (this.current / this.total) * 100 : 0;
  }

  getDisplayMessage(): string {
    if (this.completed) {
      return `${this.message} - 完了`;
    }
    return `${this.message} (${this.current}/${this.total} - ${Math.round(
      this.getPercentage(),
    )}%)`;
  }

  isCompleted(): boolean {
    return this.completed;
  }
}

// 元の進捗バー管理クラス（後方互換性のため、統一モーダルを使用）
export class ProgressBarManager {
  private progressId: string;
  private unifiedManager: UnifiedProgressManager;
  // 将来的に使用する可能性があるためコメントアウト
  // private currentCount: number = 0;
  // private totalCount: number = 0;
  private baseMessage: string = "";

  constructor() {
    this.progressId = `legacy-progress-${Date.now()}`;
    this.unifiedManager = UnifiedProgressManager.getInstance();
  }

  show(text: string = "処理中..."): void {
    // 0/0の場合は表示しない
    if (text.includes("(0/0")) {
      return;
    }

    this.baseMessage = text;
    this.unifiedManager.addProgress(this.progressId, text, 100);
  }

  hide(): void {
    this.unifiedManager.removeProgress(this.progressId);
    // this.currentCount = 0;
    // this.totalCount = 0;
    this.baseMessage = "";
  }

  // 最小化・展開機能は削除されました（ヘッダーがないため）

  updateProgress(percentage: number, text?: string): void {
    if (text) {
      this.baseMessage = text;
    }
    this.unifiedManager.updateProgress(
      this.progressId,
      percentage,
      this.baseMessage,
    );
  }

  // app.jsで使用されているshowProgressメソッドを追加（後方互換性のため）
  showProgress(text: string, percentage: number = 0): void {
    this.show(text);
    this.updateProgress(percentage, text);
  }
}

// フォーマット関数（後方互換性のため）
export class FormatUtils {
  static formatDuration(seconds: number): string {
    if (!seconds) return "00:00:00";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  static formatFileSize(bytes: number | bigint): string {
    // bigintの場合はnumberに変換（JavaScriptの安全な整数範囲内で処理）
    const numBytes = typeof bytes === "bigint" ? Number(bytes) : bytes;

    if (numBytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(numBytes) / Math.log(k));

    return parseFloat((numBytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  static getFileExtension(filename: string): string {
    const extension = filename.split(".").pop();
    return extension ? extension.toUpperCase() : "";
  }

  static formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString("ja-JP");
  }

  // タイムスタンプをフォーマット
  static formatTimestamp(seconds: number): string {
    return this.formatDuration(seconds);
  }

  // HTMLエスケープ
  static escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ファイルパスを file:// URL に変換（Windows パスに対応）
  // macOS/Linux: /Users/... → file:///Users/...
  // Windows:     C:\... → file:///C:/...
  static pathToFileUrl(filePath: string): string {
    if (!filePath) return "";
    // Windows の絶対パス (C:\... または C:/...)
    if (/^[a-zA-Z]:/.test(filePath)) {
      return "file:///" + filePath.replace(/\\/g, "/");
    }
    // Unix/macOS の絶対パス
    return "file://" + filePath;
  }

  // 解像度ラベルを返す（大きい方の辺を基準に判定。レターボックス動画でも誤判定しにくい）
  // width/height が未知の場合は null を返す
  static getResolutionLabel(width: number, height: number): string | null {
    if (width <= 0 && height <= 0) return null;
    const maxDimension = Math.max(width, height);
    if (maxDimension >= 3840) return "4K";
    if (maxDimension >= 2560) return "1440p";
    if (maxDimension >= 1920) return "1080p";
    if (maxDimension >= 1280) return "720p";
    return "SD";
  }
}

// プログレス管理（後方互換性のため、統一モーダルを使用）
export class ProgressManager {
  private progressId: string;
  private unifiedManager: UnifiedProgressManager;
  private currentCount: number = 0;
  private totalCount: number = 0;
  private baseMessage: string = "";

  constructor() {
    this.progressId = `legacy-manager-${Date.now()}`;
    this.unifiedManager = UnifiedProgressManager.getInstance();
  }

  // 処理開始時に総数を設定
  startProgress(total: number, message: string): void {
    this.currentCount = 0;
    this.totalCount = total;
    this.baseMessage = message;

    // 0/0の場合は表示しない
    if (this.totalCount > 0) {
      this.unifiedManager.addProgress(this.progressId, message, total);
    }
  }

  // 処理が1つ完了するたびに呼び出し
  processItem(currentItem?: string): void {
    this.currentCount++;
    this.updateDisplay(currentItem);
  }

  // 処理完了時
  completeProgress(): void {
    this.currentCount = this.totalCount;
    this.updateDisplay();
    this.unifiedManager.completeProgress(this.progressId);
  }

  // 表示を更新
  private updateDisplay(currentItem?: string): void {
    // 0/0の場合は表示しない
    if (this.totalCount === 0) {
      return;
    }

    let displayText = `${this.baseMessage}`;

    if (currentItem && this.currentCount < this.totalCount) {
      // ファイル名が長い場合は短縮
      const shortItem =
        currentItem.length > 40
          ? currentItem.substring(0, 37) + "..."
          : currentItem;
      displayText += ` - ${shortItem}`;
    }

    this.unifiedManager.updateProgress(
      this.progressId,
      this.currentCount,
      displayText,
    );
  }

  // 従来の互換性のためのメソッド（非推奨）
  updateProgressFromData(
    current: number,
    total: number,
    baseText: string,
    currentItem?: string,
  ): void {
    this.currentCount = current;
    this.totalCount = total;
    this.baseMessage = baseText;

    // 0/0の場合は表示しない
    if (this.totalCount > 0) {
      this.updateDisplay(currentItem);
    }
  }

  // 基本的な進捗表示メソッド
  show(text: string = "処理中..."): void {
    if (!text.includes("/") && !text.includes("%")) {
      // 基本メッセージのみを設定し、既存の進捗状態を保持
      if (this.totalCount === 0) {
        this.baseMessage = text;
        this.unifiedManager.addProgress(this.progressId, text, 100);
      } else {
        // 既に進捗が開始されている場合は、baseMessageを変更せずに表示を更新
        this.updateDisplay();
      }
    } else {
      // 0/0が含まれている場合はスキップ
      if (!text.includes("(0/0")) {
        this.baseMessage = text;
        this.unifiedManager.addProgress(this.progressId, text, 100);
      }
    }
  }

  hide(): void {
    this.unifiedManager.removeProgress(this.progressId);
    this.currentCount = 0;
    this.totalCount = 0;
    this.baseMessage = "";
  }

  updateProgress(percentage: number, text?: string): void {
    if (text) {
      this.baseMessage = text;
    }
    this.unifiedManager.updateProgress(
      this.progressId,
      percentage,
      this.baseMessage,
    );
  }

  showProgress(text: string, percentage: number = 0): void {
    this.show(text);
    this.updateProgress(percentage, text);
  }
}

// 拡張進捗管理クラス（統一進捗モーダル対応）
export class EnhancedProgressManager {
  private currentCount: number = 0;
  private totalCount: number = 0;
  private baseMessage: string = "";
  private progressId: string = "";
  private unifiedManager: UnifiedProgressManager;

  constructor(id?: string) {
    this.unifiedManager = UnifiedProgressManager.getInstance();
    this.progressId = id || `progress-${Date.now()}`;
  }

  // 処理開始時に総数を設定
  startProgress(total: number, message: string, progressId?: string): string {
    if (progressId) {
      this.progressId = progressId;
    }

    this.currentCount = 0;
    this.totalCount = total;
    this.baseMessage = message;

    // 統一モーダルに進捗を追加
    this.unifiedManager.addProgress(this.progressId, message, total);

    return this.progressId;
  }

  // 処理が1つ完了するたびに呼び出し
  processItem(currentItem?: string): void {
    this.currentCount++;
    this.updateDisplay(currentItem);
  }

  // 処理完了時
  completeProgress(): void {
    this.currentCount = this.totalCount;
    this.updateDisplay();

    // 統一モーダルで進捗を完了
    this.unifiedManager.completeProgress(this.progressId);
  }

  // 表示を更新
  private updateDisplay(currentItem?: string): void {
    // 0/0の場合は表示しない
    if (this.totalCount === 0) {
      return;
    }

    let displayText = this.baseMessage;

    if (currentItem && this.currentCount < this.totalCount) {
      // ファイル名が長い場合は短縮
      const shortItem =
        currentItem.length > 40
          ? currentItem.substring(0, 37) + "..."
          : currentItem;
      displayText += `\n${shortItem}`;
    }

    this.unifiedManager.updateProgress(
      this.progressId,
      this.currentCount,
      displayText,
    );
  }

  // 進捗を隠す
  hide(): void {
    this.unifiedManager.removeProgress(this.progressId);
    this.currentCount = 0;
    this.totalCount = 0;
    this.baseMessage = "";
  }

  // 進捗IDを取得
  getProgressId(): string {
    return this.progressId;
  }

  // 進捗の状態を取得
  getProgress(): { current: number; total: number; percentage: number } {
    const percentage =
      this.totalCount > 0 ? (this.currentCount / this.totalCount) * 100 : 0;
    return {
      current: this.currentCount,
      total: this.totalCount,
      percentage: Math.round(percentage),
    };
  }
}

// テーマ管理クラス
export class ThemeManager {
  private currentTheme: string;

  constructor() {
    this.currentTheme = "dark";
    this.initializeTheme();
  }

  initializeTheme(): void {
    logger.debug("Initializing theme...");

    // Load saved theme
    const savedTheme = localStorage.getItem("theme");
    logger.debug("Saved theme:", savedTheme);

    if (savedTheme) {
      this.currentTheme = savedTheme;
      this.applyTheme(savedTheme);
    } else {
      // Default to dark theme
      this.applyTheme("dark");
    }

    // Update theme select
    const themeSelect = document.getElementById(
      "themeSelect",
    ) as HTMLSelectElement;
    if (themeSelect) {
      themeSelect.value = this.currentTheme;
      logger.debug("Theme select set to:", this.currentTheme);
    }

    // Add system theme change listener
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addListener(() => {
        if (this.currentTheme === "system") {
          this.applySystemTheme();
        }
      });
      logger.debug("System theme listener added");
    }
  }

  applyTheme(theme: string): void {
    logger.debug("Applying theme:", theme);
    this.currentTheme = theme;

    const body = document.body;

    if (theme === "system") {
      this.applySystemTheme();
    } else {
      body.setAttribute("data-theme", theme);
      logger.debug(`Theme ${theme} applied`);
    }

    // Save theme
    localStorage.setItem("theme", theme);
    logger.debug("Theme saved to localStorage");

    // プレースホルダー色の更新
    this.updatePlaceholderColors();
  }

  private updatePlaceholderColors(): void {
    const isDark =
      this.currentTheme === "dark" ||
      (this.currentTheme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);

    const placeholderColor = isDark ? "#666" : "#999";

    // 動的にスタイルを追加
    let style = document.getElementById(
      "dynamic-placeholder-styles",
    ) as HTMLStyleElement;
    if (!style) {
      style = document.createElement("style");
      style.id = "dynamic-placeholder-styles";
      document.head.appendChild(style);
    }

    style.textContent = `
      input::placeholder, textarea::placeholder {
        color: ${placeholderColor} !important;
      }
    `;
  }

  private applySystemTheme(): void {
    const body = document.body;
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;

    if (prefersDark) {
      body.setAttribute("data-theme", "dark");
      logger.debug("System dark theme applied");
    } else {
      body.setAttribute("data-theme", "light");
      logger.debug("System light theme applied");
    }

    // プレースホルダー色の更新
    this.updatePlaceholderColors();
  }

  getCurrentTheme(): string {
    return this.currentTheme;
  }

  toggleTheme(): void {
    let newTheme: string;
    switch (this.currentTheme) {
      case "light":
        newTheme = "dark";
        break;
      case "dark":
        newTheme = "light";
        break;
      case "system":
        newTheme = "light";
        break;
      default:
        newTheme = "dark";
    }
    this.applyTheme(newTheme);
  }
}

// キーボードナビゲーション管理
export class KeyboardManager {
  private callbacks: Record<string, (e: KeyboardEvent) => void>;

  constructor(callbacks: Record<string, (e: KeyboardEvent) => void> = {}) {
    this.callbacks = callbacks;
    this.initializeKeyboardEvents();
  }

  initializeKeyboardEvents(): void {
    document.addEventListener("keydown", (e) =>
      this.handleKeyboardNavigation(e),
    );
  }

  handleKeyboardNavigation(e: KeyboardEvent): void {
    // Prevent handling if typing in input fields
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return;
    }

    switch (e.key) {
      case "Escape":
        if (this.callbacks.onEscape) this.callbacks.onEscape(e);
        break;
      case "Enter":
        if (this.callbacks.onEnter) this.callbacks.onEnter(e);
        break;
      case " ":
        if (this.callbacks.onSpace) this.callbacks.onSpace(e);
        break;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        e.preventDefault();
        if (this.callbacks.onArrow) this.callbacks.onArrow(e);
        break;
      case "f":
      case "F":
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (this.callbacks.onFocusSearch) this.callbacks.onFocusSearch(e);
        }
        break;
      case "r":
      case "R":
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (this.callbacks.onRefresh) this.callbacks.onRefresh(e);
        }
        break;
      case "s":
      case "S":
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (this.callbacks.onSettings) this.callbacks.onSettings(e);
        }
        break;
    }
  }

  updateCallbacks(
    newCallbacks: Record<string, (e: KeyboardEvent) => void>,
  ): void {
    this.callbacks = { ...this.callbacks, ...newCallbacks };
  }
}

// ファイルサイズフォーマット関数
export function formatFileSize(bytes: number | bigint): string {
  // bigintの場合はnumberに変換（JavaScriptの安全な整数範囲内で処理）
  const numBytes = typeof bytes === "bigint" ? Number(bytes) : bytes;

  if (numBytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(numBytes) / Math.log(k));

  return parseFloat((numBytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// 時間フォーマット関数
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  } else {
    return `${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
}

// 日付フォーマット関数
export function formatDate(date: Date | string | number): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "Invalid Date";

  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

// 相対時間フォーマット関数
export function formatRelativeTime(date: Date | string | number): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "今";
  if (diffMinutes < 60) return `${diffMinutes}分前`;
  if (diffHours < 24) return `${diffHours}時間前`;
  if (diffDays < 7) return `${diffDays}日前`;

  return formatDate(d);
}

// テキストハイライト関数
export function highlightText(text: string, query: string): string {
  if (!query || !text) return text;

  const regex = new RegExp(
    `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
    "gi",
  );
  return text.replace(regex, '<span class="highlight">$1</span>');
}

// パス操作関数
export const PathUtils = {
  // ファイル名を取得（拡張子あり）
  basename(path: string): string {
    return path.split("/").pop() || path.split("\\").pop() || "";
  },

  // ファイル名を取得（拡張子なし）
  basenameWithoutExt(path: string): string {
    const filename = this.basename(path);
    const lastDotIndex = filename.lastIndexOf(".");
    return lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
  },

  // 拡張子を取得
  extname(path: string): string {
    const filename = this.basename(path);
    const lastDotIndex = filename.lastIndexOf(".");
    return lastDotIndex > 0 ? filename.substring(lastDotIndex) : "";
  },

  // ディレクトリパスを取得
  dirname(path: string): string {
    const separator = path.includes("/") ? "/" : "\\";
    const parts = path.split(separator);
    return parts.slice(0, -1).join(separator) || separator;
  },
};

// DOM操作ヘルパー
export const DOMUtils = {
  // 要素をIDで取得
  getElementById(id: string): HTMLElement | null {
    const element = document.getElementById(id);
    if (!element) {
      // Only warn for critical elements, not tooltips and optional elements
      const optionalElements = [
        "videoTooltip",
        "errorDialog",
        "tagEditDialog",
        "thumbnailModal",
        "tooltip",
      ];
      if (!optionalElements.includes(id)) {
        console.warn(`DOMUtils - Element not found: #${id}`);
      }
    }
    return element;
  },

  // CSS セレクターで要素を取得
  querySelector(selector: string): Element | null {
    const element = document.querySelector(selector);
    if (!element) {
      console.warn(`DOMUtils - Element not found: ${selector}`);
    }
    return element;
  },

  // 要素作成（後方互換性のため）
  createElement(
    tag: string,
    className: string = "",
    textContent: string = "",
  ): HTMLElement {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textContent) element.textContent = textContent;
    return element;
  },

  // 要素作成（新しいAPI）
  createElementAdvanced<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    options: {
      className?: string;
      id?: string;
      textContent?: string;
      attributes?: Record<string, string>;
    } = {},
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);

    if (options.className) element.className = options.className;
    if (options.id) element.id = options.id;
    if (options.textContent) element.textContent = options.textContent;

    if (options.attributes) {
      Object.entries(options.attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
      });
    }

    return element;
  },

  // 複数のイベントリスナーを追加
  addEventListeners(
    element: HTMLElement | null,
    events: Record<string, EventListener>,
  ): void {
    if (!element) {
      console.warn("DOMUtils - Cannot add event listeners to null element");
      return;
    }
    Object.entries(events).forEach(([event, handler]) => {
      element.addEventListener(event, handler);
    });
  },

  // 要素からすべてのイベントリスナーを削除（新しい要素で置き換え）
  removeAllEventListeners(element: HTMLElement | null): HTMLElement | null {
    if (!element) return null;

    const newElement = element.cloneNode(true) as HTMLElement;
    if (element.parentNode) {
      element.parentNode.replaceChild(newElement, element);
    }
    return newElement;
  },

  // 動画数を更新
  updateVideoCount(count: number): void {
    const videoCountElement = document.getElementById("videoCount");
    if (videoCountElement) {
      videoCountElement.textContent = `${count} 動画`;
    }
  },

  // 要素の表示/非表示
  toggle(element: HTMLElement, show?: boolean): void {
    if (show !== undefined) {
      element.style.display = show ? "" : "none";
    } else {
      element.style.display = element.style.display === "none" ? "" : "none";
    }
  },

  // クラスの切り替え
  toggleClass(element: HTMLElement, className: string, force?: boolean): void {
    if (force !== undefined) {
      element.classList.toggle(className, force);
    } else {
      element.classList.toggle(className);
    }
  },
};

// アニメーション関数
export const AnimationUtils = {
  // フェードイン
  fadeIn(element: HTMLElement, duration: number = 300): Promise<void> {
    return new Promise((resolve) => {
      element.style.opacity = "0";
      element.style.display = "";

      const start = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - start;
        const progress = Math.min(elapsed / duration, 1);

        element.style.opacity = progress.toString();

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(animate);
    });
  },

  // フェードアウト
  fadeOut(element: HTMLElement, duration: number = 300): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const startOpacity = parseFloat(getComputedStyle(element).opacity) || 1;

      const animate = (currentTime: number) => {
        const elapsed = currentTime - start;
        const progress = Math.min(elapsed / duration, 1);

        element.style.opacity = (startOpacity * (1 - progress)).toString();

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          element.style.display = "none";
          resolve();
        }
      };

      requestAnimationFrame(animate);
    });
  },
};

// 画像ローディング管理
export class ImageLoader {
  private loadingImages: Set<string>;
  private callbacks: Record<string, (() => void)[]>;

  constructor() {
    this.loadingImages = new Set();
    this.callbacks = {};
  }

  async loadImage(src: string): Promise<void> {
    if (this.loadingImages.has(src)) {
      // 既に読み込み中の場合は完了を待つ
      return new Promise((resolve) => {
        if (!this.callbacks[src]) {
          this.callbacks[src] = [];
        }
        this.callbacks[src].push(resolve);
      });
    }

    this.loadingImages.add(src);

    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        this.loadingImages.delete(src);

        // コールバックを実行
        if (this.callbacks[src]) {
          this.callbacks[src].forEach((callback) => callback());
          delete this.callbacks[src];
        }

        resolve();
      };

      img.onerror = () => {
        this.loadingImages.delete(src);

        // エラーでもコールバックを実行（エラーハンドリングは呼び出し側で）
        if (this.callbacks[src]) {
          this.callbacks[src].forEach((callback) => callback());
          delete this.callbacks[src];
        }

        reject(new Error(`Failed to load image: ${src}`));
      };

      img.src = src;
    });
  }

  isLoading(src: string): boolean {
    return this.loadingImages.has(src);
  }

  updateCallbacks(newCallbacks: Record<string, (() => void)[]>): void {
    this.callbacks = { ...this.callbacks, ...newCallbacks };
  }
}

// 汎用ユーティリティ関数
export const Utils = {
  // 配列をシャッフル
  shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  },

  // デバウンス関数
  debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
    func: T,
    wait: number,
  ): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout;
    return function executedFunction(...args: Parameters<T>) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // スロットル関数
  throttle<T extends (...args: Parameters<T>) => ReturnType<T>>(
    func: T,
    limit: number,
  ): (...args: Parameters<T>) => void {
    let inThrottle: boolean;
    return function (this: unknown, ...args: Parameters<T>) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  },

  // 遅延実行
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

// =========================================
// モーダルのフォーカストラップ（アクセシビリティ）
// =========================================

// フォーカストラップ対象のモーダルセレクタ
// （.chapter-dialog-overlay / .dialog-overlay は動的に body へ追加/削除される）
const MODAL_SELECTOR =
  ".modal, #thumbnailModal, .chapter-dialog-overlay, .dialog-overlay";

// モーダル内のフォーカス可能な要素を取得
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(", ");
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getAttribute("aria-hidden") !== "true",
  );
}

// 現在表示中のモーダルを取得（複数ある場合は最後に開いたものを優先）
function getOpenModal(): HTMLElement | null {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>(MODAL_SELECTOR),
  );
  for (let i = modals.length - 1; i >= 0; i--) {
    // 動的生成ダイアログは remove されると isConnected が false になる
    if (!modals[i].isConnected) continue;
    if (modals[i].style.display === "none") continue;
    return modals[i];
  }
  return null;
}

// モーダル表示中のフォーカストラップと初期フォーカスの設定を有効化
export function setupModalFocusTrap(): void {
  // 1) Tab キーによるフォーカスの循環トラップ
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const modal = getOpenModal();
    if (!modal) return;

    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      // Shift+Tab: 先頭要素より前に行こうとしたら最後の要素へ
      if (active === first || !modal.contains(active)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else {
      // Tab: 最後の要素より先に行こうとしたら先頭要素へ
      if (active === last || !modal.contains(active)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  });

  // 2) モーダルが開かれたら最初のフォーカス可能要素へフォーカスを移動
  const observer = new MutationObserver(() => {
    const modal = getOpenModal();
    if (!modal) return;

    const active = document.activeElement as HTMLElement | null;
    if (active && modal.contains(active)) return;

    const focusable = getFocusableElements(modal);
    if (focusable.length > 0) {
      focusable[0].focus({ preventScroll: true });
    }
  });

  document.querySelectorAll<HTMLElement>(MODAL_SELECTOR).forEach((modal) => {
    observer.observe(modal, {
      attributes: true,
      attributeFilter: ["style"],
    });
  });
}
