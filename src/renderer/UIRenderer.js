import { FormatUtils, DOMUtils } from './Utils.js';

/**
 * UI描画を担当するクラス
 * 動画リスト、サイドバー、設定画面の描画を管理
 */
export class UIRenderer {
  constructor() {
    this.currentView = "grid";
    this.selectedVideoIndex = -1;
  }

  // ビューを設定
  setView(view) {
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
  getCurrentView() {
    return this.currentView;
  }

  // 選択されたビデオのインデックスを取得
  getSelectedVideoIndex() {
    return this.selectedVideoIndex;
  }

  // 選択されたビデオのインデックスを設定
  setSelectedVideoIndex(index) {
    this.selectedVideoIndex = index;
  }

  // 選択されたビデオをハイライト
  highlightSelectedVideo() {
    // Remove existing highlights
    document.querySelectorAll('.video-item.selected').forEach(item => {
      item.classList.remove('selected');
    });

    // Highlight current selection
    if (this.selectedVideoIndex >= 0) {
      const videoItems = document.querySelectorAll('.video-item');
      if (videoItems[this.selectedVideoIndex]) {
        videoItems[this.selectedVideoIndex].classList.add('selected');
      }
    }
  }

  // 動画リストを描画
  renderVideoList(filteredVideos) {
    const videoList = document.getElementById("videoList");
    
    if (!videoList) {
      console.error("UIRenderer - Video list element not found!");
      return;
    }
    
    videoList.innerHTML = "";

    if (filteredVideos.length === 0) {
      const noVideosMsg = document.createElement("div");
      noVideosMsg.className = "no-videos-message";
      noVideosMsg.textContent = "表示する動画がありません";
      videoList.appendChild(noVideosMsg);
      return;
    }

    filteredVideos.forEach((video, index) => {
      const videoElement = this.createVideoElement(video, index);
      videoList.appendChild(videoElement);
    });

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
  createVideoElement(video, index) {
    const div = document.createElement("div");
    div.className = "video-item";
    div.dataset.index = index;
    div.dataset.videoId = video.id;

    const thumbnailSrc = video.thumbnail_path
      ? `file://${video.thumbnail_path}?t=${Date.now()}`
      : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";

    const duration = FormatUtils.formatDuration(video.duration);
    const fileSize = FormatUtils.formatFileSize(video.size);
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
        <div>解像度: ${video.width}x${video.height}</div>
        <div>追加日: ${FormatUtils.formatDate(video.added_at)}</div>
    `;

    const ratingDiv = document.createElement("div");
    ratingDiv.className = "video-rating";
    ratingDiv.textContent = rating;

    // Handle tags display
    if (video.tags && video.tags.length > 0) {
      if (this.currentView === 'grid') {
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
    videoInfoDiv.appendChild(ratingDiv);

    // Create thumbnail div
    const thumbnailDiv = document.createElement("div");
    thumbnailDiv.className = "video-thumbnail";

    const thumbnailImg = document.createElement("img");
    thumbnailImg.src = thumbnailSrc;
    thumbnailImg.alt = video.title;
    thumbnailImg.loading = "lazy";

    const durationDiv = document.createElement("div");
    durationDiv.className = "video-duration";
    durationDiv.textContent = duration;

    thumbnailDiv.appendChild(thumbnailImg);
    thumbnailDiv.appendChild(durationDiv);

    // Assemble the complete video element
    div.appendChild(thumbnailDiv);
    div.appendChild(videoInfoDiv);

    return div;
  }

  // サイドバーを描画
  renderSidebar(tags, directories, currentFilter, selectedDirectories) {
    try {
      // console.log("UIRenderer.renderSidebar called");
      // console.log("Current filter tags:", currentFilter.tags);
      // console.log("Current selected directories:", selectedDirectories);
      this.renderTags(tags, currentFilter.tags);
      this.renderDirectories(directories, selectedDirectories);
    } catch (error) {
      console.error("UIRenderer - Error rendering sidebar:", error);
    }
  }

  // タグリストを描画
  renderTags(tags, activeTagNames = []) {
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
      const isActive = activeTagNames.includes(tag.name);
      if (isActive) {
        tagElement.classList.add("active");
      }

      // Create tag name span
      const tagNameSpan = document.createElement("span");
      tagNameSpan.className = "tag-name";
      tagNameSpan.textContent = tag.name;
      tagNameSpan.title = "クリックでフィルター";

      // Create actions container
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "tag-actions";

      // Edit button
      const editBtn = document.createElement("button");
      editBtn.className = "tag-action-btn edit-btn";
      editBtn.textContent = "✏️";
      editBtn.title = "タグ名を編集";

      // Search button
      const searchBtn = document.createElement("button");
      searchBtn.className = "tag-action-btn search-btn";
      searchBtn.textContent = "🔍";
      searchBtn.title = "このタグでフィルター";

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "tag-action-btn delete-btn";
      deleteBtn.textContent = "×";
      deleteBtn.title = "タグを削除";

      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(searchBtn);
      actionsDiv.appendChild(deleteBtn);

      tagElement.appendChild(tagNameSpan);
      tagElement.appendChild(actionsDiv);
      tagsList.appendChild(tagElement);

      // Store tag name for event handlers
      tagElement.dataset.tagName = tag.name;
    });
  }

  // ディレクトリリストを描画
  renderDirectories(directories, selectedDirectories = []) {
    const directoriesList = document.getElementById("directoriesList");
    
    if (!directoriesList) {
      console.error("UIRenderer - directoriesList element not found!");
      return;
    }
    
    directoriesList.innerHTML = "";

    directories.forEach((directory) => {
      const directoryElement = document.createElement("div");
      directoryElement.className = "directory-item";

      // Check if this directory is currently selected
      const isSelected = selectedDirectories.includes(directory.path);
      if (isSelected) {
        directoryElement.classList.add("active");
      }

      // Create directory name span
      const directoryNameSpan = document.createElement("span");
      directoryNameSpan.className = "directory-name";
      directoryNameSpan.textContent = directory.name;
      directoryNameSpan.title = "クリックで選択/選択解除";

      // Create actions container
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "directory-actions";

      // Remove button
      const removeBtn = document.createElement("button");
      removeBtn.className = "directory-action-btn remove-btn";
      removeBtn.textContent = "×";
      removeBtn.title = "フォルダを削除";

      actionsDiv.appendChild(removeBtn);

      directoryElement.appendChild(directoryNameSpan);
      directoryElement.appendChild(actionsDiv);
      directoriesList.appendChild(directoryElement);

      // Store directory path for event handlers
      directoryElement.dataset.directoryPath = directory.path;
    });
  }

  // 設定画面のディレクトリリストを描画
  renderSettingsDirectories(directories) {
    const settingsDirectoriesList = document.getElementById(
      "settingsDirectoriesList"
    );
    if (!settingsDirectoriesList) return;

    settingsDirectoriesList.innerHTML = "";

    directories.forEach((directory) => {
      const directoryElement = document.createElement("div");
      directoryElement.className = "settings-directory-item";
      directoryElement.innerHTML = `
                <div class="directory-path">${directory.path}</div>
                <button class="btn btn-icon remove-btn" data-directory-path="${directory.path}">×</button>
            `;
      settingsDirectoriesList.appendChild(directoryElement);
    });
  }

  // 星評価表示を更新
  updateStarDisplay(rating, isHover = false) {
    const starElements = document.querySelectorAll('.rating-btn[data-rating]:not([data-rating="0"])');
    const allBtn = document.querySelector('.rating-btn.all-btn[data-rating="0"]');
    

    
    starElements.forEach((star, index) => {
      const starRating = index + 1;
      // Remove any existing hover class
      star.classList.remove('hover');
      
      if (starRating <= rating) {
        star.textContent = '⭐️';
        if (isHover) {
          star.classList.add('hover');
        }
      } else {
        star.textContent = '★';
      }
    });
    
    // Update all button state
    if (allBtn) {
      if (rating === 0 && !isHover) {
        allBtn.classList.add('active');
      } else {
        allBtn.classList.remove('active');
      }
    }
  }

  // ビデオ詳細パネルを描画
  renderVideoDetails(video) {
    const detailsPanel = document.getElementById("detailsPanel");
    if (!detailsPanel) {
      console.error("UIRenderer - detailsPanel not found");
      return;
    }

    // Basic info
    const titleInput = document.getElementById("detailsTitleInput");
    const descriptionInput = document.getElementById("detailsDescriptionInput");
    
    if (titleInput) titleInput.value = video.title || video.filename;
    if (descriptionInput) descriptionInput.value = video.description || "";

    // Main thumbnail
    const mainThumbnail = document.getElementById("detailsMainThumbnail");
    if (mainThumbnail && video.thumbnail_path) {
      // キャッシュバスティングを追加
      const timestamp = Date.now();
      mainThumbnail.src = `file://${video.thumbnail_path}?t=${timestamp}`;
      mainThumbnail.alt = video.title || video.filename;
    }

    // File metadata
    const metadataElements = {
      detailsFilePath: video.path,
      detailsFileSize: FormatUtils.formatFileSize(video.size || 0),
      detailsDuration: FormatUtils.formatDuration(video.duration || 0),
      detailsResolution: video.resolution || "不明",
      detailsFps: video.fps ? `${video.fps} fps` : "不明",
      detailsCodec: video.codec || "不明"
    };

    Object.entries(metadataElements).forEach(([elementId, value]) => {
      const element = document.getElementById(elementId);
      if (element) {
        element.textContent = value;
      }
    });

    // Rating stars
    const ratingStars = detailsPanel.querySelectorAll(".rating-input .star");
    const rating = video.rating || 0;
    ratingStars.forEach((star, index) => {
      star.classList.remove('active', 'hover');
      if (index < rating) {
        star.classList.add('active');
        star.textContent = '⭐';
      } else {
        star.textContent = '☆';
      }
    });

    // Tags
    const tagsContainer = document.getElementById("detailsTagsList");
    if (tagsContainer) {
      tagsContainer.innerHTML = "";
      
      if (video.tags && video.tags.length > 0) {
        video.tags.forEach(tag => {
          const tagElement = document.createElement("span");
          tagElement.className = "video-tag details-tag";
          tagElement.innerHTML = `
            ${FormatUtils.escapeHtml(tag)}
            <button class="remove-tag-btn" data-tag="${FormatUtils.escapeHtml(tag)}" title="タグを削除">×</button>
          `;
          tagsContainer.appendChild(tagElement);
        });
      }
    }

    // Chapter thumbnails (if available)
    this.renderChapterThumbnails(video);


  }

  // チャプターサムネイルを描画
  renderChapterThumbnails(video) {
    const chapterContainer = document.getElementById("detailsChapterThumbnails");
    if (!chapterContainer) {
      console.warn("renderChapterThumbnails - chapter container not found");
      return;
    }

    chapterContainer.innerHTML = "";

    // Ensure video exists and chapter_thumbnails is valid
    if (!video || !video.chapter_thumbnails) {
      const noChaptersMsg = document.createElement("div");
      noChaptersMsg.className = "no-chapters-message";
      noChaptersMsg.textContent = "チャプターサムネイルがありません";
      chapterContainer.appendChild(noChaptersMsg);
      return;
    }

    // Convert to array if it's not already an array
    let chapters = [];
    if (Array.isArray(video.chapter_thumbnails)) {
      chapters = video.chapter_thumbnails;
    } else if (typeof video.chapter_thumbnails === 'object' && video.chapter_thumbnails !== null) {
      // If it's an object, try to extract values or convert to array
      chapters = Object.values(video.chapter_thumbnails).filter(item => 
        item && typeof item === 'object' && item.path && item.timestamp !== undefined
      );
    } else if (typeof video.chapter_thumbnails === 'string') {
      // If it's a string, try to parse as JSON
      try {
        const parsed = JSON.parse(video.chapter_thumbnails);
        if (Array.isArray(parsed)) {
          chapters = parsed;
        } else if (typeof parsed === 'object' && parsed !== null) {
          chapters = Object.values(parsed).filter(item => 
            item && typeof item === 'object' && item.path && item.timestamp !== undefined
          );
        }
      } catch (error) {
        console.warn("Failed to parse chapter_thumbnails as JSON:", error);
      }
    } else {
      console.warn("chapter_thumbnails is not an array, object, or string:", typeof video.chapter_thumbnails, video.chapter_thumbnails);
    }

    if (chapters.length > 0) {
      chapters.forEach((thumbnail, index) => {
        if (!thumbnail || !thumbnail.path) {
          console.warn("Invalid thumbnail object at index", index, ":", thumbnail);
          return;
        }

        const chapterElement = document.createElement("div");
        chapterElement.className = "chapter-thumbnail";
        chapterElement.innerHTML = `
          <img src="file://${thumbnail.path}" alt="Chapter ${index + 1}" loading="lazy">
          <div class="chapter-time">${FormatUtils.formatDuration(thumbnail.timestamp || 0)}</div>
        `;
        
        // Add click event to open thumbnail modal
        chapterElement.addEventListener("click", () => {
          if (window.movieApp && window.movieApp.currentVideo) {
            // Pass the chapter index (index in chapter array, not including main thumbnail)
            window.movieApp.showThumbnailModal(window.movieApp.currentVideo, index);
          }
        });
        
        chapterContainer.appendChild(chapterElement);
      });
    } else {
      // Show message if no chapter thumbnails available
      const noChaptersMsg = document.createElement("div");
      noChaptersMsg.className = "no-chapters-message";
      noChaptersMsg.textContent = "チャプターサムネイルがありません";
      chapterContainer.appendChild(noChaptersMsg);
    }
  }

  // 動画ツールチップ表示メソッド（チャプター自動切り替え機能付き）
  showVideoTooltip(event, video) {
    const tooltip = document.getElementById("videoTooltip");
    if (!tooltip) return;

    // チャプターサムネイルが利用可能かチェック
    let chapters = [];
    if (video.chapter_thumbnails) {
      if (Array.isArray(video.chapter_thumbnails)) {
        chapters = video.chapter_thumbnails.slice(0, 5); // 最大5つまで
      } else if (typeof video.chapter_thumbnails === 'string') {
        try {
          const parsed = JSON.parse(video.chapter_thumbnails);
          if (Array.isArray(parsed)) {
            chapters = parsed.slice(0, 5);
          } else if (typeof parsed === 'object' && parsed !== null) {
            chapters = Object.values(parsed).filter(item => 
              item && typeof item === 'object' && item.path && item.timestamp !== undefined
            ).slice(0, 5);
          }
        } catch (error) {
          // JSON解析失敗時は空配列のまま
        }
      } else if (typeof video.chapter_thumbnails === 'object') {
        chapters = Object.values(video.chapter_thumbnails).filter(item => 
          item && typeof item === 'object' && item.path && item.timestamp !== undefined
        ).slice(0, 5);
      }
    }

    // チャプターがある場合は自動切り替え、ない場合は通常のサムネイル表示
    if (chapters.length > 0) {
      this.showAutoSwitchingTooltip(event, video, chapters);
    } else {
      this.showStaticTooltip(event, video);
    }
  }

  // 静的ツールチップ表示（チャプターがない場合）
  showStaticTooltip(event, video) {
    const tooltip = document.getElementById("videoTooltip");
    if (!tooltip) return;

    // ツールチップの内容をクリア
    tooltip.innerHTML = "";
    
    // サムネイル画像を作成
    const img = document.createElement("img");
    img.src = video.thumbnail_path ? `file://${video.thumbnail_path}` : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";
    img.alt = video.title || video.filename;
    img.style.maxWidth = "200px";
    img.style.maxHeight = "120px";
    img.style.objectFit = "cover";
    img.style.borderRadius = "4px";
    img.style.display = "block";
    img.style.marginBottom = "8px";
    
    // 情報（時間、サイズ、評価のみ）
    const infoDiv = document.createElement("div");
    const info = [];
    if (video.duration) {
      info.push(`時間: ${FormatUtils.formatDuration(video.duration)}`);
    }
    if (video.size) {
      info.push(`サイズ: ${FormatUtils.formatFileSize(video.size)}`);
    }
    if (video.rating > 0) {
      info.push(`評価: ${"★".repeat(video.rating)}${"☆".repeat(5 - video.rating)}`);
    }
    infoDiv.textContent = info.join(" | ");
    infoDiv.style.fontSize = "12px";
    infoDiv.style.textAlign = "center";
    
    // ツールチップに追加
    tooltip.appendChild(img);
    tooltip.appendChild(infoDiv);
    
    this.setupTooltipDisplay(tooltip, event);
  }

  // 自動切り替えツールチップ表示（チャプターがある場合）
  showAutoSwitchingTooltip(event, video, chapters) {
    const tooltip = document.getElementById("videoTooltip");
    if (!tooltip) return;

    // 既存の自動切り替えがあればクリア
    if (tooltip._autoSwitchInterval) {
      clearInterval(tooltip._autoSwitchInterval);
      tooltip._autoSwitchInterval = null;
    }

    // 現在の動画IDを保存（混在防止）
    tooltip._currentVideoId = video.id;

    // チャプターサムネイルのみを使用（メインサムネイルは除外）
    const allThumbnails = [];
    
    // チャプターサムネイルを追加（最大5つまで）
    chapters.slice(0, 5).forEach((chapter, index) => {
      allThumbnails.push({
        path: chapter.path,
        isMain: false,
        timestamp: chapter.timestamp || 0,
        label: `チャプター ${index + 1}`
      });
    });

    let currentIndex = 0;
    let autoSwitchInterval = null;

    const showThumbnail = (index) => {
      // 動画が変わった場合は処理を停止
      if (tooltip._currentVideoId !== video.id) {
        if (tooltip._autoSwitchInterval) {
          clearInterval(tooltip._autoSwitchInterval);
          tooltip._autoSwitchInterval = null;
        }
        return;
      }

      // ツールチップの内容をクリア
      tooltip.innerHTML = "";
      
      // インデックスが範囲外の場合は最初に戻る
      if (index >= allThumbnails.length) index = 0;
      
      const thumbnail = allThumbnails[index];
      
      // チャプター番号表示
      const chapterInfo = document.createElement("div");
      chapterInfo.style.fontSize = "10px";
      chapterInfo.style.textAlign = "center";
      chapterInfo.style.marginBottom = "4px";
      chapterInfo.style.color = "#ccc";
      chapterInfo.textContent = thumbnail.label;
      
      // サムネイル画像を作成
      const img = document.createElement("img");
      img.src = `file://${thumbnail.path}`;
      img.alt = thumbnail.label;
      img.style.maxWidth = "200px";
      img.style.maxHeight = "120px";
      img.style.objectFit = "cover";
      img.style.borderRadius = "4px";
      img.style.display = "block";
      img.style.marginBottom = "8px";
      
      // 情報（時間、サイズ、評価のみ）
      const infoDiv = document.createElement("div");
      const info = [];
      if (video.duration) {
        info.push(`時間: ${FormatUtils.formatDuration(video.duration)}`);
      }
      if (video.size) {
        info.push(`サイズ: ${FormatUtils.formatFileSize(video.size)}`);
      }
      if (video.rating > 0) {
        info.push(`評価: ${"★".repeat(video.rating)}${"☆".repeat(5 - video.rating)}`);
      }
      infoDiv.textContent = info.join(" | ");
      infoDiv.style.fontSize = "12px";
      infoDiv.style.textAlign = "center";
      
      // ツールチップに追加
      tooltip.appendChild(chapterInfo);
      tooltip.appendChild(img);
      tooltip.appendChild(infoDiv);
    };

    // 最初のチャプターを表示
    showThumbnail(0);
    
    // 自動切り替えを開始（1.5秒間隔）
    autoSwitchInterval = setInterval(() => {
      currentIndex = (currentIndex + 1) % allThumbnails.length;
      showThumbnail(currentIndex);
    }, 1500);

    // ツールチップが非表示になったときに自動切り替えを停止
    tooltip._autoSwitchInterval = autoSwitchInterval;
    
    this.setupTooltipDisplay(tooltip, event);
  }

  // ツールチップの表示設定と位置調整
  setupTooltipDisplay(tooltip, event) {
    // ツールチップのスタイルを設定
    tooltip.style.display = "block";
    tooltip.style.position = "fixed";
    tooltip.style.zIndex = "9999";
    tooltip.style.backgroundColor = "rgba(0, 0, 0, 0.9)";
    tooltip.style.color = "white";
    tooltip.style.padding = "12px";
    tooltip.style.borderRadius = "8px";
    tooltip.style.fontSize = "12px";
    tooltip.style.pointerEvents = "none";
    tooltip.style.maxWidth = "220px";
    
    // マウス位置に追従
    const updatePosition = (e) => {
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      let left = e.clientX + 15;
      let top = e.clientY - tooltipRect.height - 15;
      
      // 右端チェック
      if (left + tooltipRect.width > viewportWidth) {
        left = e.clientX - tooltipRect.width - 15;
      }
      
      // 下端チェック（上に表示できない場合は下に）
      if (top < 0) {
        top = e.clientY + 15;
      }
      
      // 左端チェック
      if (left < 0) {
        left = 10;
      }
      
      // 下端チェック（下に表示した場合）
      if (top + tooltipRect.height > viewportHeight) {
        top = viewportHeight - tooltipRect.height - 10;
      }
      
      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
    };
    
    updatePosition(event);
    
    // Store the update function for later removal
    tooltip._updatePosition = updatePosition;
    document.addEventListener("mousemove", updatePosition);
  }

  // チャプターサムネイル用のツールチップ表示メソッド（切り替え可能）


  // ツールチップ表示メソッド
  showTooltip(event, text) {
    const tooltip = document.getElementById("videoTooltip");
    if (!tooltip) return;

    tooltip.textContent = text;
    tooltip.style.display = "block";
    tooltip.style.position = "fixed";
    tooltip.style.zIndex = "9999";
    tooltip.style.backgroundColor = "rgba(0, 0, 0, 0.9)";
    tooltip.style.color = "white";
    tooltip.style.padding = "8px 12px";
    tooltip.style.borderRadius = "4px";
    tooltip.style.fontSize = "12px";
    tooltip.style.whiteSpace = "nowrap";
    tooltip.style.pointerEvents = "none";
    
    // マウス位置に追従
    const updatePosition = (e) => {
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      let left = e.clientX + 10;
      let top = e.clientY - tooltipRect.height - 10;
      
      // 右端チェック
      if (left + tooltipRect.width > viewportWidth) {
        left = e.clientX - tooltipRect.width - 10;
      }
      
      // 下端チェック（上に表示できない場合は下に）
      if (top < 0) {
        top = e.clientY + 10;
      }
      
      // 左端チェック
      if (left < 0) {
        left = 10;
      }
      
      // 下端チェック（下に表示した場合）
      if (top + tooltipRect.height > viewportHeight) {
        top = viewportHeight - tooltipRect.height - 10;
      }
      
      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
    };
    
    updatePosition(event);
    
    // Store the update function for later removal
    tooltip._updatePosition = updatePosition;
    document.addEventListener("mousemove", updatePosition);
  }

  hideTooltip() {
    const tooltip = document.getElementById("videoTooltip");
    if (!tooltip) return;

    tooltip.style.display = "none";
    tooltip.style.pointerEvents = "none"; // ツールチップを非表示時にクリック不可にする
    
    // Remove the mousemove listener if it exists
    if (tooltip._updatePosition) {
      document.removeEventListener("mousemove", tooltip._updatePosition);
      tooltip._updatePosition = null;
    }
    
    // Clear auto-switch interval if it exists
    if (tooltip._autoSwitchInterval) {
      clearInterval(tooltip._autoSwitchInterval);
      tooltip._autoSwitchInterval = null;
    }
    
    // Clear current video ID
    tooltip._currentVideoId = null;
  }

  // ビデオ数を更新
  updateVideoCount(count) {
    const countElement = document.getElementById("videoCount");
    if (countElement) {
      countElement.textContent = `${count}件の動画`;
    }
  }

  // 詳細パネルのタグ表示を更新
  updateDetailsTagsDisplay(tags) {
    const tagsContainer = document.getElementById("detailsTagsList");
    if (!tagsContainer) return;
    
    tagsContainer.innerHTML = "";
    
    if (tags && tags.length > 0) {
      tags.forEach(tag => {
        const tagElement = document.createElement("span");
        tagElement.className = "video-tag details-tag";
        tagElement.innerHTML = `
          ${FormatUtils.escapeHtml(tag)}
          <button class="remove-tag-btn" data-tag="${FormatUtils.escapeHtml(tag)}" title="タグを削除">×</button>
        `;
        tagsContainer.appendChild(tagElement);
      });
    }
  }
}
