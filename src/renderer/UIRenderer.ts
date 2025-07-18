import { FormatUtils, DOMUtils } from "./Utils.js";
import { Video, Tag, Directory, ThumbnailSettings } from "./VideoManager.js";

type ViewType = "grid" | "list";

interface ThumbnailInfo {
  src: string;
  label: string;
}

interface Filter {
  tags: string[];
  directories: string[];
  rating: number;
}

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
  renderVideoList(filteredVideos: Video[]): number {
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
      const videoElement = this.createVideoElement(video, index);
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

  // 動画要素を作成
  createVideoElement(video: Video, index: number): HTMLElement {
    const div = document.createElement("div");
    div.className = "video-item";
    div.dataset.index = index.toString();
    div.dataset.videoId = video.id.toString();

    const thumbnailSrc = video.thumbnail_path
      ? `file://${video.thumbnail_path}?t=${Date.now()}`
      : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";

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
          video.added_at ?? new Date().toISOString()
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
      if (video.chapter_thumbnails) {
        let chapters: any[] = [];

        if (Array.isArray(video.chapter_thumbnails)) {
          chapters = video.chapter_thumbnails;
        } else if (typeof video.chapter_thumbnails === "string") {
          try {
            const parsed = JSON.parse(video.chapter_thumbnails);
            if (Array.isArray(parsed)) {
              chapters = parsed;
            } else if (typeof parsed === "object" && parsed !== null) {
              chapters = Object.values(parsed).filter(
                (item: any) =>
                  item &&
                  typeof item === "object" &&
                  (item.path || item.thumbnail_path)
              );
            }
          } catch (error) {
            console.warn("Failed to parse chapter_thumbnails:", error);
          }
        } else if (
          typeof video.chapter_thumbnails === "object" &&
          video.chapter_thumbnails !== null
        ) {
          chapters = Object.values(video.chapter_thumbnails).filter(
            (item: any) =>
              item &&
              typeof item === "object" &&
              (item.path || item.thumbnail_path)
          );
        }

        // Add valid chapter thumbnails (up to 5)
        const validChapters = chapters
          .filter(
            (item: any) =>
              item &&
              typeof item === "object" &&
              (item.path || item.thumbnail_path)
          )
          .slice(0, 5);

        validChapters.forEach((chapter: any, index: number) => {
          const chapterPath = chapter.path || chapter.thumbnail_path;
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
                currentIndex
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
              currentIndex
            );

            // Reset auto-cycle
            if (cycleInterval) {
              clearInterval(cycleInterval);
              cycleInterval = setInterval(() => {
                currentIndex = (currentIndex + 1) % thumbnails.length;
                this.updateThumbnailDisplay(
                  cycleContainer,
                  indicatorContainer,
                  currentIndex
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

    return div;
  }

  // サムネイル表示を更新
  updateThumbnailDisplay(
    cycleContainer: HTMLElement,
    indicatorContainer: HTMLElement,
    activeIndex: number
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
    selectedDirectories: string[]
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
            tag.name
          )}" title="編集">✏️</button>
          <button class="tag-delete-btn" data-tag="${FormatUtils.escapeHtml(
            tag.name
          )}" title="削除">🗑️</button>
        </div>
      `;

      tagsList.appendChild(tagElement);
    });
  }

  // ディレクトリリストを描画
  renderDirectories(
    directories: Directory[],
    selectedDirectories: string[]
  ): void {
    console.log("renderDirectories - directories:", directories.length);
    console.log(
      "renderDirectories - selectedDirectories:",
      selectedDirectories
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
          directory.path
        )}">${FormatUtils.escapeHtml(directoryName)}</span>
        <div class="directory-actions">
          <button class="directory-remove-btn" data-path="${FormatUtils.escapeHtml(
            directory.path
          )}" title="削除">×</button>
        </div>
      `;

      directoriesList.appendChild(directoryElement);
    });
  }

  // 設定画面のディレクトリリストを描画
  renderSettingsDirectories(directories: Directory[]): void {
    const settingsDirectoriesList = document.getElementById(
      "settingsDirectoriesList"
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
          directory.path
        )}">${FormatUtils.escapeHtml(directory.path)}</span>
        <button class="remove-directory-btn" data-path="${FormatUtils.escapeHtml(
          directory.path
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
      isHover
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
  renderVideoDetails(video: Video): void {
    // 詳細パネルを表示
    const detailsPanel = document.getElementById("detailsPanel");
    if (!detailsPanel) {
      console.error("UIRenderer - detailsPanel element not found!");
      return;
    }

    // パネルを表示
    detailsPanel.style.display = "block";

    // メインサムネイルを設定
    const mainThumbnailImg = document.getElementById(
      "detailsMainThumbnail"
    ) as HTMLImageElement;
    if (mainThumbnailImg && video.thumbnail_path) {
      mainThumbnailImg.src = `file://${video.thumbnail_path}?t=${Date.now()}`;
      mainThumbnailImg.alt = video.title;
    }

    // タイトル入力を設定
    const titleInput = document.getElementById(
      "detailsTitleInput"
    ) as HTMLInputElement;
    if (titleInput) {
      titleInput.value = video.title;
    }

    // 説明入力を設定
    const descriptionInput = document.getElementById(
      "detailsDescriptionInput"
    ) as HTMLTextAreaElement;
    if (descriptionInput) {
      descriptionInput.value = video.description || "";
    }

    // ファイル情報を設定
    const filePathElement = document.getElementById("detailsFilePath");
    const fileSizeElement = document.getElementById("detailsFileSize");
    const durationElement = document.getElementById("detailsDuration");
    const resolutionElement = document.getElementById("detailsResolution");
    const fpsElement = document.getElementById("detailsFps");
    const codecElement = document.getElementById("detailsCodec");

    if (filePathElement) filePathElement.textContent = video.path;
    if (fileSizeElement)
      fileSizeElement.textContent = FormatUtils.formatFileSize(video.size ?? 0);
    if (durationElement)
      durationElement.textContent = FormatUtils.formatDuration(
        video.duration ?? 0
      );
    if (resolutionElement)
      resolutionElement.textContent = `${video.width ?? 0}x${
        video.height ?? 0
      }`;
    if (fpsElement) fpsElement.textContent = `${video.fps ?? 0} fps`;
    if (codecElement) codecElement.textContent = video.codec || "不明";

    // タグリストを更新
    this.updateDetailsTagsDisplay(video.tags || []);

    // 評価を設定
    this.updateDetailsRatingDisplay(video.rating || 0);

    // チャプターサムネイルを表示
    this.updateChapterThumbnails(video);
  }

  // チャプターサムネイルを更新
  private updateChapterThumbnails(video: Video): void {
    const chapterContainer = document.getElementById(
      "detailsChapterThumbnails"
    );
    if (!chapterContainer) return;

    chapterContainer.innerHTML = "";

    if (!video.chapter_thumbnails) return;

    let chapters: any[] = [];
    try {
      if (Array.isArray(video.chapter_thumbnails)) {
        chapters = video.chapter_thumbnails;
      } else if (typeof video.chapter_thumbnails === "string") {
        const parsed = JSON.parse(video.chapter_thumbnails);
        if (Array.isArray(parsed)) {
          chapters = parsed;
        } else if (typeof parsed === "object" && parsed !== null) {
          chapters = Object.values(parsed).filter(
            (item: any) => item && (item.path || item.thumbnail_path)
          );
        }
      } else if (
        typeof video.chapter_thumbnails === "object" &&
        video.chapter_thumbnails !== null
      ) {
        chapters = Object.values(video.chapter_thumbnails).filter(
          (item: any) => item && (item.path || item.thumbnail_path)
        );
      }
    } catch (error) {
      console.warn("Failed to parse chapter_thumbnails:", error);
      return;
    }

    // チャプターサムネイルを表示（最大5個）
    chapters.slice(0, 5).forEach((chapter, index) => {
      const chapterPath = chapter.path || chapter.thumbnail_path;
      if (!chapterPath) return;

      const chapterDiv = document.createElement("div");
      chapterDiv.className = "chapter-thumbnail";

      const img = document.createElement("img");
      img.src = `file://${chapterPath}?t=${Date.now()}`;
      img.alt = `Chapter ${index + 1}`;
      img.loading = "lazy";

      chapterDiv.appendChild(img);
      chapterContainer.appendChild(chapterDiv);
    });
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
          tag
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
        "thumbnailQuality"
      ) as HTMLSelectElement;
      const sizeSelect = document.getElementById(
        "thumbnailSize"
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
    this.renderVideoDetails(video);
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
    }
  }

  // 設定モーダルを非表示
  hideSettingsModal(): void {
    const modal = document.getElementById("settingsModal");
    if (modal) {
      modal.style.display = "none";
      modal.classList.remove("settings-modal");
    }
  }

  // 一括タグダイアログを表示
  showBulkTagDialog(videos: Video[], availableTags: string[]): void {
    const modal = document.getElementById("bulkTagModal");
    if (!modal) {
      console.error("bulkTagModal element not found!");
      return;
    }

    modal.style.display = "block";

    // ビデオリストを更新
    const videosList = modal.querySelector("#selectedVideosList");
    if (videosList) {
      videosList.innerHTML = videos
        .map(
          (video) =>
            `<label><input type="checkbox" name="selectedVideos" value="${
              video.id
            }"> ${FormatUtils.escapeHtml(video.title)}</label>`
        )
        .join("");
    }

    // タグリストを更新
    const tagsList = modal.querySelector("#availableTagsList");
    if (tagsList) {
      tagsList.innerHTML = availableTags
        .map(
          (tag) =>
            `<option value="${FormatUtils.escapeHtml(
              tag
            )}">${FormatUtils.escapeHtml(tag)}</option>`
        )
        .join("");
    }
  }

  // 一括タグダイアログを非表示
  hideBulkTagDialog(): void {
    const modal = document.getElementById("bulkTagModal");
    if (modal) {
      modal.style.display = "none";
    }
  }

  // 評価表示を更新
  updateDetailsRatingDisplay(rating: number): void {
    const ratingStars = document.querySelectorAll(".rating-input .star");
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
  }

  // エラーダイアログを表示
  showErrorDialog(message: string, error: Error): void {
    alert(`${message}\n\n${error.message}`);
  }

  // チャプターダイアログを表示
  showChapterDialog(video: Video, chapters: any[]): void {
    // 既存のダイアログがあれば削除
    const existingDialog = document.querySelector(".chapter-dialog-overlay");
    if (existingDialog) {
      existingDialog.remove();
    }

    // メインサムネイルを含む全サムネイルリストを作成
    const allThumbnails = [
      {
        path: video.thumbnail_path,
        timestamp: 0,
        title: "メインサムネイル",
        isMain: true,
      },
      ...chapters.map((chapter, index) => ({
        path: chapter.path || chapter.thumbnail_path,
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
      <div class="chapter-dialog">
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
                      allThumbnails[0].timestamp
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
        "#currentChapterImg"
      ) as HTMLImageElement;
      const title = overlay.querySelector(
        ".chapter-dialog-header h3"
      ) as HTMLElement;
      const timestamp = overlay.querySelector(
        "#currentChapterTimestamp"
      ) as HTMLElement;
      const counter = overlay.querySelector("#chapterCounter") as HTMLElement;

      if (img && title && timestamp && counter) {
        img.src = `file://${thumbnail.path}?t=${Date.now()}`;
        img.alt = thumbnail.title;
        title.textContent = `${FormatUtils.escapeHtml(video.title)} - ${
          thumbnail.title
        }`;
        timestamp.textContent = FormatUtils.formatTimestamp(
          thumbnail.timestamp
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
      ".close-chapter-dialog"
    ) as HTMLButtonElement;
    const prevBtn = overlay.querySelector(".prev-btn") as HTMLButtonElement;
    const nextBtn = overlay.querySelector(".next-btn") as HTMLButtonElement;

    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
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
        overlay.remove();
        document.removeEventListener("keydown", handleKeydown);
      }
    });

    // キーボードイベントハンドラー
    const handleKeydown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
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
  updateStats(stats: any): void {
    const statsElements = {
      totalVideos: document.getElementById("totalVideos"),
      totalSize: document.getElementById("totalSize"),
      totalDuration: document.getElementById("totalDuration"),
    };

    if (statsElements.totalVideos) {
      statsElements.totalVideos.textContent = stats.totalCount.toString();
    }
    if (statsElements.totalSize) {
      statsElements.totalSize.textContent = FormatUtils.formatFileSize(
        stats.totalSize
      );
    }
    if (statsElements.totalDuration) {
      statsElements.totalDuration.textContent = FormatUtils.formatDuration(
        stats.totalDuration
      );
    }
  }

  // サムネイル設定を描画
  renderThumbnailSettings(settings: any): void {
    const thumbnailCountInput = document.getElementById(
      "thumbnailCount"
    ) as HTMLInputElement;
    const thumbnailIntervalInput = document.getElementById(
      "thumbnailInterval"
    ) as HTMLInputElement;
    const thumbnailWidthInput = document.getElementById(
      "thumbnailWidth"
    ) as HTMLInputElement;
    const thumbnailHeightInput = document.getElementById(
      "thumbnailHeight"
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
}
