/**
 * ユーティリティ関数とヘルパークラス
 * フォーマット、通知、進捗表示などの共通機能
 */

// 通知管理クラス
export class NotificationManager {
  private maxToasts: number;

  constructor() {
    this.maxToasts = 3;
  }

  show(message: string, type: string = "info"): void {
    const container = document.getElementById("notificationContainer");
    if (!container) {
      console.error("NotificationManager - notification container not found");
      return;
    }

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
    closeButton.innerHTML = "×";
    closeButton.title = "閉じる";
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

// 進捗バー管理クラス
export class ProgressBarManager {
  private progressBar: HTMLElement | null;
  private progressText: HTMLElement | null;
  private progressContainer: HTMLElement | null;

  constructor() {
    this.progressBar = null;
    this.progressText = null;
    this.progressContainer = null;
    this.createProgressBar();
  }

  private createProgressBar(): void {
    // プログレスバーのコンテナを作成
    this.progressContainer = document.createElement("div");
    this.progressContainer.id = "progressContainer";
    this.progressContainer.className = "progress-container hidden";

    // プログレステキスト
    this.progressText = document.createElement("div");
    this.progressText.className = "progress-text";
    this.progressText.textContent = "処理中...";

    // プログレスバー
    const progressBarWrapper = document.createElement("div");
    progressBarWrapper.className = "progress-bar-wrapper";

    this.progressBar = document.createElement("div");
    this.progressBar.className = "progress-bar";
    this.progressBar.style.width = "0%";

    progressBarWrapper.appendChild(this.progressBar);
    this.progressContainer.appendChild(this.progressText);
    this.progressContainer.appendChild(progressBarWrapper);

    // ボディに追加
    document.body.appendChild(this.progressContainer);
  }

  show(text: string = "処理中..."): void {
    if (this.progressText) {
      this.progressText.textContent = text;
    }
    if (this.progressContainer) {
      this.progressContainer.classList.remove("hidden");
    }
  }

  hide(): void {
    if (this.progressContainer) {
      this.progressContainer.classList.add("hidden");
    }
    this.updateProgress(0);
  }

  updateProgress(percentage: number, text?: string): void {
    if (this.progressBar) {
      this.progressBar.style.width = `${Math.max(
        0,
        Math.min(100, percentage)
      )}%`;
    }
    if (text && this.progressText) {
      this.progressText.textContent = text;
    }
  }

  // app.jsで使用されているshowProgressメソッドを追加（後方互換性のため）
  showProgress(text: string, percentage: number = 0): void {
    this.show(text);
    this.updateProgress(percentage);
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

  static formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
}

// プログレス管理（後方互換性のため）
export class ProgressManager extends ProgressBarManager {
  // 継承によって後方互換性を保つ
}

// テーマ管理クラス
export class ThemeManager {
  private currentTheme: string;

  constructor() {
    this.currentTheme = "dark";
    this.initializeTheme();
  }

  initializeTheme(): void {
    console.log("Initializing theme...");

    // Load saved theme
    const savedTheme = localStorage.getItem("theme");
    console.log("Saved theme:", savedTheme);

    if (savedTheme) {
      this.currentTheme = savedTheme;
      this.applyTheme(savedTheme);
    } else {
      // Default to dark theme
      this.applyTheme("dark");
    }

    // Update theme select
    const themeSelect = document.getElementById(
      "themeSelect"
    ) as HTMLSelectElement;
    if (themeSelect) {
      themeSelect.value = this.currentTheme;
      console.log("Theme select set to:", this.currentTheme);
    }

    // Add system theme change listener
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addListener(() => {
        if (this.currentTheme === "system") {
          this.applySystemTheme();
        }
      });
      console.log("System theme listener added");
    }
  }

  applyTheme(theme: string): void {
    console.log("Applying theme:", theme);
    this.currentTheme = theme;

    const body = document.body;

    if (theme === "system") {
      this.applySystemTheme();
    } else {
      body.setAttribute("data-theme", theme);
      console.log(`Theme ${theme} applied`);
    }

    // Save theme
    localStorage.setItem("theme", theme);
    console.log("Theme saved to localStorage");

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
      "dynamic-placeholder-styles"
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
      "(prefers-color-scheme: dark)"
    ).matches;

    if (prefersDark) {
      body.setAttribute("data-theme", "dark");
      console.log("System dark theme applied");
    } else {
      body.setAttribute("data-theme", "light");
      console.log("System light theme applied");
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
      this.handleKeyboardNavigation(e)
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

  updateCallbacks(newCallbacks: Record<string, (e: KeyboardEvent) => void>): void {
    this.callbacks = { ...this.callbacks, ...newCallbacks };
  }
}

// ファイルサイズフォーマット関数
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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
    "gi"
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
    textContent: string = ""
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
      innerHTML?: string;
      attributes?: Record<string, string>;
    } = {}
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);

    if (options.className) element.className = options.className;
    if (options.id) element.id = options.id;
    if (options.textContent) element.textContent = options.textContent;
    if (options.innerHTML) element.innerHTML = options.innerHTML;

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
    events: Record<string, EventListener>
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
  debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
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
  throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number
  ): (...args: Parameters<T>) => void {
    let inThrottle: boolean;
    return function (...args: Parameters<T>) {
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
