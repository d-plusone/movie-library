/**
 * 動画データ管理を担当するクラス
 * 動画、タグ、ディレクトリの読み込み、更新、削除を管理
 */
export class VideoManager {
  constructor() {
    this.videos = [];
    this.tags = [];
    this.directories = [];
  }

  // 動画データを読み込み
  async loadVideos() {
    this.videos = await window.electronAPI.getVideos();
    return [...this.videos];
  }

  // タグデータを読み込み
  async loadTags() {
    this.tags = await window.electronAPI.getTags();
    return [...this.tags];
  }

  // ディレクトリデータを読み込み
  async loadDirectories() {
    this.directories = await window.electronAPI.getDirectories();
    return [...this.directories];
  }

  // ディレクトリを追加
  async addDirectory() {
    try {
      const directories = await window.electronAPI.chooseDirectory();
      if (directories && directories.length > 0) {
        const addedDirectories = [];
        for (const directory of directories) {
          await window.electronAPI.addDirectory(directory);
          addedDirectories.push(directory);
        }
        await this.loadDirectories();
        return addedDirectories;
      }
      return [];
    } catch (error) {
      console.error("VideoManager - Error adding directory:", error);
      throw error;
    }
  }

  // ディレクトリを削除
  async removeDirectory(path) {
    try {
      await window.electronAPI.removeDirectory(path);
      await this.loadDirectories();
    } catch (error) {
      console.error("VideoManager - Error removing directory:", error);
      throw error;
    }
  }

  // ディレクトリをスキャン
  async scanDirectories() {
    try {
      await window.electronAPI.scanDirectories();
    } catch (error) {
      console.error("VideoManager - Error scanning directories:", error);
      throw error;
    }
  }

  // サムネイルを生成
  async generateThumbnails() {
    try {
      await window.electronAPI.generateThumbnails();
    } catch (error) {
      console.error("VideoManager - Error generating thumbnails:", error);
      throw error;
    }
  }

  // 全サムネイルを再生成
  async regenerateAllThumbnails() {
    try {
      await window.electronAPI.regenerateAllThumbnails();
    } catch (error) {
      console.error("VideoManager - Error regenerating thumbnails:", error);
      throw error;
    }
  }

  // サムネイル設定を更新
  async updateThumbnailSettings(settings) {
    try {
      await window.electronAPI.updateThumbnailSettings(settings);
    } catch (error) {
      console.error("VideoManager - Error updating thumbnail settings:", error);
      throw error;
    }
  }

  // タグを編集
  async updateTag(oldTagName, newTagName) {
    try {
      await window.electronAPI.updateTag(oldTagName, newTagName);

      // ローカルデータを更新
      const tagIndex = this.tags.findIndex(tag => tag.name === oldTagName);
      if (tagIndex !== -1) {
        this.tags[tagIndex].name = newTagName;
      }

      // 動画のタグも更新
      this.videos.forEach(video => {
        if (video.tags) {
          const tagIndex = video.tags.indexOf(oldTagName);
          if (tagIndex !== -1) {
            video.tags[tagIndex] = newTagName;
          }
        }
      });

      return true;
    } catch (error) {
      console.error("VideoManager - Error updating tag:", error);
      throw error;
    }
  }

  // タグを削除
  async deleteTag(tagName) {
    try {
      // タグを持つ動画を取得
      const videosWithTag = this.videos.filter(
        video => video.tags && video.tags.includes(tagName)
      );

      await window.electronAPI.deleteTag(tagName);

      // ローカルデータを更新
      this.tags = this.tags.filter(tag => tag.name !== tagName);

      // 動画からタグを削除
      this.videos.forEach(video => {
        if (video.tags) {
          video.tags = video.tags.filter(tag => tag !== tagName);
        }
      });

      return videosWithTag;
    } catch (error) {
      console.error("VideoManager - Error deleting tag:", error);
      throw error;
    }
  }

  // 動画にタグを追加
  async addTagToVideo(videoId, tagName) {
    try {
      await window.electronAPI.addTagToVideo(videoId, tagName);
      
      // ローカルの動画データを更新
      const video = this.videos.find(v => v.id === videoId);
      if (video) {
        if (!video.tags) video.tags = [];
        if (!video.tags.includes(tagName)) {
          video.tags.push(tagName);
        }
      }

      // タグリストを再読み込み
      await this.loadTags();
      return true;
    } catch (error) {
      console.error("VideoManager - Error adding tag to video:", error);
      throw error;
    }
  }

  // 動画からタグを削除
  async removeTagFromVideo(videoId, tagName) {
    try {
      await window.electronAPI.removeTagFromVideo(videoId, tagName);
      
      // ローカルの動画データを更新
      const video = this.videos.find(v => v.id === videoId);
      if (video && video.tags) {
        video.tags = video.tags.filter(tag => tag !== tagName);
      }

      return true;
    } catch (error) {
      console.error("VideoManager - Error removing tag from video:", error);
      throw error;
    }
  }

  // 動画詳細を更新
  async updateVideo(videoId, updatedData) {
    try {
      await window.electronAPI.updateVideo(videoId, updatedData);
      
      // ローカルの動画データを更新
      const videoIndex = this.videos.findIndex(v => v.id === videoId);
      if (videoIndex !== -1) {
        Object.assign(this.videos[videoIndex], updatedData);
      }

      return true;
    } catch (error) {
      console.error("VideoManager - Error updating video:", error);
      throw error;
    }
  }

  // 動画を再生
  async playVideo(videoPath) {
    try {
      await window.electronAPI.openVideo(videoPath);
    } catch (error) {
      console.error("VideoManager - Error playing video:", error);
      throw error;
    }
  }

  // 動画追加イベントハンドラ
  async handleVideoAdded(filePath) {
    await this.loadVideos();
    return filePath;
  }

  // 動画削除イベントハンドラ
  async handleVideoRemoved(filePath) {
    await this.loadVideos();
    return filePath;
  }

  // データを取得
  getVideos() {
    return [...this.videos];
  }

  getTags() {
    return [...this.tags];
  }

  getDirectories() {
    return [...this.directories];
  }

  // 特定の動画を取得
  getVideoById(videoId) {
    return this.videos.find(video => video.id === videoId);
  }

  // 特定のタグを取得
  getTagByName(tagName) {
    return this.tags.find(tag => tag.name === tagName);
  }

  // 動画数を取得
  getVideoCount() {
    return this.videos.length;
  }

  // タグ数を取得
  getTagCount() {
    return this.tags.length;
  }

  // ディレクトリ数を取得
  getDirectoryCount() {
    return this.directories.length;
  }
}
