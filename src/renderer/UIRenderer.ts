import { FormatUtils, DOMUtils } from "./Utils.js";
import {
  Video,
  Tag,
  Directory,
  ChapterThumbnail,
  VideoStats,
  ThumbnailSettings,
  Filter,
  ViewType,
  ThumbnailInfo,
} from "../types/types.js";

/**
 * UI描画を担当するクラス
 * 動画リスト、サイドバー、設定画面の描画を管理
 */
export class UIRenderer {
  private currentView: ViewType = "grid";
  private selectedVideoIndex: number = -1;

  // ビューを設定
  setView(view: ViewType): ViewType {
    this.currentView = view;
    document
      .querySelectorAll(".view-btn")
      .forEach((btn) => btn.classList.remove("active"));

    const viewBtn = document.getElementById(view + "ViewBtn");
    if (viewBtn) {
      viewBtn.classList.add("active");
    }

    const videoList = document.getElementById("videoList");
    if (videoList) {
      videoList.className = `video-list ${view}-view`;
    }

    return view;
  }

  // 現在のビューを取得
  getCurrentView(): ViewType {
    return this.currentView;
  }

  // 選択されたビデオのインデックスを取得
  getSelectedVideoIndex(): number {
    return this.selectedVideoIndex;
  }

  // 選択されたビデオのインデックスを設定
  setSelectedVideoIndex(index: number): void {
    this.selectedVideoIndex = index;
  }

  // 選択されたビデオをハイライト
  highlightSelectedVideo(): void {
    console.log(
      "Highlighting selected video at index:",
      this.selectedVideoIndex,
    );
    // Remove existing highlights
    document.querySelectorAll(".video-item.selected").forEach((item) => {
      item.classList.remove("selected");
    });

    // Highlight current selection
    if (this.selectedVideoIndex >= 0) {
      const videoItems = document.querySelectorAll(".video-item");
      if (videoItems[this.selectedVideoIndex]) {
        videoItems[this.selectedVideoIndex].classList.add("selected");
      }
    }
  }

  // 動画リストを描画
  renderVideoList(
    filteredVideos: Video[],
    playVideoCallback?: (path: string) => Promise<void>,
  ): number {
    const videoList = document.getElementById("videoList");

    if (!videoList) {
      console.error("UIRenderer - Video list element not found!");
      return 0;
    }

    videoList.innerHTML = "";

    if (filteredVideos.length === 0) {
      const noVideosMsg = document.createElement("div");
      noVideosMsg.className = "no-videos-message";
      noVideosMsg.textContent = "表示する動画がありません";
      videoList.appendChild(noVideosMsg);
      this.updateVideoCount(0);
      return 0;
    }

    filteredVideos.forEach((video, index) => {
      const videoElement = this.createVideoElement(
        video,
        index,
        playVideoCallback,
      );
      videoList.appendChild(videoElement);
    });

    // Update video count
    this.updateVideoCount(filteredVideos.length);

    // Update selected video if needed
    if (
      this.selectedVideoIndex >= 0 &&
      this.selectedVideoIndex < filteredVideos.length
    ) {
      this.highlightSelectedVideo();
    }

    return filteredVideos.length;
  }

  // 特定の動画のタグ表示だけを更新（サムネイルは再読み込みしない）
  updateVideoTags(videoId: number, tags: string[]): void {
    const videoElement = document.querySelector(
      `.video-item[data-video-id="${videoId}"]`,
    );
    if (!videoElement) {
      console.warn(`Video element not found for ID: ${videoId}`);
      return;
    }

    // タグコンテナを探す
    const tagsContainer = videoElement.querySelector(".video-tags");
    if (!tagsContainer) {
      console.warn(`Tags container not found for video ID: ${videoId}`);
      return;
    }

    // タグコンテナをクリア
    tagsContainer.innerHTML = "";

    // タグがある場合は表示
    if (tags && tags.length > 0) {
      if (this.currentView === "grid") {
        // Grid view: show up to 3 tags plus overflow indicator
        const maxVisibleTags = 3;
        const visibleTags = tags.slice(0, maxVisibleTags);
        const hiddenTags = tags.slice(maxVisibleTags);

        // Add visible tags
        visibleTags.forEach((tag) => {
          const tagSpan = document.createElement("span");
          tagSpan.className = "video-tag";
          tagSpan.textContent = tag;
          tagsContainer.appendChild(tagSpan);
        });

        // Add overflow indicator if there are hidden tags
        if (hiddenTags.length > 0) {
          const overflowIndicator = document.createElement("span");
          overflowIndicator.className = "video-tag-overflow";
          overflowIndicator.textContent = `+${hiddenTags.length}`;
          overflowIndicator.title = `他のタグ: ${hiddenTags.join(", ")}`;
          tagsContainer.appendChild(overflowIndicator);
        }
      } else {
        // List view: show all tags
        tags.forEach((tag) => {
          const tagSpan = document.createElement("span");
          tagSpan.className = "video-tag";
          tagSpan.textContent = tag;
          tagsContainer.appendChild(tagSpan);
        });
      }
    }
  }

  // 動画要素を作成
  createVideoElement(
    video: Video,
    index: number,
    playVideoCallback?: (path: string) => Promise<void>,
  ): HTMLElement {
    const div = document.createElement("div");
    div.className = "video-item";
    div.dataset.index = index.toString();
    div.dataset.videoId = video.id.toString();

    const thumbnailSrc = video.thumbnailPath
      ? `file://${video.thumbnailPath}?t=${Date.now()}`
      : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";

    console.log(
      `UIRenderer: Creating video element for ${video.filename}, thumbnailPath: ${video.thumbnailPath}, thumbnailSrc: ${thumbnailSrc}`,
    );

    const duration = FormatUtils.formatDuration(video.duration ?? 0);
    const fileSize = FormatUtils.formatFileSize(video.size ?? 0);
    const rating = "⭐".repeat(video.rating || 0);
    const extension = FormatUtils.getFileExtension(video.filename);

    // Create video info div
    const videoInfoDiv = document.createElement("div");
    videoInfoDiv.className = "video-info";

    // Create and populate video info elements
    const titleDiv = document.createElement("div");
    titleDiv.className = "video-title";
    titleDiv.innerHTML = `${video.title}<span class="video-extension">${extension}</span>`;

    // Create tags container first (for grid view positioning)
    const tagsContainer = document.createElement("div");
    tagsContainer.className = "video-tags";

    const metaDiv = document.createElement("div");
    metaDiv.className = "video-meta";

    // Create meta info separately for flexible layout
    const metaInfoDiv = document.createElement("div");
    metaInfoDiv.className = "meta-info";
    metaInfoDiv.innerHTML = `
        <div>サイズ: ${fileSize}</div>
        <div>解像度: ${video.width ?? 0}x${video.height ?? 0}</div>
        <div>追加日: ${FormatUtils.formatDate(
          video.addedAt
            ? video.addedAt.toISOString()
            : new Date().toISOString(),
        )}</div>
    `;

    const ratingDiv = document.createElement("div");
    ratingDiv.className = "video-rating";
    ratingDiv.textContent = rating;

    // Handle tags display
    if (video.tags && video.tags.length > 0) {
      if (this.currentView === "grid") {
        // Grid view: show up to 3 tags plus overflow indicator
        const maxVisibleTags = 3;
        const visibleTags = video.tags.slice(0, maxVisibleTags);
        const hiddenTags = video.tags.slice(maxVisibleTags);

        // Add visible tags
        visibleTags.forEach((tag) => {
          const tagSpan = document.createElement("span");
          tagSpan.className = "video-tag";
          tagSpan.textContent = tag;
          tagsContainer.appendChild(tagSpan);
        });

        // Add overflow indicator if there are hidden tags
        if (hiddenTags.length > 0) {
          const overflowIndicator = document.createElement("span");
          overflowIndicator.className = "video-tag-overflow";
          overflowIndicator.textContent = `+${hiddenTags.length}`;
          overflowIndicator.title = `他のタグ: ${hiddenTags.join(", ")}`;
          tagsContainer.appendChild(overflowIndicator);
        }
      } else {
        // List view: show all tags
        video.tags.forEach((tag) => {
          const tagSpan = document.createElement("span");
          tagSpan.className = "video-tag";
          tagSpan.textContent = tag;
          tagsContainer.appendChild(tagSpan);
        });
      }
    }

    // Assemble meta div with info and tags
    metaDiv.appendChild(metaInfoDiv);
    metaDiv.appendChild(tagsContainer);

    // Assemble video info
    videoInfoDiv.appendChild(titleDiv);
    videoInfoDiv.appendChild(metaDiv);

    // Only add rating to video info if not grid view (will be added to thumbnail for grid view)
    if (this.currentView !== "grid") {
      videoInfoDiv.appendChild(ratingDiv);
    }

    // Create thumbnail div
    const thumbnailDiv = document.createElement("div");
    thumbnailDiv.className = "video-thumbnail";

    // Check if current view is grid view
    const isGridView = this.currentView === "grid";

    if (isGridView) {
      // Create thumbnail cycling container for grid view
      const cycleContainer = document.createElement("div");
      cycleContainer.className = "thumbnail-cycle";

      // Prepare thumbnail images (main + chapters)
      const thumbnails: ThumbnailInfo[] = [
        { src: thumbnailSrc, label: "メイン" },
      ];

      // Add chapter thumbnails if available (up to 5)
      if (video.chapterThumbnails) {
        let chapters: ChapterThumbnail[] = [];

        if (Array.isArray(video.chapterThumbnails)) {
          chapters = video.chapterThumbnails;
        } else if (typeof video.chapterThumbnails === "string") {
          try {
            const parsed = JSON.parse(video.chapterThumbnails);
            if (Array.isArray(parsed)) {
              chapters = parsed as ChapterThumbnail[];
            } else if (typeof parsed === "object" && parsed !== null) {
              chapters = Object.values(parsed) as ChapterThumbnail[];
            }
          } catch (error) {
            console.warn("Failed to parse chapterThumbnails:", error);
          }
        } else if (
          typeof video.chapterThumbnails === "object" &&
          video.chapterThumbnails !== null
        ) {
          chapters = Object.values(
            video.chapterThumbnails,
          ) as ChapterThumbnail[];
        }

        // Add valid chapter thumbnails (up to 5)
        const validChapters = chapters
          .filter(
            (chapter): chapter is ChapterThumbnail =>
              chapter &&
              typeof chapter.path === "string" &&
              typeof chapter.timestamp === "number",
          )
          .slice(0, 5);

        validChapters.forEach((chapter: ChapterThumbnail, index: number) => {
          console.log(`Chapter ${index}:`, chapter); // チャプターデータをログ出力
          const chapterPath = chapter.path; // チャプターは path プロパティを使用
          console.log(`Chapter ${index} path:`, chapterPath);
          if (chapterPath) {
            thumbnails.push({
              src: `file://${chapterPath}?t=${Date.now()}`,
              label: `チャプター ${index + 1}`,
            });
          }
        });
      }

      // Create thumbnail images
      thumbnails.forEach((thumb, index) => {
        const img = document.createElement("img");
        img.src = thumb.src;
        img.alt = `${video.title} - ${thumb.label}`;
        img.loading = "lazy";
        img.className = `thumbnail-image ${index === 0 ? "active" : ""}`;
        img.dataset.index = index.toString();
        cycleContainer.appendChild(img);
      });

      // Create indicator dots if more than one thumbnail
      if (thumbnails.length > 1) {
        const indicatorContainer = document.createElement("div");
        indicatorContainer.className = "thumbnail-indicator";

        thumbnails.forEach((_, index) => {
          const dot = document.createElement("div");
          dot.className = `indicator-dot ${index === 0 ? "active" : ""}`;
          dot.dataset.index = index.toString();
          indicatorContainer.appendChild(dot);
        });

        thumbnailDiv.appendChild(indicatorContainer);

        // Add cycling functionality
        let currentIndex = 0;
        let cycleInterval: NodeJS.Timeout | null = null;

        // Auto-cycle on hover
        thumbnailDiv.addEventListener("mouseenter", () => {
          if (thumbnails.length > 1) {
            cycleInterval = setInterval(() => {
              currentIndex = (currentIndex + 1) % thumbnails.length;
              this.updateThumbnailDisplay(
                cycleContainer,
                indicatorContainer,
                currentIndex,
              );
            }, 800);
          }
        });

        // Stop cycling on mouse leave
        thumbnailDiv.addEventListener("mouseleave", () => {
          if (cycleInterval) {
            clearInterval(cycleInterval);
            cycleInterval = null;
          }
          // Reset to main thumbnail
          currentIndex = 0;
          this.updateThumbnailDisplay(cycleContainer, indicatorContainer, 0);
        });

        // Click on dots to manually select
        indicatorContainer.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          if (target.classList.contains("indicator-dot")) {
            e.stopPropagation();
            currentIndex = parseInt(target.dataset.index || "0");
            this.updateThumbnailDisplay(
              cycleContainer,
              indicatorContainer,
              currentIndex,
            );

            // Reset auto-cycle
            if (cycleInterval) {
              clearInterval(cycleInterval);
              cycleInterval = setInterval(() => {
                currentIndex = (currentIndex + 1) % thumbnails.length;
                this.updateThumbnailDisplay(
                  cycleContainer,
                  indicatorContainer,
                  currentIndex,
                );
              }, 800);
            }
          }
        });
      }

      thumbnailDiv.appendChild(cycleContainer);
    } else {
      // List view - use simple thumbnail
      const thumbnailImg = document.createElement("img");
      thumbnailImg.src = thumbnailSrc;
      thumbnailImg.alt = video.title;
      thumbnailImg.loading = "lazy";
      thumbnailDiv.appendChild(thumbnailImg);
    }

    const durationDiv = document.createElement("div");
    durationDiv.className = "video-duration";
    durationDiv.textContent = duration;

    thumbnailDiv.appendChild(durationDiv);

    // Add rating to thumbnail in grid view (top-right position)
    if (isGridView && rating) {
      const thumbnailRatingDiv = document.createElement("div");
      thumbnailRatingDiv.className = "video-rating-overlay";
      thumbnailRatingDiv.textContent = rating;
      thumbnailDiv.appendChild(thumbnailRatingDiv);
    }

    // Assemble the complete video element
    div.appendChild(thumbnailDiv);
    div.appendChild(videoInfoDiv);

    // Add double-click event for video playback
    div.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (playVideoCallback) {
        playVideoCallback(video.path);
      }
    });

    return div;
  }

  // サムネイル表示を更新
  updateThumbnailDisplay(
    cycleContainer: HTMLElement,
    indicatorContainer: HTMLElement,
    activeIndex: number,
  ): void {
    // Update thumbnail images
    const images = cycleContainer.querySelectorAll(".thumbnail-image");
    images.forEach((img, index) => {
      img.classList.toggle("active", index === activeIndex);
    });

    // Update indicator dots
    const dots = indicatorContainer.querySelectorAll(".indicator-dot");
    dots.forEach((dot, index) => {
      dot.classList.toggle("active", index === activeIndex);
    });
  }

  // ビデオカウントを更新
  updateVideoCount(count: number): void {
    const videoCountElement = document.getElementById("videoCount");
    if (videoCountElement) {
      videoCountElement.textContent = `${count} 動画`;
    }
  }

  // サイドバーを描画
  renderSidebar(
    tags: Tag[],
    directories: Directory[],
    currentFilter: Filter,
    selectedDirectories: string[],
  ): void {
    try {
      this.renderTags(tags, currentFilter.tags);
      this.renderDirectories(directories, selectedDirectories);
    } catch (error) {
      console.error("UIRenderer - Error rendering sidebar:", error);
    }
  }

  // タグリストを描画
  renderTags(tags: Tag[], activeTagNames: string[] = []): void {
    const tagsList = document.getElementById("tagsList");

    if (!tagsList) {
      console.error("UIRenderer - tagsList element not found!");
      return;
    }

    tagsList.innerHTML = "";

    tags.forEach((tag) => {
      const tagElement = document.createElement("div");
      tagElement.className = "tag-item";

      // Check if this tag is currently being filtered
      const isSelected = activeTagNames.includes(tag.name);
      if (isSelected) {
        tagElement.classList.add("selected");
      }

      tagElement.dataset.tagName = tag.name;
      tagElement.innerHTML = `
        <span class="tag-name">${FormatUtils.escapeHtml(tag.name)}</span>
        <div class="tag-actions">
          <button class="tag-edit-btn" data-tag="${FormatUtils.escapeHtml(
            tag.name,
          )}" title="編集">✏️</button>
          <button class="tag-delete-btn" data-tag="${FormatUtils.escapeHtml(
            tag.name,
          )}" title="削除">🗑️</button>
        </div>
      `;

      tagsList.appendChild(tagElement);
    });
  }

  // ディレクトリリストを描画
  renderDirectories(
    directories: Directory[],
    selectedDirectories: string[],
  ): void {
    console.log("renderDirectories - directories:", directories.length);
    console.log(
      "renderDirectories - selectedDirectories:",
      selectedDirectories,
    );

    const directoriesList = document.getElementById("directoriesList");

    if (!directoriesList) {
      console.error("UIRenderer - directoriesList element not found!");
      return;
    }

    directoriesList.innerHTML = "";

    directories.forEach((directory) => {
      const directoryElement = document.createElement("div");
      directoryElement.className = "directory-item";
      directoryElement.dataset.path = directory.path;

      const isSelected = selectedDirectories.includes(directory.path);

      if (isSelected) {
        directoryElement.classList.add("selected");
      }

      // ディレクトリ名を取得（パスの最後の部分）
      const directoryName =
        directory.path.split(/[/\\]/).pop() || directory.path;

      directoryElement.innerHTML = `
        <span class="directory-path" title="${FormatUtils.escapeHtml(
          directory.path,
        )}">${FormatUtils.escapeHtml(directoryName)}</span>
        <div class="directory-actions">
          <button class="directory-remove-btn" data-path="${FormatUtils.escapeHtml(
            directory.path,
          )}" title="削除">×</button>
        </div>
      `;

      directoriesList.appendChild(directoryElement);
    });
  }

  // 設定画面のディレクトリリストを描画
  renderSettingsDirectories(directories: Directory[]): void {
    const settingsDirectoriesList = document.getElementById(
      "settingsDirectoriesList",
    );

    if (!settingsDirectoriesList) {
      console.error("UIRenderer - settingsDirectoriesList element not found!");
      return;
    }

    settingsDirectoriesList.innerHTML = "";

    directories.forEach((directory) => {
      const directoryElement = document.createElement("div");
      directoryElement.className = "settings-directory-item";
      directoryElement.innerHTML = `
        <span class="directory-path" title="${FormatUtils.escapeHtml(
          directory.path,
        )}">${FormatUtils.escapeHtml(directory.path)}</span>
        <button class="remove-directory-btn" data-path="${FormatUtils.escapeHtml(
          directory.path,
        )}">削除</button>
      `;

      settingsDirectoriesList.appendChild(directoryElement);
    });
  }

  // 星評価の表示を更新
  updateStarDisplay(rating: number, isHover: boolean = false): void {
    console.log(
      "updateStarDisplay called with rating:",
      rating,
      "isHover:",
      isHover,
    );

    // 星ボタンのみを対象（data-rating="0"の「全て」ボタンは除外）
    const starButtons = document.querySelectorAll(".rating-btn[data-rating]");

    starButtons.forEach((btn) => {
      const button = btn as HTMLElement;
      const btnRating = parseInt(button.dataset.rating || "0");

      // data-rating="0"は「全て」ボタンなのでスキップ
      if (btnRating === 0) return;

      if (isHover) {
        // ホバー時：一時的なプレビュー表示（activeクラスは変更しない）
        if (btnRating <= rating && rating > 0) {
          button.textContent = "⭐";
        } else {
          // ホバー範囲外でもactiveクラスがあれば⭐を維持
          if (button.classList.contains("active")) {
            button.textContent = "⭐";
          } else {
            button.textContent = "☆";
          }
        }
      } else {
        // ホバー終了時または決定時：activeクラスに基づいて表示を復元
        if (btnRating <= rating && rating > 0) {
          button.classList.add("active");
          button.textContent = "⭐";
        } else {
          // rating = 0の場合はactiveクラスを削除
          if (rating === 0) {
            button.classList.remove("active");
          }
          // activeクラスがあれば⭐を維持、なければ☆
          if (button.classList.contains("active")) {
            button.textContent = "⭐";
          } else {
            button.textContent = "☆";
          }
        }
      }
    });
  }

  // ビデオ詳細の描画
  // チャプターサムネイルを効率的に更新
  private updateChapterThumbnails(video: Video): void {
    const chapterContainer = document.getElementById(
      "detailsChapterThumbnails",
    );
    if (!chapterContainer) return;

    // ChapterThumbnailの型ガード関数
    // 新しいチャプターデータを解析
    let newChapters: ChapterThumbnail[] = [];
    if (video.chapterThumbnails) {
      try {
        if (Array.isArray(video.chapterThumbnails)) {
          newChapters = video.chapterThumbnails;
        } else if (typeof video.chapterThumbnails === "string") {
          const parsed = JSON.parse(video.chapterThumbnails);
          if (Array.isArray(parsed)) {
            newChapters = parsed as ChapterThumbnail[];
          } else if (typeof parsed === "object" && parsed !== null) {
            newChapters = Object.values(parsed) as ChapterThumbnail[];
          }
        } else if (
          typeof video.chapterThumbnails === "object" &&
          video.chapterThumbnails !== null
        ) {
          newChapters = Object.values(
            video.chapterThumbnails,
          ) as ChapterThumbnail[];
        }
      } catch (error) {
        console.warn("Failed to parse chapterThumbnails:", error);
        return;
      }
    }

    // 表示するチャプター数（最大5個）
    const maxChapters = 5;
    const chaptersToShow = newChapters.slice(0, maxChapters);

    // 既存の要素数と新しい要素数を比較
    const existingChapters = chapterContainer.children;
    const existingCount = existingChapters.length;
    const newCount = chaptersToShow.length;

    // 既存の要素を更新
    for (let i = 0; i < Math.min(existingCount, newCount); i++) {
      const existingDiv = existingChapters[i] as HTMLElement;
      const existingImg = existingDiv.querySelector("img") as HTMLImageElement;
      const chapter = chaptersToShow[i];
      const chapterPath = chapter.path;

      if (existingImg && chapterPath) {
        const newSrc = `file://${chapterPath}?t=${Date.now()}`;
        if (existingImg.src !== newSrc) {
          existingImg.src = newSrc;
          existingImg.alt = `Chapter ${i + 1}`;
        }
      }
    }

    // 新しい要素が必要な場合は追加
    for (let i = existingCount; i < newCount; i++) {
      const chapter = chaptersToShow[i];
      const chapterPath = chapter.path;
      if (!chapterPath) continue;

      const chapterDiv = document.createElement("div");
      chapterDiv.className = "chapter-thumbnail";

      const img = document.createElement("img");
      img.src = `file://${chapterPath}?t=${Date.now()}`;
      img.alt = `Chapter ${i + 1}`;
      img.loading = "lazy";

      chapterDiv.appendChild(img);
      chapterContainer.appendChild(chapterDiv);
    }

    // 余分な要素がある場合は削除
    for (let i = existingCount - 1; i >= newCount; i--) {
      const elementToRemove = existingChapters[i];
      if (elementToRemove) {
        chapterContainer.removeChild(elementToRemove);
      }
    }
  }

  // 詳細パネルのタグ表示を更新
  updateDetailsTagsDisplay(tags: string[]): void {
    const tagsContainer = document.getElementById("detailsTagsList");
    if (!tagsContainer) return;

    tagsContainer.innerHTML = "";

    tags.forEach((tag) => {
      const tagElement = document.createElement("span");
      tagElement.className = "tag";
      tagElement.innerHTML = `
        ${FormatUtils.escapeHtml(tag)}
        <button class="remove-tag" data-tag="${FormatUtils.escapeHtml(
          tag,
        )}" title="タグを削除">×</button>
      `;
      tagsContainer.appendChild(tagElement);
    });
  }

  // タグサジェストの更新
  updateTagSuggestions(tags: Tag[]): void {
    const datalist = document.getElementById("tagSuggestions");
    if (!datalist) return;

    datalist.innerHTML = "";

    tags.forEach((tag) => {
      const option = document.createElement("option");
      option.value = tag.name;
      datalist.appendChild(option);
    });
  }

  // サムネイル設定を読み込み
  loadThumbnailSettings(): void {
    try {
      const quality = localStorage.getItem("thumbnailQuality") || "1";
      const size = localStorage.getItem("thumbnailSize") || "1280x720";

      const qualitySelect = document.getElementById(
        "thumbnailQuality",
      ) as HTMLSelectElement;
      const sizeSelect = document.getElementById(
        "thumbnailSize",
      ) as HTMLSelectElement;

      if (qualitySelect) {
        qualitySelect.value = quality;
      }

      if (sizeSelect) {
        sizeSelect.value = size;
      }

      console.log("Thumbnail settings loaded:", { quality, size });
    } catch (error) {
      console.error("Error loading thumbnail settings:", error);
    }
  }

  // 詳細画面を表示
  showVideoDetails(video: Video): void {
    const detailsPanel = document.getElementById("detailsPanel");
    if (!detailsPanel) {
      console.error("UIRenderer - detailsPanel element not found!");
      return;
    }

    // パネルが初回表示の場合のみ表示状態を設定
    if (detailsPanel.style.display !== "block") {
      detailsPanel.style.display = "block";
    }

    // 要素の内容のみを効率的に更新
    this.updateVideoDetailsContent(video);
  }

  // 詳細画面の内容のみを更新（DOM構造は維持）
  private updateVideoDetailsContent(video: Video): void {
    // メインサムネイルを更新
    const mainThumbnailImg = document.getElementById(
      "detailsMainThumbnail",
    ) as HTMLImageElement;
    if (mainThumbnailImg && video.thumbnailPath) {
      const newSrc = `file://${video.thumbnailPath}?t=${Date.now()}`;
      if (mainThumbnailImg.src !== newSrc) {
        mainThumbnailImg.src = newSrc;
        mainThumbnailImg.alt = video.title;
      }
    }

    // タイトル入力を更新
    const titleInput = document.getElementById(
      "detailsTitleInput",
    ) as HTMLInputElement;
    if (titleInput && titleInput.value !== video.title) {
      titleInput.value = video.title;
    }

    // 説明入力を更新
    const descriptionInput = document.getElementById(
      "detailsDescriptionInput",
    ) as HTMLTextAreaElement;
    const descriptionValue = video.description || "";
    if (descriptionInput && descriptionInput.value !== descriptionValue) {
      descriptionInput.value = descriptionValue;
    }

    // ファイル情報を更新（値が変わった場合のみ）
    this.updateElementTextIfChanged("detailsFilePath", video.path);
    this.updateElementTextIfChanged(
      "detailsFileSize",
      FormatUtils.formatFileSize(video.size ?? 0),
    );
    this.updateElementTextIfChanged(
      "detailsDuration",
      FormatUtils.formatDuration(video.duration ?? 0),
    );
    this.updateElementTextIfChanged(
      "detailsResolution",
      `${video.width ?? 0}x${video.height ?? 0}`,
    );
    this.updateElementTextIfChanged(
      "detailsFps",
      `${this.formatFps(video.fps ?? 0)} fps`,
    );
    this.updateElementTextIfChanged("detailsCodec", video.codec || "不明");

    // タグリストを更新
    this.updateDetailsTagsDisplay(video.tags || []);

    // 評価を更新
    this.updateDetailsRatingDisplay(video.rating || 0);

    // チャプターサムネイルを更新
    this.updateChapterThumbnails(video);
  }

  // 要素のテキストが変更された場合のみ更新
  private updateElementTextIfChanged(elementId: string, newText: string): void {
    const element = document.getElementById(elementId);
    if (element && element.textContent !== newText) {
      element.textContent = newText;
    }
  }

  // 詳細画面を非表示
  hideVideoDetails(): void {
    const detailsPanel = document.getElementById("detailsPanel");
    if (detailsPanel) {
      detailsPanel.style.display = "none";
    }
  }

  // サムネイルツールチップを作成
  createThumbnailTooltip(imagePath: string, timestamp: string): HTMLElement {
    const tooltip = document.createElement("div");
    tooltip.className = "thumbnail-tooltip";

    const img = document.createElement("img");
    img.src = `file://${imagePath}?t=${Date.now()}`;
    img.alt = `Thumbnail - ${timestamp}`;

    const timeDiv = document.createElement("div");
    timeDiv.className = "timestamp";
    timeDiv.textContent = timestamp;

    tooltip.appendChild(img);
    tooltip.appendChild(timeDiv);

    return tooltip;
  }

  // 設定モーダルを表示
  showSettingsModal(): void {
    const modal = document.getElementById("settingsModal");
    if (modal) {
      modal.classList.add("settings-modal");
      modal.style.display = "flex";
      modal.setAttribute("is-open", "true");
    }
  }

  // 設定モーダルを非表示
  hideSettingsModal(): void {
    const modal = document.getElementById("settingsModal");
    if (modal) {
      modal.style.display = "none";
      modal.classList.remove("settings-modal");
      modal.removeAttribute("is-open");
    }
  }

  // 評価表示を更新
  updateDetailsRatingDisplay(rating: number): void {
    const ratingStars = document.querySelectorAll(".rating-input .star");
    const clearButton = document.querySelector(
      ".clear-rating-btn",
    ) as HTMLElement;

    ratingStars.forEach((star, index) => {
      const starElement = star as HTMLElement;
      if (index < rating) {
        starElement.textContent = "⭐";
        starElement.classList.add("active");
      } else {
        starElement.textContent = "☆";
        starElement.classList.remove("active");
      }
    });

    // 削除ボタンの表示/非表示を制御
    if (clearButton) {
      clearButton.style.display = rating > 0 ? "inline-block" : "none";
    }
  }

  // 詳細画面の評価ホバー表示を更新
  updateDetailsRatingHover(rating: number, isHover: boolean): void {
    const ratingStars = document.querySelectorAll(".rating-input .star");

    ratingStars.forEach((star, index) => {
      const starElement = star as HTMLElement;

      if (isHover) {
        // ホバー時：一時的なプレビュー表示
        if (index < rating && rating > 0) {
          starElement.textContent = "⭐";
          starElement.classList.add("hover");
        } else {
          // ホバー範囲外でもactiveクラスがあれば⭐を維持
          if (starElement.classList.contains("active")) {
            starElement.textContent = "⭐";
          } else {
            starElement.textContent = "☆";
          }
          starElement.classList.remove("hover");
        }
      } else {
        // ホバー終了時：activeクラスに基づいて表示を復元
        starElement.classList.remove("hover");
        if (index < rating && rating > 0) {
          starElement.textContent = "⭐";
          starElement.classList.add("active");
        } else {
          if (starElement.classList.contains("active")) {
            starElement.textContent = "⭐";
          } else {
            starElement.textContent = "☆";
          }
        }
      }
    });
  }

  // 一括タグダイアログを表示
  showBulkTagApplyDialog(filteredVideos: Video[], allTags: Tag[]): void {
    console.log("showBulkTagApplyDialog called");
    const bulkTagApplyDialog = DOMUtils.getElementById("bulkTagApplyDialog");
    const bulkTagApplyTable = DOMUtils.getElementById(
      "bulkTagApplyTable",
    ) as HTMLTableElement;

    console.log("bulkTagApplyDialog element:", bulkTagApplyDialog);
    console.log("bulkTagApplyTable element:", bulkTagApplyTable);

    if (!bulkTagApplyDialog || !bulkTagApplyTable) {
      console.error("Bulk tag apply dialog elements not found");
      return;
    }

    console.log("Current videos count:", filteredVideos.length);

    if (filteredVideos.length === 0) {
      alert("表示する動画がありません。");
      return;
    }

    console.log("All tags:", allTags);

    // Clear existing table content
    const thead = bulkTagApplyTable.querySelector(
      "thead",
    ) as HTMLTableSectionElement;
    const tbody = bulkTagApplyTable.querySelector(
      "tbody",
    ) as HTMLTableSectionElement;

    // Clear and rebuild header
    if (thead) thead.innerHTML = "";
    if (tbody) tbody.innerHTML = "";

    // ヘッダー行を作成
    const headerRow = document.createElement("tr");

    // 動画名ヘッダー
    const videoNameHeader = document.createElement("th");
    videoNameHeader.className = "video-name-header sticky-header";
    videoNameHeader.textContent = "動画名";
    headerRow.appendChild(videoNameHeader);

    // タグ列ヘッダー（タグ名 + 全選択チェックボックス）
    allTags.forEach((tag: Tag) => {
      const th = document.createElement("th");
      th.className = "tag-column-header sticky-header";
      th.title = `${tag.name} (${tag.count}個の動画で使用)`;

      // タグヘッダーのコンテンツコンテナ
      const headerContent = document.createElement("div");
      headerContent.className = "tag-header-content";

      // タグ名
      const tagNameDiv = document.createElement("div");
      tagNameDiv.className = "tag-name-text";
      tagNameDiv.textContent = tag.name;
      headerContent.appendChild(tagNameDiv);

      // 全選択チェックボックスコンテナ
      const checkboxContainer = document.createElement("div");
      checkboxContainer.className = "select-all-checkbox-container";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "select-all-checkbox";
      checkbox.dataset.tagName = tag.name;
      checkbox.title = `${tag.name}の全選択/全解除`;

      // 全選択チェックボックスのイベントリスナー
      checkbox.addEventListener("change", (e: Event) => {
        const target = e.target as HTMLInputElement;
        const isChecked = target.checked;
        const tagName = target.dataset.tagName;

        if (!tagName) return;

        // このタグの全てのチェックボックスを更新
        const tagCheckboxes = bulkTagApplyTable.querySelectorAll(
          `.tag-checkbox[data-tag-name="${tagName}"]`,
        ) as NodeListOf<HTMLInputElement>;

        tagCheckboxes.forEach((cb: HTMLInputElement) => {
          cb.checked = isChecked;
        });

        // 全選択チェックボックスの状態を更新
        this.updateSelectAllCheckboxState(tagName);
      });

      checkboxContainer.appendChild(checkbox);

      const label = document.createElement("span");
      label.textContent = "全選択";
      checkboxContainer.appendChild(label);

      headerContent.appendChild(checkboxContainer);
      th.appendChild(headerContent);
      headerRow.appendChild(th);
    });

    if (thead) thead.appendChild(headerRow);

    // 動画行の追加
    filteredVideos.forEach((video: Video, _index: number) => {
      const tr = document.createElement("tr");

      // 動画名セル（サムネイル + タイトル）
      const videoNameCell = document.createElement("td");
      videoNameCell.className = "video-name-cell";

      // サムネイル画像
      const thumbnail = document.createElement("img");
      thumbnail.className = "bulk-dialog-thumbnail";
      thumbnail.alt = "サムネイル";

      // サムネイルパスの設定（thumbnailPathのみを使用）
      const thumbPath = video.thumbnailPath;
      if (thumbPath && thumbPath !== "N/A") {
        thumbnail.src = `file://${thumbPath}`;
      } else {
        // デフォルト画像またはプレースホルダー
        thumbnail.style.background =
          "linear-gradient(135deg, var(--bg-tertiary), var(--bg-primary))";
        thumbnail.style.display = "flex";
        thumbnail.style.alignItems = "center";
        thumbnail.style.justifyContent = "center";
        thumbnail.style.fontSize = "10px";
        thumbnail.style.color = "var(--text-secondary)";
        thumbnail.innerHTML = "No Image";
        thumbnail.alt = "No thumbnail";
      }

      // エラー時のフォールバック
      thumbnail.onerror = () => {
        thumbnail.style.background =
          "linear-gradient(135deg, var(--bg-tertiary), var(--bg-primary))";
        thumbnail.style.display = "flex";
        thumbnail.style.alignItems = "center";
        thumbnail.style.justifyContent = "center";
        thumbnail.style.fontSize = "10px";
        thumbnail.style.color = "var(--text-secondary)";
        thumbnail.innerHTML = "No Image";
        thumbnail.alt = "No thumbnail";
      };

      videoNameCell.appendChild(thumbnail);

      // タイトルテキスト
      const titleSpan = document.createElement("span");
      titleSpan.className = "video-title-text";
      titleSpan.textContent = video.title || video.filename;
      titleSpan.title = video.title || video.filename;
      videoNameCell.appendChild(titleSpan);

      tr.appendChild(videoNameCell);

      // タグチェックボックスセル
      allTags.forEach((tag: Tag) => {
        const td = document.createElement("td");
        td.className = "tag-checkbox-cell";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tag-checkbox";
        checkbox.dataset.videoId = video.id.toString();
        checkbox.dataset.tagName = tag.name;

        // 動画が既にこのタグを持っているかチェック
        if (video.tags && video.tags.includes(tag.name)) {
          checkbox.checked = true;
        }

        // 個別チェックボックスの変更時に全選択状態を更新
        checkbox.addEventListener("change", () => {
          this.updateSelectAllCheckboxState(tag.name);
        });

        // セルクリックでチェックボックスをトグル
        td.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          // チェックボックス自体がクリックされた場合は何もしない
          if (target === checkbox) {
            return;
          }
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        });

        td.appendChild(checkbox);
        tr.appendChild(td);
      });

      if (tbody) tbody.appendChild(tr);
    });

    // 初期状態で全選択チェックボックスの状態を設定
    allTags.forEach((tag: Tag) => {
      this.updateSelectAllCheckboxState(tag.name);
    });

    bulkTagApplyDialog.style.display = "flex";
    bulkTagApplyDialog.setAttribute("is-open", "true");
  }

  // 一括タグダイアログを非表示
  hideBulkTagApplyDialog(): void {
    const bulkTagApplyDialog = DOMUtils.getElementById("bulkTagApplyDialog");
    if (bulkTagApplyDialog) {
      bulkTagApplyDialog.style.display = "none";
      bulkTagApplyDialog.removeAttribute("is-open");
    }
  }

  // 全選択チェックボックスの状態を更新するヘルパーメソッド
  updateSelectAllCheckboxState(tagName: string): void {
    const bulkTagApplyTable = DOMUtils.getElementById(
      "bulkTagApplyTable",
    ) as HTMLTableElement;
    if (!bulkTagApplyTable) return;

    const selectAllCheckbox = bulkTagApplyTable.querySelector(
      `.select-all-checkbox[data-tag-name="${tagName}"]`,
    ) as HTMLInputElement;
    const tagCheckboxes = bulkTagApplyTable.querySelectorAll(
      `.tag-checkbox[data-tag-name="${tagName}"]`,
    ) as NodeListOf<HTMLInputElement>;

    if (!selectAllCheckbox || tagCheckboxes.length === 0) return;

    const checkedCount = Array.from(tagCheckboxes).filter(
      (cb: HTMLInputElement) => cb.checked,
    ).length;
    const totalCount = tagCheckboxes.length;

    if (checkedCount === 0) {
      // 全て未選択
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (checkedCount === totalCount) {
      // 全て選択
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else {
      // 部分選択
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  }

  // エラーダイアログを表示
  showErrorDialog(message: string, error: Error): void {
    alert(`${message}\n\n${error.message}`);
  }

  // チャプターダイアログを表示
  showChapterDialog(video: Video, chapters: ChapterThumbnail[]): void {
    // 既存のダイアログがあれば削除
    const existingDialog = document.querySelector(".chapter-dialog-overlay");
    if (existingDialog) {
      existingDialog.remove();
    }

    // メインサムネイルを含む全サムネイルリストを作成
    const allThumbnails = [
      {
        path: video.thumbnailPath,
        timestamp: 0,
        title: "メインサムネイル",
        isMain: true,
      },
      ...chapters.map((chapter, index) => ({
        path: chapter.path,
        timestamp: chapter.timestamp || 0,
        title: `Chapter ${index + 1}`,
        isMain: false,
      })),
    ];

    let currentIndex = 0; // 現在表示しているサムネイルのインデックス

    // ダイアログ要素を作成
    const overlay = document.createElement("div");
    overlay.className = "chapter-dialog-overlay";
    overlay.innerHTML = `
      <div id="chapterDialog" class="chapter-dialog" is-open="true">
        <div class="chapter-dialog-header">
          <h3>${FormatUtils.escapeHtml(video.title)} - ${
            allThumbnails[0].title
          }</h3>
          <button class="close-chapter-dialog" title="閉じる">×</button>
        </div>
        <div class="chapter-dialog-content">
          <div class="chapter-viewer">
            <div class="chapter-navigation">
              <button class="nav-btn prev-btn" title="前のサムネイル (←)">‹</button>
              <div class="current-chapter">
                <div class="chapter-image-container">
                  <img id="currentChapterImg" src="file://${
                    allThumbnails[0].path
                  }?t=${Date.now()}" alt="${allThumbnails[0].title}">
                  <div class="chapter-overlay-info">
                    <div class="chapter-counter" id="chapterCounter">1 / ${
                      allThumbnails.length
                    }</div>
                    <div class="chapter-timestamp" id="currentChapterTimestamp">${FormatUtils.formatTimestamp(
                      allThumbnails[0].timestamp,
                    )}</div>
                  </div>
                </div>
              </div>
              <button class="nav-btn next-btn" title="次のサムネイル (→)">›</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // 現在のサムネイルを更新する関数
    const updateCurrentThumbnail = (index: number) => {
      currentIndex = index;
      const thumbnail = allThumbnails[index];

      const img = overlay.querySelector(
        "#currentChapterImg",
      ) as HTMLImageElement;
      const title = overlay.querySelector(
        ".chapter-dialog-header h3",
      ) as HTMLElement;
      const timestamp = overlay.querySelector(
        "#currentChapterTimestamp",
      ) as HTMLElement;
      const counter = overlay.querySelector("#chapterCounter") as HTMLElement;

      if (img && title && timestamp && counter) {
        img.src = `file://${thumbnail.path}?t=${Date.now()}`;
        img.alt = thumbnail.title;
        title.textContent = `${FormatUtils.escapeHtml(video.title)} - ${
          thumbnail.title
        }`;
        timestamp.textContent = FormatUtils.formatTimestamp(
          thumbnail.timestamp,
        );
        counter.textContent = `${index + 1} / ${allThumbnails.length}`;
      }
    };

    // 前のサムネイルに移動
    const gotoPrevious = () => {
      const newIndex =
        currentIndex > 0 ? currentIndex - 1 : allThumbnails.length - 1;
      updateCurrentThumbnail(newIndex);
    };

    // 次のサムネイルに移動
    const gotoNext = () => {
      const newIndex =
        currentIndex < allThumbnails.length - 1 ? currentIndex + 1 : 0;
      updateCurrentThumbnail(newIndex);
    };

    // イベントリスナーを追加
    const closeBtn = overlay.querySelector(
      ".close-chapter-dialog",
    ) as HTMLButtonElement;
    const prevBtn = overlay.querySelector(".prev-btn") as HTMLButtonElement;
    const nextBtn = overlay.querySelector(".next-btn") as HTMLButtonElement;

    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        const chapterDialog = overlay.querySelector("#chapterDialog");
        if (chapterDialog) {
          chapterDialog.removeAttribute("is-open");
        }
        overlay.remove();
        document.removeEventListener("keydown", handleKeydown);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", gotoPrevious);
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", gotoNext);
    }

    // オーバーレイクリックで閉じる
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        const chapterDialog = overlay.querySelector("#chapterDialog");
        if (chapterDialog) {
          chapterDialog.removeAttribute("is-open");
        }
        overlay.remove();
        document.removeEventListener("keydown", handleKeydown);
      }
    });

    // キーボードイベントハンドラー
    const handleKeydown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          const chapterDialog = overlay.querySelector("#chapterDialog");
          if (chapterDialog) {
            chapterDialog.removeAttribute("is-open");
          }
          overlay.remove();
          document.removeEventListener("keydown", handleKeydown);
          break;
        case "ArrowLeft":
          e.preventDefault();
          gotoPrevious();
          break;
        case "ArrowRight":
          e.preventDefault();
          gotoNext();
          break;
      }
    };
    document.addEventListener("keydown", handleKeydown);

    // ダイアログを表示
    document.body.appendChild(overlay);
  }

  // 統計情報を更新
  updateStats(stats: VideoStats): void {
    const statsElements = {
      totalVideos: document.getElementById("totalVideos"),
      totalSize: document.getElementById("totalSize"),
      totalDuration: document.getElementById("totalDuration"),
    };

    if (statsElements.totalVideos) {
      statsElements.totalVideos.textContent = stats.totalVideos.toString();
    }
    if (statsElements.totalSize) {
      statsElements.totalSize.textContent = FormatUtils.formatFileSize(
        stats.totalSize,
      );
    }
    if (statsElements.totalDuration) {
      statsElements.totalDuration.textContent = FormatUtils.formatDuration(
        stats.totalDuration,
      );
    }
  }

  // サムネイル設定を描画
  renderThumbnailSettings(settings: ThumbnailSettings): void {
    const thumbnailCountInput = document.getElementById(
      "thumbnailCount",
    ) as HTMLInputElement;
    const thumbnailIntervalInput = document.getElementById(
      "thumbnailInterval",
    ) as HTMLInputElement;
    const thumbnailWidthInput = document.getElementById(
      "thumbnailWidth",
    ) as HTMLInputElement;
    const thumbnailHeightInput = document.getElementById(
      "thumbnailHeight",
    ) as HTMLInputElement;

    if (thumbnailCountInput) {
      thumbnailCountInput.value = settings.count?.toString() || "5";
    }
    if (thumbnailIntervalInput) {
      thumbnailIntervalInput.value = settings.interval?.toString() || "10";
    }
    if (thumbnailWidthInput) {
      thumbnailWidthInput.value = settings.width?.toString() || "320";
    }
    if (thumbnailHeightInput) {
      thumbnailHeightInput.value = settings.height?.toString() || "180";
    }
  }

  // FPSを適切な桁数で表示するヘルパーメソッド
  private formatFps(fps: number): string {
    if (fps === 0) return "0";

    // 整数かチェック
    if (fps % 1 === 0) {
      return fps.toString();
    }

    // 小数点第一位までで十分かチェック
    const firstDecimal = Math.round(fps * 10) / 10;
    if (Math.abs(fps - firstDecimal) < 0.001) {
      return firstDecimal.toString();
    }

    // 小数点第二位まで表示
    return (Math.round(fps * 100) / 100).toString();
  }

  // 動画を再生（OSの既定のアプリケーションで開く）
  async playVideo(
    videoPath: string,
    playVideoCallback: (path: string) => Promise<void>,
  ): Promise<void> {
    await playVideoCallback(videoPath);
  }

  // 選択された動画を再生
  async playSelectedVideo(
    videos: Video[],
    playVideoCallback: (path: string) => Promise<void>,
  ): Promise<void> {
    if (
      this.selectedVideoIndex >= 0 &&
      this.selectedVideoIndex < videos.length
    ) {
      const selectedVideo = videos[this.selectedVideoIndex];
      await this.playVideo(selectedVideo.path, playVideoCallback);
    }
  }
}
