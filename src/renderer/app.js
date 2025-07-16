class MovieLibraryApp {
  constructor() {
    this.videos = [];
    this.filteredVideos = [];
    this.tags = [];
    this.directories = [];
    this.currentVideo = null;
    this.currentView = "grid";
    this.currentSort = { field: "filename", order: "ASC" };
    this.currentFilter = { rating: 0, tags: [] };
    this.selectedVideoIndex = -1;
    this.currentThumbnails = [];
    this.currentThumbnailIndex = 0;
    this.tooltipTimeout = null;
    this.tooltipInterval = null;
    this.currentEditingTag = null;

    this.initializeEventListeners();
    this.loadInitialData();
    this.initializeTheme();
  }

  async loadInitialData() {
    try {
      await this.loadVideos();
      await this.loadTags();
      await this.loadDirectories();
      this.renderVideoList();
      this.renderSidebar();

      // Set initial rating filter to "all"
      const allRatingBtn = document.querySelector(
        '.rating-btn[data-rating="0"]'
      );
      if (allRatingBtn) {
        allRatingBtn.classList.add("active");
      }
    } catch (error) {
      console.error("Error loading initial data:", error);
      this.showErrorDialog("データの読み込みに失敗しました", error);
    }
  }

  initializeEventListeners() {
    // Header actions
    document
      .getElementById("addDirectoryBtn")
      .addEventListener("click", () => this.addDirectory());
    document
      .getElementById("scanDirectoriesBtn")
      .addEventListener("click", () => this.scanDirectories());
    document
      .getElementById("generateThumbnailsBtn")
      .addEventListener("click", () => this.regenerateThumbnails());
    document
      .getElementById("settingsBtn")
      .addEventListener("click", () => this.showSettings());

    // Search
    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", (e) =>
      this.handleSearch(e.target.value)
    );

    // View controls
    document
      .getElementById("gridViewBtn")
      .addEventListener("click", () => this.setView("grid"));
    document
      .getElementById("listViewBtn")
      .addEventListener("click", () => this.setView("list"));

    // Sort controls
    document.getElementById("sortSelect").addEventListener("change", (e) => {
      this.currentSort.field = e.target.value;
      this.applyFiltersAndSort();
    });
    document.getElementById("orderSelect").addEventListener("change", (e) => {
      this.currentSort.order = e.target.value;
      this.applyFiltersAndSort();
    });

    // Rating filter
    document.querySelectorAll(".rating-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // Remove active class from all buttons
        document
          .querySelectorAll(".rating-btn")
          .forEach((b) => b.classList.remove("active"));
        // Add active class to clicked button
        e.target.classList.add("active");

        // Set filter rating
        this.currentFilter.rating = parseInt(e.target.dataset.rating);
        console.log("Rating filter set to:", this.currentFilter.rating); // Debug log

        this.applyFiltersAndSort();
      });
    });

    // Details panel
    document
      .getElementById("closeDetailsBtn")
      .addEventListener("click", () => this.hideDetails());
    document
      .getElementById("saveDetailsBtn")
      .addEventListener("click", () => this.saveVideoDetails());
    document
      .getElementById("playVideoBtn")
      .addEventListener("click", () => this.playCurrentVideo());
    document
      .getElementById("refreshMainThumbnailBtn")
      .addEventListener("click", () => this.refreshMainThumbnail());

    // Rating input
    document.querySelectorAll(".star").forEach((star) => {
      star.addEventListener("click", (e) =>
        this.setRating(parseInt(e.target.dataset.rating))
      );
    });

    // Tag input
    const tagInput = document.getElementById("tagInput");
    tagInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.addTagToCurrentVideo(e.target.value.trim());
        e.target.value = "";
      }
    });

    // Settings modal
    document
      .getElementById("closeSettingsBtn")
      .addEventListener("click", () => this.hideSettings());
    document
      .getElementById("addDirectorySettingsBtn")
      .addEventListener("click", () => this.addDirectory());
    document
      .getElementById("rescanAllBtn")
      .addEventListener("click", () => this.rescanAll());
    document
      .getElementById("regenerateThumbnailsBtn")
      .addEventListener("click", () => this.regenerateThumbnails());
    document
      .getElementById("cleanupThumbnailsBtn")
      .addEventListener("click", () => this.cleanupThumbnails());

    // Thumbnail settings
    document
      .getElementById("thumbnailQuality")
      .addEventListener("change", (e) => this.updateThumbnailSettings());
    document
      .getElementById("thumbnailSize")
      .addEventListener("change", (e) => this.updateThumbnailSettings());

    // Theme settings
    document.getElementById("themeSelect").addEventListener("change", (e) => {
      this.applyTheme(e.target.value);
    });

    // Modal backdrop clicks
    document.getElementById("settingsModal").addEventListener("click", (e) => {
      if (e.target.id === "settingsModal") {
        this.hideSettings();
      }
    });

    // Thumbnail modal events
    document
      .getElementById("closeThumbnailBtn")
      .addEventListener("click", () => this.hideThumbnailModal());
    document
      .getElementById("prevThumbnailBtn")
      .addEventListener("click", () => this.showPreviousThumbnail());
    document
      .getElementById("nextThumbnailBtn")
      .addEventListener("click", () => this.showNextThumbnail());

    document.getElementById("thumbnailModal").addEventListener("click", (e) => {
      if (e.target.id === "thumbnailModal") {
        this.hideThumbnailModal();
      }
    });

    // Error dialog events
    document
      .getElementById("closeErrorBtn")
      .addEventListener("click", () => this.hideErrorDialog());
    document
      .getElementById("errorOkBtn")
      .addEventListener("click", () => this.hideErrorDialog());
    document
      .getElementById("showErrorDetailsBtn")
      .addEventListener("click", () => this.toggleErrorDetails());

    // Tag edit dialog events
    document
      .getElementById("closeTagEditBtn")
      .addEventListener("click", () => this.hideTagEditDialog());
    document
      .getElementById("cancelTagEditBtn")
      .addEventListener("click", () => this.hideTagEditDialog());
    document
      .getElementById("saveTagEditBtn")
      .addEventListener("click", () => this.saveTagEdit());
    document
      .getElementById("tagNameInput")
      .addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.saveTagEdit();
        }
      });

    // Modal backdrop clicks
    document.getElementById("tagEditDialog").addEventListener("click", (e) => {
      if (e.target.id === "tagEditDialog") {
        this.hideTagEditDialog();
      }
    });

    document.getElementById("errorDialog").addEventListener("click", (e) => {
      if (e.target.id === "errorDialog") {
        this.hideErrorDialog();
      }
    });

    // Keyboard navigation
    document.addEventListener("keydown", (e) =>
      this.handleKeyboardNavigation(e)
    );

    // Progress events
    window.electronAPI.onScanProgress((data) => this.handleScanProgress(data));
    window.electronAPI.onThumbnailProgress((data) =>
      this.handleThumbnailProgress(data)
    );
    window.electronAPI.onVideoAdded((filePath) =>
      this.handleVideoAdded(filePath)
    );
    window.electronAPI.onVideoRemoved((filePath) =>
      this.handleVideoRemoved(filePath)
    );
  }

  // Error dialog methods
  showErrorDialog(message, error = null) {
    const errorDialog = document.getElementById("errorDialog");
    const errorMessage = document.getElementById("errorMessage");
    const errorDetails = document.getElementById("errorDetails");
    const showDetailsBtn = document.getElementById("showErrorDetailsBtn");

    errorMessage.textContent = message;

    if (error) {
      const detailsText = error.stack || error.message || error.toString();
      errorDetails.textContent = detailsText;
      showDetailsBtn.style.display = "inline-flex";
    } else {
      errorDetails.textContent = "";
      showDetailsBtn.style.display = "none";
    }

    errorDetails.style.display = "none";
    errorDialog.style.display = "flex";
  }

  hideErrorDialog() {
    document.getElementById("errorDialog").style.display = "none";
  }

  toggleErrorDetails() {
    const errorDetails = document.getElementById("errorDetails");
    const showDetailsBtn = document.getElementById("showErrorDetailsBtn");

    if (errorDetails.style.display === "none") {
      errorDetails.style.display = "block";
      showDetailsBtn.textContent = "詳細を隠す";
    } else {
      errorDetails.style.display = "none";
      showDetailsBtn.textContent = "詳細を表示";
    }
  }

  // Tag edit dialog methods
  showTagEditDialog(tagName) {
    this.currentEditingTag = tagName;
    document.getElementById("tagNameInput").value = tagName;
    document.getElementById("tagEditDialog").style.display = "flex";

    // Focus the input and select all text
    setTimeout(() => {
      const input = document.getElementById("tagNameInput");
      input.focus();
      input.select();
    }, 100);
  }

  hideTagEditDialog() {
    document.getElementById("tagEditDialog").style.display = "none";
    this.currentEditingTag = null;
  }

  async saveTagEdit() {
    const newTagName = document.getElementById("tagNameInput").value.trim();

    if (!newTagName || newTagName === this.currentEditingTag) {
      this.hideTagEditDialog();
      return;
    }

    // Check if tag already exists
    const existingTag = this.tags.find((tag) => tag.name === newTagName);
    if (existingTag) {
      this.showErrorDialog(
        "そのタグ名は既に存在します。別の名前を選択してください。"
      );
      return;
    }

    try {
      await window.electronAPI.updateTag(this.currentEditingTag, newTagName);

      // Update filter if the edited tag was active
      const filterIndex = this.currentFilter.tags.indexOf(
        this.currentEditingTag
      );
      if (filterIndex !== -1) {
        this.currentFilter.tags[filterIndex] = newTagName;
      }

      // Update local data immediately
      const tagIndex = this.tags.findIndex(
        (tag) => tag.name === this.currentEditingTag
      );
      if (tagIndex !== -1) {
        this.tags[tagIndex].name = newTagName;
      }

      // Update videos to use new tag name
      this.videos.forEach((video) => {
        if (video.tags) {
          const tagIndex = video.tags.indexOf(this.currentEditingTag);
          if (tagIndex !== -1) {
            video.tags[tagIndex] = newTagName;
          }
        }
      });

      // Update filtered videos as well
      this.filteredVideos.forEach((video) => {
        if (video.tags) {
          const tagIndex = video.tags.indexOf(this.currentEditingTag);
          if (tagIndex !== -1) {
            video.tags[tagIndex] = newTagName;
          }
        }
      });

      // Update current video if it had this tag
      if (this.currentVideo && this.currentVideo.tags) {
        const tagIndex = this.currentVideo.tags.indexOf(this.currentEditingTag);
        if (tagIndex !== -1) {
          this.currentVideo.tags[tagIndex] = newTagName;
          this.updateTagsDisplay(this.currentVideo.tags);
        }
      }

      // Update UI immediately
      this.renderSidebar();
      this.renderVideoList();
      this.applyFiltersAndSort();

      this.hideTagEditDialog();
      this.showNotification(
        `タグ「${this.currentEditingTag}」を「${newTagName}」に変更しました`,
        "success"
      );
    } catch (error) {
      console.error("Error updating tag:", error);
      this.showErrorDialog("タグの編集に失敗しました", error);
    }
  }

  async loadVideos() {
    this.videos = await window.electronAPI.getVideos();
    this.filteredVideos = [...this.videos];
    this.updateVideoCount();
  }

  async loadTags() {
    this.tags = await window.electronAPI.getTags();
  }

  async loadDirectories() {
    this.directories = await window.electronAPI.getDirectories();
  }

  async addDirectory() {
    try {
      const directories = await window.electronAPI.chooseDirectory();
      if (directories && directories.length > 0) {
        for (const directory of directories) {
          await window.electronAPI.addDirectory(directory);
          this.showNotification(
            `フォルダを追加しました: ${directory}`,
            "success"
          );
        }
        await this.loadDirectories();
        this.renderSidebar();
      }
    } catch (error) {
      console.error("Error adding directory:", error);
      this.showErrorDialog("フォルダの追加に失敗しました", error);
    }
  }

  async removeDirectory(path) {
    try {
      await window.electronAPI.removeDirectory(path);
      await this.loadDirectories();
      this.renderSidebar();
      this.showNotification("フォルダを削除しました", "success");
    } catch (error) {
      console.error("Error removing directory:", error);
      this.showErrorDialog("フォルダの削除に失敗しました", error);
    }
  }

  async scanDirectories() {
    try {
      this.showProgress("ディレクトリをスキャン中...", 0);
      await window.electronAPI.scanDirectories();
    } catch (error) {
      console.error("Error scanning directories:", error);
      this.showErrorDialog("スキャンに失敗しました", error);
      this.hideProgress();
    }
  }

  async generateThumbnails() {
    try {
      this.showProgress("サムネイルを生成中...", 0);
      await window.electronAPI.generateThumbnails();
    } catch (error) {
      console.error("Error generating thumbnails:", error);
      this.showErrorDialog("サムネイル生成に失敗しました", error);
      this.hideProgress();
    }
  }

  handleSearch(query) {
    // Don't modify filteredVideos directly here, let applyFiltersAndSort handle it
    this.applyFiltersAndSort();
  }

  applyFiltersAndSort() {
    let filtered = [...this.videos]; // Start from all videos, not filteredVideos

    // Apply rating filter
    if (this.currentFilter.rating > 0) {
      filtered = filtered.filter(
        (video) => video.rating >= this.currentFilter.rating
      );
    }

    // Search filter (apply after other filters)
    const searchQuery = document.getElementById("searchInput").value.trim();
    if (searchQuery !== "") {
      filtered = filtered.filter(
        (video) =>
          video.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          video.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (video.description &&
            video.description
              .toLowerCase()
              .includes(searchQuery.toLowerCase())) ||
          (video.tags &&
            video.tags.some((tag) =>
              tag.toLowerCase().includes(searchQuery.toLowerCase())
            ))
      );
    }

    // Apply tag filter
    if (this.currentFilter.tags.length > 0) {
      filtered = filtered.filter(
        (video) =>
          video.tags &&
          this.currentFilter.tags.every((tag) => video.tags.includes(tag))
      );
    }

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue = a[this.currentSort.field];
      let bValue = b[this.currentSort.field];

      if (typeof aValue === "string") {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (this.currentSort.order === "ASC") {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    this.filteredVideos = filtered;
    this.renderVideoList();
    this.updateVideoCount();
  }

  setView(view) {
    this.currentView = view;
    document
      .querySelectorAll(".view-btn")
      .forEach((btn) => btn.classList.remove("active"));
    document.getElementById(view + "ViewBtn").classList.add("active");

    const videoList = document.getElementById("videoList");
    videoList.className = `video-list ${view}-view`;
    this.renderVideoList();
    
    // Maintain selected video highlighting after view change
    if (this.selectedVideoIndex >= 0) {
      setTimeout(() => {
        this.highlightSelectedVideo();
      }, 50); // Small delay to ensure DOM is updated
    }
  }

  renderVideoList() {
    const videoList = document.getElementById("videoList");
    videoList.innerHTML = "";

    this.filteredVideos.forEach((video, index) => {
      const videoElement = this.createVideoElement(video, index);
      videoList.appendChild(videoElement);
    });

    // Update selected video if needed
    if (
      this.selectedVideoIndex >= 0 &&
      this.selectedVideoIndex < this.filteredVideos.length
    ) {
      this.highlightSelectedVideo();
    }
  }

  createVideoElement(video, index) {
    const div = document.createElement("div");
    div.className = "video-item";
    div.dataset.index = index;
    div.dataset.videoId = video.id;
    div.addEventListener("click", () => {
      this.selectedVideoIndex = index;
      this.showDetails(video);
      this.highlightSelectedVideo();
    });
    div.addEventListener("dblclick", () => this.playVideo(video));

    // Add mouse events for tooltip
    div.addEventListener("mouseenter", (e) => this.showTooltip(e, video));
    div.addEventListener("mouseleave", () => this.hideTooltip());

    const thumbnailSrc = video.thumbnail_path
      ? `file://${video.thumbnail_path}`
      : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";

    const duration = this.formatDuration(video.duration);
    const fileSize = this.formatFileSize(video.size);
    const rating = "⭐".repeat(video.rating || 0);
    const extension = this.getFileExtension(video.filename);

    // Create video info div
    const videoInfoDiv = document.createElement("div");
    videoInfoDiv.className = "video-info";

    // Create tags container safely
    const tagsContainer = document.createElement("div");
    tagsContainer.className = "video-tags";

    if (video.tags) {
      video.tags.forEach((tag) => {
        const tagSpan = document.createElement("span");
        tagSpan.className = "video-tag";
        tagSpan.textContent = tag;
        tagsContainer.appendChild(tagSpan);
      });
    }

    videoInfoDiv.innerHTML = `
            <div class="video-title">
                ${video.title}
                <span class="video-extension">${extension}</span>
            </div>
            <div class="video-meta">
                <div>サイズ: ${fileSize}</div>
                <div>解像度: ${video.width}x${video.height}</div>
                <div>追加日: ${new Date(video.added_at).toLocaleDateString(
                  "ja-JP"
                )}</div>
            </div>
            <div class="video-rating">${rating}</div>
        `;

    videoInfoDiv.appendChild(tagsContainer);

    div.innerHTML = `
            <div class="video-thumbnail">
                <img src="${thumbnailSrc}" alt="${video.title}" loading="lazy">
                <div class="video-duration">${duration}</div>
            </div>
        `;

    // Add click event to thumbnail for modal
    const thumbnailImg = div.querySelector(".video-thumbnail img");
    thumbnailImg.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent video selection
      if (video.chapterThumbnails && video.chapterThumbnails.length > 0) {
        this.showThumbnailModal(video, 0);
      }
    });

    div.appendChild(videoInfoDiv);

    return div;
  }

  renderTags() {
    const tagsList = document.getElementById("tagsList");
    tagsList.innerHTML = "";

    this.tags.forEach((tag) => {
      const tagElement = document.createElement("div");
      tagElement.className = "tag-item";

      // Check if this tag is currently being filtered
      const isActive = this.currentFilter.tags.includes(tag.name);
      if (isActive) {
        tagElement.classList.add("active");
      }

      // Create tag name span
      const tagNameSpan = document.createElement("span");
      tagNameSpan.className = "tag-name";
      tagNameSpan.textContent = tag.name;
      tagNameSpan.title = "クリックでフィルター";
      tagNameSpan.onclick = () => this.filterByTag(tag.name);

      // Create actions container
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "tag-actions";

      // Edit button
      const editBtn = document.createElement("button");
      editBtn.className = "tag-action-btn edit-btn";
      editBtn.textContent = "✏️";
      editBtn.title = "タグ名を編集";
      editBtn.onclick = () => this.editTag(tag.name);

      // Search button
      const searchBtn = document.createElement("button");
      searchBtn.className = "tag-action-btn search-btn";
      searchBtn.textContent = "🔍";
      searchBtn.title = "このタグでフィルター";
      searchBtn.onclick = () => this.filterByTag(tag.name);

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "tag-action-btn delete-btn";
      deleteBtn.textContent = "×";
      deleteBtn.title = "タグを削除";
      deleteBtn.onclick = () => this.deleteTag(tag.name);

      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(searchBtn);
      actionsDiv.appendChild(deleteBtn);

      tagElement.appendChild(tagNameSpan);
      tagElement.appendChild(actionsDiv);
      tagsList.appendChild(tagElement);
    });
  }

  editTag(tagName) {
    this.showTagEditDialog(tagName);
  }

  async deleteTag(tagName) {
    try {
      // Get videos that have this tag
      const videosWithTag = this.videos.filter(
        (video) => video.tags && video.tags.includes(tagName)
      );

      let confirmMessage = `タグ「${tagName}」を削除しますか？`;
      if (videosWithTag.length > 0) {
        confirmMessage += `\n\n注意: このタグは${
          videosWithTag.length
        }個の動画に設定されています。\n削除すると、これらの動画からもタグが削除されます。\n\n対象動画:\n${videosWithTag
          .slice(0, 5)
          .map((v) => `• ${v.title}`)
          .join("\n")}${
          videosWithTag.length > 5 ? `\n...他${videosWithTag.length - 5}個` : ""
        }`;
      }

      if (confirm(confirmMessage)) {
        await window.electronAPI.deleteTag(tagName);

        // Remove tag from current filter if it's active
        this.currentFilter.tags = this.currentFilter.tags.filter(
          (tag) => tag !== tagName
        );

        // Update local data immediately
        this.tags = this.tags.filter((tag) => tag.name !== tagName);

        // Update videos to remove deleted tag
        this.videos.forEach((video) => {
          if (video.tags) {
            video.tags = video.tags.filter((tag) => tag !== tagName);
          }
        });

        // Update filtered videos as well
        this.filteredVideos.forEach((video) => {
          if (video.tags) {
            video.tags = video.tags.filter((tag) => tag !== tagName);
          }
        });

        // Update current video if it had this tag
        if (this.currentVideo && this.currentVideo.tags) {
          this.currentVideo.tags = this.currentVideo.tags.filter(
            (tag) => tag !== tagName
          );
          this.updateTagsDisplay(this.currentVideo.tags);
        }

        // Update UI immediately
        this.renderSidebar();
        this.renderVideoList();
        this.applyFiltersAndSort();

        this.showNotification(`タグ「${tagName}」を削除しました`, "success");
      }
    } catch (error) {
      console.error("Error deleting tag:", error);
      this.showErrorDialog("タグの削除に失敗しました", error);
    }
  }

  filterByTag(tagName) {
    if (this.currentFilter.tags.includes(tagName)) {
      this.currentFilter.tags = this.currentFilter.tags.filter(
        (tag) => tag !== tagName
      );
    } else {
      this.currentFilter.tags.push(tagName);
    }
    this.renderSidebar(); // Re-render to update active states
    this.applyFiltersAndSort();
  }

  renderSidebar() {
    this.renderTags();
    this.renderDirectories();
  }

  renderDirectories() {
    const directoriesList = document.getElementById("directoriesList");
    directoriesList.innerHTML = "";

    this.directories.forEach((directory) => {
      const directoryElement = document.createElement("div");
      directoryElement.className = "directory-item";
      directoryElement.innerHTML = `
                <span>${directory.name}</span>
                <button class="remove-btn" onclick="movieApp.removeDirectory('${directory.path}')">×</button>
            `;
      directoriesList.appendChild(directoryElement);
    });

    // Also update settings modal
    this.renderSettingsDirectories();
  }

  renderSettingsDirectories() {
    const settingsDirectoriesList = document.getElementById(
      "settingsDirectoriesList"
    );
    if (!settingsDirectoriesList) return;

    settingsDirectoriesList.innerHTML = "";

    this.directories.forEach((directory) => {
      const directoryElement = document.createElement("div");
      directoryElement.className = "settings-directory-item";
      directoryElement.innerHTML = `
                <div class="directory-path">${directory.path}</div>
                <button class="btn btn-icon remove-btn" onclick="movieApp.removeDirectory('${directory.path}')">×</button>
            `;
      settingsDirectoriesList.appendChild(directoryElement);
    });
  }

  showSettings() {
    console.log("Settings button clicked - opening settings modal"); // Debug log
    this.renderSettingsDirectories();
    this.loadThumbnailSettings();
    const modal = document.getElementById("settingsModal");
    if (modal) {
      modal.style.display = "flex";
      console.log("Settings modal display set to flex"); // Debug log
    } else {
      console.error("Settings modal element not found"); // Debug log
    }
  }

  hideSettings() {
    document.getElementById("settingsModal").style.display = "none";
  }

  async rescanAll() {
    if (
      confirm("全ての動画を再スキャンしますか？時間がかかる場合があります。")
    ) {
      await this.scanDirectories();
    }
  }

  async regenerateThumbnails() {
    if (
      confirm("全てのサムネイルを再生成しますか？時間がかかる場合があります。")
    ) {
      await window.electronAPI.regenerateAllThumbnails();
    }
  }

  async updateThumbnailSettings() {
    const quality = parseInt(document.getElementById("thumbnailQuality").value);
    const size = document.getElementById("thumbnailSize").value;
    const [width, height] = size.split("x").map(Number);

    const settings = {
      quality,
      width,
      height,
    };

    await window.electronAPI.updateThumbnailSettings(settings);
    this.showNotification("サムネイル設定を更新しました", "success");
  }

  loadThumbnailSettings() {
    // Load saved settings or use defaults
    document.getElementById("thumbnailQuality").value = "1"; // Default to highest quality
    document.getElementById("thumbnailSize").value = "1280x720"; // Default to HD
  }

  async cleanupThumbnails() {
    if (confirm("不要なサムネイルファイルを削除しますか？")) {
      // This would need to be implemented in the main process
      this.showNotification(
        "サムネイルのクリーンアップが完了しました",
        "success"
      );
    }
  }

  showProgress(text, percent) {
    const progressContainer = document.getElementById("progressContainer");
    const progressText = document.getElementById("progressText");
    const progressPercent = document.getElementById("progressPercent");
    const progressFill = document.getElementById("progressFill");

    progressText.textContent = text;
    progressPercent.textContent = `${Math.round(percent)}%`;
    progressFill.style.width = `${percent}%`;
    progressContainer.style.display = "block";
  }

  hideProgress() {
    document.getElementById("progressContainer").style.display = "none";
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
        this.showNotification(
          `スキャン完了: ${data.count}個の動画を発見`,
          "success"
        );
        this.loadVideos();
        break;
      case "scan-error":
        this.hideProgress();
        this.showNotification(`スキャンエラー: ${data.error}`, "error");
        break;
    }
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
        this.showNotification(
          `サムネイル生成完了: ${data.completed}個`,
          "success"
        );
        this.loadVideos();
        break;
    }
  }

  async handleVideoAdded(filePath) {
    await this.loadVideos();
    this.showNotification(`新しい動画が追加されました: ${filePath}`, "info");
  }

  async handleVideoRemoved(filePath) {
    await this.loadVideos();
    this.showNotification(`動画が削除されました: ${filePath}`, "info");
  }

  updateVideoCount() {
    document.getElementById(
      "videoCount"
    ).textContent = `${this.filteredVideos.length} 動画`;
  }

  showNotification(message, type = "info") {
    const container = document.getElementById("notificationContainer");
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

  formatDuration(seconds) {
    if (!seconds) return "00:00:00";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  getFileExtension(filename) {
    const extension = filename.split(".").pop();
    return extension ? extension.toUpperCase() : "";
  }

  // Tooltip methods
  showTooltip(e, video) {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
    }

    this.tooltipTimeout = setTimeout(() => {
      this.displayTooltip(e, video);
    }, 300); // Show tooltip after 300ms hover
  }

  displayTooltip(e, video) {
    const tooltip = document.getElementById("tooltip");
    const tooltipTitle = document.getElementById("tooltipTitle");
    const tooltipChapters = document.getElementById("tooltipChapters");

    if (!tooltip || !tooltipTitle || !tooltipChapters) {
      console.error("Tooltip elements not found");
      return;
    }

    tooltipTitle.textContent = video.title;

    // Clear previous content and intervals
    if (this.tooltipInterval) {
      clearInterval(this.tooltipInterval);
      this.tooltipInterval = null;
    }

    if (video.chapterThumbnails && video.chapterThumbnails.length > 0) {
      // Create a single image element for cycling through chapters
      tooltipChapters.innerHTML = `
                <div class="tooltip-preview">
                    <img id="tooltipPreviewImage" src="file://${
                      video.chapterThumbnails[0].path
                    }" alt="Preview" loading="lazy">
                    <div class="tooltip-chapter-info">
                        <span id="tooltipCurrentChapter">1 / ${
                          video.chapterThumbnails.length
                        }</span>
                        <span id="tooltipTimestamp">${this.formatDuration(
                          video.chapterThumbnails[0].timestamp
                        )}</span>
                    </div>
                </div>
            `;

      // Start cycling through chapters
      let currentChapterIndex = 0;
      this.tooltipInterval = setInterval(() => {
        currentChapterIndex =
          (currentChapterIndex + 1) % video.chapterThumbnails.length;
        const chapter = video.chapterThumbnails[currentChapterIndex];

        const previewImage = document.getElementById("tooltipPreviewImage");
        const chapterInfo = document.getElementById("tooltipCurrentChapter");
        const timestampInfo = document.getElementById("tooltipTimestamp");

        if (previewImage && chapterInfo && timestampInfo) {
          previewImage.src = `file://${chapter.path}`;
          chapterInfo.textContent = `${currentChapterIndex + 1} / ${
            video.chapterThumbnails.length
          }`;
          timestampInfo.textContent = this.formatDuration(chapter.timestamp);
        }
      }, 1000); // Change every 1 second
    } else {
      tooltipChapters.innerHTML =
        '<div style="color: #ccc; font-size: 12px; text-align: center; padding: 20px;">チャプターサムネイルなし</div>';
    }

    // Reset tooltip styles
    tooltip.style.display = "block";
    tooltip.style.visibility = "visible";
    tooltip.style.opacity = "1";

    // Position tooltip (simplified positioning)
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    // Show tooltip to the right of cursor, then adjust if needed
    let left = mouseX + 15;
    let top = mouseY - 50;

    // Get tooltip dimensions after showing
    const tooltipRect = tooltip.getBoundingClientRect();

    // Adjust if tooltip goes off screen
    if (left + tooltipRect.width > window.innerWidth) {
      left = mouseX - tooltipRect.width - 15;
    }

    if (top + tooltipRect.height > window.innerHeight) {
      top = window.innerHeight - tooltipRect.height - 10;
    }

    if (left < 10) left = 10;
    if (top < 10) top = 10;

    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  hideTooltip() {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }

    if (this.tooltipInterval) {
      clearInterval(this.tooltipInterval);
      this.tooltipInterval = null;
    }

    const tooltip = document.getElementById("tooltip");
    if (tooltip) {
      tooltip.style.display = "none";
      tooltip.style.visibility = "hidden";
      tooltip.style.opacity = "0";
    }
  }

  // Placeholder methods for features not yet fully implemented
  showDetails(video) {
    this.currentVideo = video;
    const detailsPanel = document.getElementById("detailsPanel");

    // Update title
    document.getElementById("detailsTitle").textContent = video.title;

    // Update thumbnails
    const mainThumbnail = document.getElementById("detailsMainThumbnail");
    if (video.thumbnail_path) {
      mainThumbnail.src = `file://${video.thumbnail_path}`;
      mainThumbnail.style.cursor = "pointer";
      mainThumbnail.onclick = () => this.showThumbnailModal(video, 0); // Start with main thumbnail
    } else {
      mainThumbnail.src =
        "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDMyMCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiBmaWxsPSIjRjVGNUY3Ii8+CjxwYXRoIGQ9Ik0xMjggNzJMMTkyIDEwOEwxMjggMTQ0VjcyWiIgZmlsbD0iIzk5OTk5OSIvPgo8L3N2Zz4K";
      mainThumbnail.style.cursor = "default";
      mainThumbnail.onclick = null;
    }

    // Update chapter thumbnails
    const chapterContainer = document.getElementById(
      "detailsChapterThumbnails"
    );
    chapterContainer.innerHTML = "";

    if (video.chapterThumbnails && video.chapterThumbnails.length > 0) {
      video.chapterThumbnails.forEach((chapter, index) => {
        const chapterDiv = document.createElement("div");
        chapterDiv.className = "chapter-thumbnail";
        chapterDiv.addEventListener("click", () =>
          this.showThumbnailModal(video, index + 1)
        ); // +1 to account for main thumbnail
        chapterDiv.innerHTML = `
                    <img src="file://${chapter.path}" alt="Chapter ${
          index + 1
        }">
                `;
        chapterContainer.appendChild(chapterDiv);
      });
    }

    // Update form fields
    document.getElementById("detailsTitleInput").value = video.title || "";
    document.getElementById("detailsDescriptionInput").value =
      video.description || "";

    // Update rating
    this.updateRatingDisplay(video.rating || 0);

    // Update tags
    this.updateTagsDisplay(video.tags || []);

    // Update file info
    document.getElementById("detailsFilePath").textContent = video.path;
    document.getElementById("detailsFileSize").textContent =
      this.formatFileSize(video.size);
    document.getElementById("detailsDuration").textContent =
      this.formatDuration(video.duration);
    document.getElementById(
      "detailsResolution"
    ).textContent = `${video.width}x${video.height}`;
    document.getElementById("detailsFps").textContent = `${
      Math.round(video.fps * 100) / 100
    } fps`;
    document.getElementById("detailsCodec").textContent =
      video.codec || "Unknown";

    detailsPanel.style.display = "flex";
  }

  hideDetails() {
    document.getElementById("detailsPanel").style.display = "none";
    this.currentVideo = null;
  }

  updateRatingDisplay(rating) {
    document.querySelectorAll(".star").forEach((star, index) => {
      star.classList.toggle("active", index < rating);
    });
  }

  setRating(rating) {
    if (this.currentVideo) {
      this.currentVideo.rating = rating;
      this.updateRatingDisplay(rating);
    }
  }

  updateTagsDisplay(tags) {
    const container = document.getElementById("detailsTagsList");
    container.innerHTML = "";

    tags.forEach((tag) => {
      const tagElement = document.createElement("div");
      tagElement.className = "details-tag";

      const tagText = document.createElement("span");
      tagText.textContent = tag;

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-tag-btn";
      removeBtn.textContent = "×";
      removeBtn.onclick = () => this.removeTagFromCurrentVideo(tag);

      tagElement.appendChild(tagText);
      tagElement.appendChild(removeBtn);
      container.appendChild(tagElement);
    });
  }

  async addTagToCurrentVideo(tagName) {
    if (!tagName || !this.currentVideo) return;

    try {
      await window.electronAPI.addTagToVideo(this.currentVideo.id, tagName);
      if (!this.currentVideo.tags) this.currentVideo.tags = [];
      if (!this.currentVideo.tags.includes(tagName)) {
        this.currentVideo.tags.push(tagName);

        // Update the video in main videos array
        const videoIndex = this.videos.findIndex(
          (v) => v.id === this.currentVideo.id
        );
        if (videoIndex !== -1) {
          if (!this.videos[videoIndex].tags) this.videos[videoIndex].tags = [];
          if (!this.videos[videoIndex].tags.includes(tagName)) {
            this.videos[videoIndex].tags.push(tagName);
          }
        }

        // Update filtered videos array
        const filteredVideoIndex = this.filteredVideos.findIndex(
          (v) => v.id === this.currentVideo.id
        );
        if (filteredVideoIndex !== -1) {
          if (!this.filteredVideos[filteredVideoIndex].tags)
            this.filteredVideos[filteredVideoIndex].tags = [];
          if (!this.filteredVideos[filteredVideoIndex].tags.includes(tagName)) {
            this.filteredVideos[filteredVideoIndex].tags.push(tagName);
          }
        }

        this.updateTagsDisplay(this.currentVideo.tags);
        await this.loadTags();
        this.renderSidebar();
        this.renderVideoList(); // Re-render video list to show updated tags
      }
    } catch (error) {
      console.error("Error adding tag:", error);
      this.showErrorDialog("タグの追加に失敗しました", error);
    }
  }

  async removeTagFromCurrentVideo(tagName) {
    if (!this.currentVideo) return;

    try {
      await window.electronAPI.removeTagFromVideo(
        this.currentVideo.id,
        tagName
      );
      if (this.currentVideo.tags) {
        this.currentVideo.tags = this.currentVideo.tags.filter(
          (tag) => tag !== tagName
        );

        // Update the video in main videos array
        const videoIndex = this.videos.findIndex(
          (v) => v.id === this.currentVideo.id
        );
        if (videoIndex !== -1 && this.videos[videoIndex].tags) {
          this.videos[videoIndex].tags = this.videos[videoIndex].tags.filter(
            (tag) => tag !== tagName
          );
        }

        // Update filtered videos array
        const filteredVideoIndex = this.filteredVideos.findIndex(
          (v) => v.id === this.currentVideo.id
        );
        if (
          filteredVideoIndex !== -1 &&
          this.filteredVideos[filteredVideoIndex].tags
        ) {
          this.filteredVideos[filteredVideoIndex].tags = this.filteredVideos[
            filteredVideoIndex
          ].tags.filter((tag) => tag !== tagName);
        }

        this.updateTagsDisplay(this.currentVideo.tags);

        // Check if this tag is no longer used by any video
        const tagStillUsed = this.videos.some(
          (video) => video.tags && video.tags.includes(tagName)
        );
        if (!tagStillUsed) {
          // Remove tag from tags list
          this.tags = this.tags.filter((tag) => tag.name !== tagName);
        }

        this.renderSidebar(); // Update tag list
        this.renderVideoList(); // Re-render video list to show updated tags
      }
    } catch (error) {
      console.error("Error removing tag:", error);
      this.showErrorDialog("タグの削除に失敗しました", error);
    }
  }

  async saveVideoDetails() {
    if (!this.currentVideo) return;

    try {
      const updatedData = {
        title: document.getElementById("detailsTitleInput").value,
        description: document.getElementById("detailsDescriptionInput").value,
        rating: this.currentVideo.rating,
      };

      await window.electronAPI.updateVideo(this.currentVideo.id, updatedData);
      Object.assign(this.currentVideo, updatedData);

      // Update videos array
      const videoIndex = this.videos.findIndex(
        (v) => v.id === this.currentVideo.id
      );
      if (videoIndex !== -1) {
        Object.assign(this.videos[videoIndex], updatedData);
      }

      this.renderVideoList();
      this.showNotification("動画情報を保存しました", "success");
    } catch (error) {
      console.error("Error saving video details:", error);
      this.showErrorDialog("保存に失敗しました", error);
    }
  }

  async playCurrentVideo() {
    if (this.currentVideo) {
      await this.playVideo(this.currentVideo);
    }
  }

  async playVideo(video) {
    try {
      await window.electronAPI.openVideo(video.path);
    } catch (error) {
      console.error("Error playing video:", error);
      this.showErrorDialog("動画の再生に失敗しました", error);
    }
  }

  showThumbnailModal(video, startIndex = 0) {
    this.currentVideo = video;

    // Create combined thumbnails array: main thumbnail + chapter thumbnails
    this.currentThumbnails = [];

    // Add main thumbnail as first item
    if (video.thumbnail_path) {
      this.currentThumbnails.push({
        path: video.thumbnail_path,
        timestamp: 0,
        isMain: true,
      });
    }

    // Add chapter thumbnails
    if (video.chapterThumbnails && video.chapterThumbnails.length > 0) {
      this.currentThumbnails.push(
        ...video.chapterThumbnails.map((chapter) => ({
          ...chapter,
          isMain: false,
        }))
      );
    }

    this.currentThumbnailIndex = startIndex;

    if (this.currentThumbnails.length > 0) {
      this.updateThumbnailDisplay();
      document.getElementById("thumbnailModal").style.display = "flex";
    }
  }

  hideThumbnailModal() {
    document.getElementById("thumbnailModal").style.display = "none";
    this.currentThumbnails = [];
    this.currentThumbnailIndex = 0;
  }

  showPreviousThumbnail() {
    if (this.currentThumbnails.length > 0) {
      this.currentThumbnailIndex =
        (this.currentThumbnailIndex - 1 + this.currentThumbnails.length) %
        this.currentThumbnails.length;
      this.updateThumbnailDisplay();
    }
  }

  showNextThumbnail() {
    if (this.currentThumbnails.length > 0) {
      this.currentThumbnailIndex =
        (this.currentThumbnailIndex + 1) % this.currentThumbnails.length;
      this.updateThumbnailDisplay();
    }
  }

  updateThumbnailDisplay() {
    if (this.currentThumbnails.length === 0) return;

    const thumbnail = this.currentThumbnails[this.currentThumbnailIndex];
    const modalImage = document.getElementById("modalThumbnailImage");
    const modalTitle = document.getElementById("thumbnailModalTitle");
    const modalTimestamp = document.getElementById("thumbnailTimestamp");
    const modalIndex = document.getElementById("thumbnailIndex");

    if (modalImage) modalImage.src = `file://${thumbnail.path}`;
    if (modalTitle) modalTitle.textContent = this.currentVideo.title;

    // Show different text for main thumbnail vs chapter thumbnails
    if (thumbnail.isMain) {
      if (modalTimestamp) modalTimestamp.textContent = "メインサムネイル";
    } else {
      if (modalTimestamp)
        modalTimestamp.textContent = this.formatDuration(thumbnail.timestamp);
    }

    if (modalIndex)
      modalIndex.textContent = `${this.currentThumbnailIndex + 1} / ${
        this.currentThumbnails.length
      }`;
  }

  handleKeyboardNavigation(e) {
    // Don't handle keyboard navigation if an input field is focused
    const activeElement = document.activeElement;
    if (
      activeElement &&
      (activeElement.tagName === "INPUT" ||
        activeElement.tagName === "TEXTAREA" ||
        activeElement.tagName === "SELECT")
    ) {
      return;
    }

    // Handle thumbnail modal navigation
    if (document.getElementById("thumbnailModal").style.display === "flex") {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          this.showPreviousThumbnail();
          break;
        case "ArrowRight":
          e.preventDefault();
          this.showNextThumbnail();
          break;
        case "Escape":
          e.preventDefault();
          this.hideThumbnailModal();
          break;
      }
      return;
    }

    // Don't handle video navigation if any modal is open
    if (
      document.getElementById("settingsModal").style.display === "flex" ||
      document.getElementById("tagEditDialog").style.display === "flex" ||
      document.getElementById("errorDialog").style.display === "flex"
    ) {
      return;
    }

    // Handle video list navigation
    if (this.filteredVideos.length === 0) return;

    if (this.currentView === 'grid') {
      // Grid view: 2D navigation (上下左右で2次元移動)
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          this.navigateVideoGrid('up');
          break;
        case "ArrowDown":
          e.preventDefault();
          this.navigateVideoGrid('down');
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.navigateVideoGrid('left');
          break;
        case "ArrowRight":
          e.preventDefault();
          this.navigateVideoGrid('right');
          break;
        case "Enter":
          e.preventDefault();
          if (this.selectedVideoIndex >= 0) {
            this.playVideo(this.filteredVideos[this.selectedVideoIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          this.hideDetails();
          break;
      }
    } else {
      // List view: 1D navigation (上下と左右両方で上下移動)
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          this.navigateVideo(-1);
          break;
        case "ArrowDown":
          e.preventDefault();
          this.navigateVideo(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          // 左キー = 上に移動
          this.navigateVideo(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          // 右キー = 下に移動
          this.navigateVideo(1);
          break;
        case "Enter":
          e.preventDefault();
          if (this.selectedVideoIndex >= 0) {
            this.playVideo(this.filteredVideos[this.selectedVideoIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          this.hideDetails();
          break;
      }
    }
  }

  navigateVideo(direction) {
    if (this.filteredVideos.length === 0) return;

    if (this.selectedVideoIndex === -1) {
      this.selectedVideoIndex = 0;
    } else {
      this.selectedVideoIndex += direction;
      if (this.selectedVideoIndex < 0) {
        this.selectedVideoIndex = this.filteredVideos.length - 1;
      } else if (this.selectedVideoIndex >= this.filteredVideos.length) {
        this.selectedVideoIndex = 0;
      }
    }

    const video = this.filteredVideos[this.selectedVideoIndex];
    this.showDetails(video);
    this.highlightSelectedVideo();
    this.scrollToSelectedVideo();
  }

  highlightSelectedVideo() {
    // Remove previous highlights
    document.querySelectorAll(".video-item.selected").forEach((item) => {
      item.classList.remove("selected");
    });

    // Add highlight to current selection
    if (this.selectedVideoIndex >= 0) {
      const videoItems = document.querySelectorAll(".video-item");
      if (videoItems[this.selectedVideoIndex]) {
        videoItems[this.selectedVideoIndex].classList.add("selected");
      }
    }
  }

  scrollToSelectedVideo() {
    if (this.selectedVideoIndex >= 0) {
      const videoItems = document.querySelectorAll(".video-item");
      if (videoItems[this.selectedVideoIndex]) {
        videoItems[this.selectedVideoIndex].scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    }
  }

  initializeTheme() {
    // Get saved theme or use system preference
    const savedTheme = localStorage.getItem("theme") || "system";
    this.applyTheme(savedTheme);

    // Set the select value in settings
    const themeSelect = document.getElementById("themeSelect");
    if (themeSelect) {
      themeSelect.value = savedTheme;
    }

    // Listen for system theme changes
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addListener(() => {
        if (localStorage.getItem("theme") === "system") {
          this.applyTheme("system");
        }
      });
    }
  }

  applyTheme(theme) {
    const body = document.body;

    switch (theme) {
      case "dark":
        body.setAttribute("data-theme", "dark");
        break;
      case "light":
        body.removeAttribute("data-theme");
        break;
      case "system":
      default:
        if (
          window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches
        ) {
          body.setAttribute("data-theme", "dark");
        } else {
          body.removeAttribute("data-theme");
        }
        break;
    }

    localStorage.setItem("theme", theme);
  }

  async refreshMainThumbnail() {
    if (!this.currentVideo) {
      this.showNotification("動画が選択されていません", "error");
      return;
    }

    const refreshBtn = document.getElementById("refreshMainThumbnailBtn");
    const mainThumbnail = document.getElementById("detailsMainThumbnail");

    try {
      // Show loading state
      refreshBtn.classList.add("loading");
      refreshBtn.disabled = true;

      this.showNotification("メインサムネイルを更新中...", "info");

      // Request main thumbnail regeneration from backend
      const updatedVideo = await window.electronAPI.regenerateMainThumbnail(this.currentVideo.id);

      if (updatedVideo && updatedVideo.thumbnail_path) {
        // Update current video data
        this.currentVideo.thumbnail_path = updatedVideo.thumbnail_path;

        // Update main thumbnail in details panel with cache busting
        const cacheBreaker = Date.now();
        mainThumbnail.src = `file://${updatedVideo.thumbnail_path}?t=${cacheBreaker}`;

        // Update videos in main array
        const videoIndex = this.videos.findIndex(v => v.id === this.currentVideo.id);
        if (videoIndex !== -1) {
          this.videos[videoIndex].thumbnail_path = updatedVideo.thumbnail_path;
        }

        // Update videos in filtered array
        const filteredVideoIndex = this.filteredVideos.findIndex(v => v.id === this.currentVideo.id);
        if (filteredVideoIndex !== -1) {
          this.filteredVideos[filteredVideoIndex].thumbnail_path = updatedVideo.thumbnail_path;
        }

        // Update video list view if this video is visible
        this.refreshVideoInList(updatedVideo, cacheBreaker);

        // Update thumbnail modal if it's open and showing this video
        if (document.getElementById("thumbnailModal").style.display === "flex" && 
            this.currentThumbnails.length > 0 && this.currentThumbnails[0].isMain) {
          this.currentThumbnails[0].path = updatedVideo.thumbnail_path;
          if (this.currentThumbnailIndex === 0) {
            const modalImage = document.getElementById("modalThumbnailImage");
            if (modalImage) {
              modalImage.src = `file://${updatedVideo.thumbnail_path}?t=${cacheBreaker}`;
            }
          }
        }

        this.showNotification("メインサムネイルを更新しました", "success");
      } else {
        throw new Error("サムネイルの更新に失敗しました");
      }
    } catch (error) {
      console.error("Error refreshing main thumbnail:", error);
      this.showNotification("メインサムネイルの更新に失敗しました", "error");
    } finally {
      // Remove loading state
      refreshBtn.classList.remove("loading");
      refreshBtn.disabled = false;
    }
  }

  refreshVideoInList(updatedVideo, cacheBreaker = Date.now()) {
    // Find and update the video item in the list view
    const videoItems = document.querySelectorAll('.video-item');
    videoItems.forEach(item => {
      if (item.dataset.videoId === updatedVideo.id.toString()) {
        const thumbnail = item.querySelector('.video-thumbnail img');
        if (thumbnail) {
          thumbnail.src = `file://${updatedVideo.thumbnail_path}?t=${cacheBreaker}`;
        }
      }
    });
  }

  getGridColumns() {
    if (this.currentView !== 'grid') return 1;
    
    const videoList = document.getElementById('videoList');
    if (!videoList) return 1;
    
    const videoItems = videoList.querySelectorAll('.video-item');
    if (videoItems.length === 0) return 1;
    
    // Get the computed style to find the actual grid columns
    const computedStyle = window.getComputedStyle(videoList);
    const gridTemplateColumns = computedStyle.getPropertyValue('grid-template-columns');
    
    if (gridTemplateColumns && gridTemplateColumns !== 'none') {
      // Count the number of columns from grid-template-columns
      const columns = gridTemplateColumns.split(' ').length;
      return columns;
    }
    
    // Fallback: calculate based on item positions
    const firstItem = videoItems[0];
    const firstItemRect = firstItem.getBoundingClientRect();
    let columns = 1;
    
    for (let i = 1; i < videoItems.length; i++) {
      const itemRect = videoItems[i].getBoundingClientRect();
      if (Math.abs(itemRect.top - firstItemRect.top) < 10) {
        columns++;
      } else {
        break;
      }
    }
    
    return columns;
  }

  navigateVideoGrid(direction) {
    if (this.filteredVideos.length === 0) return;

    const columns = this.getGridColumns();
    let newIndex = this.selectedVideoIndex;

    if (this.selectedVideoIndex === -1) {
      newIndex = 0;
    } else {
      switch (direction) {
        case 'up':
          newIndex = this.selectedVideoIndex - columns;
          if (newIndex < 0) {
            // Wrap to bottom of the same column
            const column = this.selectedVideoIndex % columns;
            const totalRows = Math.ceil(this.filteredVideos.length / columns);
            newIndex = (totalRows - 1) * columns + column;
            if (newIndex >= this.filteredVideos.length) {
              newIndex -= columns;
            }
          }
          break;
        case 'down':
          newIndex = this.selectedVideoIndex + columns;
          if (newIndex >= this.filteredVideos.length) {
            // Wrap to top of the same column
            newIndex = this.selectedVideoIndex % columns;
          }
          break;
        case 'left':
          if (this.selectedVideoIndex % columns === 0) {
            // Move to rightmost item of the same row
            const row = Math.floor(this.selectedVideoIndex / columns);
            newIndex = Math.min((row + 1) * columns - 1, this.filteredVideos.length - 1);
          } else {
            newIndex = this.selectedVideoIndex - 1;
          }
          break;
        case 'right':
          if ((this.selectedVideoIndex + 1) % columns === 0 || this.selectedVideoIndex === this.filteredVideos.length - 1) {
            // Move to leftmost item of the same row
            const row = Math.floor(this.selectedVideoIndex / columns);
            newIndex = row * columns;
          } else {
            newIndex = this.selectedVideoIndex + 1;
            if (newIndex >= this.filteredVideos.length) {
              const row = Math.floor(this.selectedVideoIndex / columns);
              newIndex = row * columns;
            }
          }
          break;
      }
    }

    this.selectedVideoIndex = newIndex;
    const video = this.filteredVideos[this.selectedVideoIndex];
    this.showDetails(video);
    this.highlightSelectedVideo();
    this.scrollToSelectedVideo();
  }
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.movieApp = new MovieLibraryApp();
});
