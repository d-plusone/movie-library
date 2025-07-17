/**
 * ユーティリティ関数とヘルパークラス
 * フォーマット、通知、進捗表示などの共通機能
 */

// 通知管理クラス
export class NotificationManager {
  constructor() {
    this.maxToasts = 3;
  }

  show(message, type = "info") {
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
}

// 進捗表示管理クラス
export class ProgressManager {
  showProgress(text, percent) {
    const progressContainer = document.getElementById("progressContainer");
    const progressText = document.getElementById("progressText");
    const progressPercent = document.getElementById("progressPercent");
    const progressFill = document.getElementById("progressFill");

    if (
      !progressContainer ||
      !progressText ||
      !progressPercent ||
      !progressFill
    ) {
      console.error("ProgressManager - progress elements not found");
      return;
    }

    progressText.textContent = text;
    progressPercent.textContent = `${Math.round(percent)}%`;
    progressFill.style.width = `${percent}%`;
    progressContainer.style.display = "block";
  }

  hideProgress() {
    const progressContainer = document.getElementById("progressContainer");
    if (progressContainer) {
      progressContainer.style.display = "none";
    }
  }

  handleScanProgress(data) {
    switch (data.type) {
      case "scan-start":
        this.showProgress(`スキャン中: ${data.directory}`, 0);
        break;
      case "scan-progress":
        const percent = (data.progress.current / data.progress.total) * 100;
        this.showProgress(`スキャン中: ${data.progress.file}`, percent);
        break;
      case "scan-complete":
        this.hideProgress();
        break;
      case "scan-error":
        this.hideProgress();
        break;
    }
    return data;
  }

  handleThumbnailProgress(data) {
    switch (data.type) {
      case "thumbnail-start":
        this.showProgress("サムネイル生成中...", 0);
        break;
      case "thumbnail-progress":
        const percent = (data.completed / data.total) * 100;
        this.showProgress(
          `サムネイル生成中: ${data.completed}/${data.total}`,
          percent
        );
        break;
      case "thumbnail-complete":
        this.hideProgress();
        break;
    }
    return data;
  }
}

// フォーマット関数
export class FormatUtils {
  static formatDuration(seconds) {
    if (!seconds) return "00:00:00";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  static formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  static getFileExtension(filename) {
    const extension = filename.split(".").pop();
    return extension ? extension.toUpperCase() : "";
  }

  static formatDate(dateString) {
    return new Date(dateString).toLocaleDateString("ja-JP");
  }

  // HTMLエスケープ
  static escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

// DOM操作ヘルパー
export class DOMUtils {
  static createElement(tag, className = "", textContent = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textContent) element.textContent = textContent;
    return element;
  }

  static addEventListeners(element, events) {
    if (!element) {
      console.warn("DOMUtils - Cannot add event listeners to null element");
      return;
    }
    Object.entries(events).forEach(([event, handler]) => {
      element.addEventListener(event, handler);
    });
  }

  static removeAllEventListeners(element) {
    if (!element) return;

    const newElement = element.cloneNode(true);
    element.parentNode.replaceChild(newElement, element);
    return newElement;
  }

  static querySelector(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      console.warn(`DOMUtils - Element not found: ${selector}`);
    }
    return element;
  }

  static getElementById(id) {
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
  }

  static updateVideoCount(count) {
    const videoCountElement = document.getElementById("videoCount");
    if (videoCountElement) {
      videoCountElement.textContent = `${count} 動画`;
    }
  }
}

// テーマ管理クラス
export class ThemeManager {
  constructor() {
    this.currentTheme = "dark";
    this.initializeTheme();
  }

  initializeTheme() {
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
    const themeSelect = document.getElementById("themeSelect");
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

  applyTheme(theme) {
    console.log("Applying theme:", theme);
    this.currentTheme = theme;

    const body = document.body;

    // Remove existing theme data attribute
    body.removeAttribute("data-theme");

    switch (theme) {
      case "light":
        body.setAttribute("data-theme", "light");
        console.log("Light theme applied");
        break;
      case "dark":
        body.setAttribute("data-theme", "dark");
        console.log("Dark theme applied");
        break;
      case "system":
        this.applySystemTheme();
        console.log("System theme applied");
        break;
      default:
        body.setAttribute("data-theme", "dark");
        this.currentTheme = "dark";
        console.log("Default dark theme applied");
    }

    // Save theme preference
    localStorage.setItem("theme", this.currentTheme);
    console.log("Theme saved to localStorage:", this.currentTheme);

    // プレースホルダー色の直接設定（CSSが効かない場合の対策）
    this.updatePlaceholderColors();
  }

  updatePlaceholderColors() {
    const tagInput = document.getElementById("tagInput");
    if (tagInput) {
      const isDark = document.body.getAttribute("data-theme") === "dark";
      if (isDark) {
        // ダークモード時のプレースホルダー色を直接設定
        tagInput.style.setProperty(
          "--placeholder-color",
          "rgba(136, 136, 136, 0.6)",
          "important"
        );
        // インラインスタイルでも設定（確実性を高める）
        tagInput.style.setProperty("color", "var(--text-primary)", "important");
        console.log("Tag input placeholder color set for dark mode");
      } else {
        // ライトモード時のプレースホルダー色
        tagInput.style.setProperty(
          "--placeholder-color",
          "var(--text-tertiary)",
          "important"
        );
        tagInput.style.setProperty("color", "var(--text-primary)", "important");
        console.log("Tag input placeholder color set for light mode");
      }
    }

    // 全ての入力要素にも適用
    const allInputs = document.querySelectorAll('input[type="text"], textarea');
    allInputs.forEach((input) => {
      const isDark = document.body.getAttribute("data-theme") === "dark";
      if (isDark) {
        input.style.setProperty(
          "--placeholder-color",
          "rgba(136, 136, 136, 0.6)",
          "important"
        );
      } else {
        input.style.setProperty(
          "--placeholder-color",
          "var(--text-tertiary)",
          "important"
        );
      }
    });
  }

  applySystemTheme() {
    const body = document.body;
    body.removeAttribute("data-theme");

    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      body.setAttribute("data-theme", "dark");
      console.log("System dark theme applied");
    } else {
      body.setAttribute("data-theme", "light");
      console.log("System light theme applied");
    }

    // プレースホルダー色の更新
    this.updatePlaceholderColors();
  }

  getCurrentTheme() {
    return this.currentTheme;
  }

  toggleTheme() {
    let newTheme;
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
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.initializeKeyboardEvents();
  }

  initializeKeyboardEvents() {
    document.addEventListener("keydown", (e) =>
      this.handleKeyboardNavigation(e)
    );
  }

  handleKeyboardNavigation(e) {
    // Prevent handling if typing in input fields
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      return;
    }

    switch (e.key) {
      case "Escape":
        if (this.callbacks.onEscape) {
          this.callbacks.onEscape(e);
        }
        break;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        if (this.callbacks.onArrow) {
          this.callbacks.onArrow(e);
        }
        break;
      case "Enter":
        if (this.callbacks.onEnter) {
          this.callbacks.onEnter(e);
        }
        break;
      case " ": // Space
        if (this.callbacks.onSpace) {
          e.preventDefault(); // Prevent page scroll
          this.callbacks.onSpace(e);
        }
        break;
      default:
        if (this.callbacks.onOther) {
          this.callbacks.onOther(e);
        }
    }
  }

  updateCallbacks(newCallbacks) {
    this.callbacks = { ...this.callbacks, ...newCallbacks };
  }
}

// 汎用ユーティリティ関数
export const Utils = {
  // 配列をシャッフル
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  },

  // デバウンス関数
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // スロットル関数
  throttle(func, limit) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  },

  // 遅延実行
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};
