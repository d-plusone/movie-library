/**
 * 動画、タグ、ディレクトリの読み込み、更新、削除を管理
 */

import type {
  Video,
  Directory,
  Tag,
  ScanResult,
  ThumbnailSettings,
} from "../types/types";
import type {} from "../types/electron";

export class VideoManager {
  private videos: Video[] = [];
  private tags: Tag[] = [];
  private directories: Directory[] = [];
  private hasChanges: boolean = false; // データ変更フラグを追加
  private lastLoadTime: number | null = null; // 最後のロード時間を追加

  constructor() {
    this.videos = [];
    this.tags = [];
    this.directories = [];
    this.hasChanges = false;
    this.lastLoadTime = null;
  }

  // 動画データを読み込み（差分取得対応）
  async loadVideos(forceReload: boolean = false): Promise<Video[]> {
    try {
      // 強制リロードでない場合は、変更チェックを行う
      if (!forceReload && this.lastLoadTime) {
        const hasUpdates = await window.electronAPI.hasVideoUpdates(
          this.lastLoadTime
        );
        if (!hasUpdates) {
          console.log(
            "VideoManager: No video updates detected, using cached data"
          );
          this.hasChanges = false;
          return [...this.videos];
        }
      }

      console.log("VideoManager: Loading videos from database");
      const electronVideos = await window.electronAPI.getVideos();
      console.log(
        "VideoManager: Received videos from electronAPI:",
        electronVideos.length,
        electronVideos.slice(0, 2)
      );

      // 最初の動画の詳細な情報をログ出力（BigInt対応）
      if (electronVideos.length > 0) {
        console.log(
          "VideoManager: First video detailed:",
          JSON.stringify(
            electronVideos[0],
            (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            2
          )
        );
      }

      // electronAPIの型をVideoManager.tsの型にマッピング
      this.videos = electronVideos.map((video) => ({
        ...video,
        id: typeof video.id === "string" ? parseInt(video.id) : video.id,
        size: video.size,
        width: video.width || 0,
        height: video.height || 0,
        chapterThumbnails: video.chapterThumbnails,
      }));
      console.log(
        "VideoManager: Processed videos:",
        this.videos.length,
        this.videos.slice(0, 2)
      );

      // 最初の動画の処理後詳細情報をログ出力（BigInt対応）
      if (this.videos.length > 0) {
        console.log(
          "VideoManager: First processed video detailed:",
          JSON.stringify(
            this.videos[0],
            (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            2
          )
        );

        // チャプターサムネイルのデバッグ情報
        const firstVideo = this.videos[0];
        console.log(
          "VideoManager: First video chapterThumbnails:",
          firstVideo.chapterThumbnails
        );
        console.log(
          "VideoManager: First video chapterThumbnails type:",
          typeof firstVideo.chapterThumbnails
        );

        // チャプターサムネイルがある動画を探してログ出力
        const videoWithChapters = this.videos.find((v) => v.chapterThumbnails);
        if (videoWithChapters) {
          console.log(
            "VideoManager: Found video with chapters:",
            videoWithChapters.id,
            videoWithChapters.title
          );
          console.log(
            "VideoManager: Chapter data:",
            videoWithChapters.chapterThumbnails
          );
          console.log(
            "VideoManager: Chapter data type:",
            typeof videoWithChapters.chapterThumbnails
          );
        } else {
          console.log("VideoManager: No videos with chapterThumbnails found");
        }
      }
      this.lastLoadTime = Date.now();
      this.hasChanges = true;
      return [...this.videos];
    } catch (error) {
      console.error("VideoManager: Error loading videos:", error);
      // フォールバック: エラーの場合は既存のデータを返す
      this.hasChanges = false;
      return [...this.videos];
    }
  }

  // タグデータを読み込み（差分取得対応）
  async loadTags(forceReload: boolean = false): Promise<Tag[]> {
    try {
      if (!forceReload && this.lastLoadTime) {
        // タグの場合は簡単な差分チェック（実装を簡素化するため、現在は全件取得）
        console.log("VideoManager: Loading tags from database");
      }

      this.tags = (await window.electronAPI.getTags()).map((tag) => ({
        ...tag,
        id: tag.id ? parseInt(tag.id) : undefined,
        count: tag.count || 0,
      }));
      return [...this.tags];
    } catch (error) {
      console.error("VideoManager: Error loading tags:", error);
      return [...this.tags];
    }
  }

  // ディレクトリデータを読み込み（差分取得対応）
  async loadDirectories(forceReload: boolean = false): Promise<Directory[]> {
    try {
      if (!forceReload && this.lastLoadTime) {
        console.log("VideoManager: Loading directories from database");
      }

      const electronDirectories = await window.electronAPI.getDirectories();
      // electronAPIの型をVideoManager.tsの型にマッピング
      this.directories = electronDirectories.map(
        (dir: { path: string; name: string; addedAt?: Date }) => ({
          ...dir,
          name: dir.name || dir.path.split("/").pop() || "Unknown",
          addedAt: dir.addedAt || new Date(),
        })
      );
      return [...this.directories];
    } catch (error) {
      console.error("VideoManager: Error loading directories:", error);
      return [...this.directories];
    }
  }

  // ディレクトリを追加
  async addDirectory(): Promise<string[]> {
    try {
      const directoryPaths = await window.electronAPI.chooseDirectory();
      if (directoryPaths && directoryPaths.length > 0) {
        for (const path of directoryPaths) {
          await window.electronAPI.addDirectory(path);
        }
        await this.loadDirectories();
        this.hasChanges = true;
        return directoryPaths;
      }
      return [];
    } catch (error) {
      console.error("VideoManager - Error adding directory:", error);
      throw error;
    }
  }

  // ディレクトリを削除
  async removeDirectory(path: string): Promise<void> {
    try {
      await window.electronAPI.removeDirectory(path);
      await this.loadDirectories();
      this.hasChanges = true;
    } catch (error) {
      console.error("VideoManager - Error removing directory:", error);
      throw error;
    }
  }

  // データ変更状態を取得
  hasDataChanges(): boolean {
    return this.hasChanges;
  }

  // データ変更状態をリセット
  resetDataChanges(): void {
    this.hasChanges = false;
  }

  // ディレクトリをスキャン
  async scanDirectories(): Promise<ScanResult | void> {
    console.log("VideoManager.scanDirectories called");
    console.log("electronAPI available:", !!window.electronAPI);
    console.log(
      "electronAPI.scanDirectories available:",
      !!window.electronAPI?.scanDirectories
    );

    try {
      console.log("Calling window.electronAPI.scanDirectories()");
      const result = await window.electronAPI.scanDirectories();
      console.log(
        "window.electronAPI.scanDirectories() completed successfully:",
        result
      );
      return result;
    } catch (error) {
      console.error("VideoManager - Error scanning directories:", error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
  }

  // サムネイルを生成
  async generateThumbnails(): Promise<void> {
    console.log("VideoManager.generateThumbnails called");
    console.log("electronAPI available:", !!window.electronAPI);
    console.log(
      "electronAPI.generateThumbnails available:",
      !!window.electronAPI?.generateThumbnails
    );

    try {
      console.log("Calling window.electronAPI.generateThumbnails()");
      await window.electronAPI.generateThumbnails();
      console.log(
        "window.electronAPI.generateThumbnails() completed successfully"
      );
    } catch (error) {
      console.error("VideoManager - Error generating thumbnails:", error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
  }

  // 全サムネイルを再生成
  async regenerateAllThumbnails(): Promise<void> {
    console.log("VideoManager.regenerateAllThumbnails called");
    console.log("electronAPI available:", !!window.electronAPI);
    console.log(
      "electronAPI.regenerateAllThumbnails available:",
      !!window.electronAPI?.regenerateAllThumbnails
    );

    try {
      console.log("Calling window.electronAPI.regenerateAllThumbnails()");
      await window.electronAPI.regenerateAllThumbnails();
      console.log(
        "window.electronAPI.regenerateAllThumbnails() completed successfully"
      );
    } catch (error) {
      console.error("VideoManager - Error regenerating thumbnails:", error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
  }

  // 全ての動画を強制的に再スキャン
  async rescanAllVideos(): Promise<ScanResult | void> {
    console.log("VideoManager.rescanAllVideos called");

    console.log(
      "electronAPI.rescanAllVideos available:",
      !!window.electronAPI?.rescanAllVideos
    );

    try {
      console.log("Calling window.electronAPI.rescanAllVideos()");
      const result = await window.electronAPI.rescanAllVideos();
      console.log(
        "window.electronAPI.rescanAllVideos() completed successfully:",
        result
      );
      return result;
    } catch (error) {
      console.error("VideoManager - Error rescanning all videos:", error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
  }

  // サムネイル設定を更新
  async updateThumbnailSettings(settings: ThumbnailSettings): Promise<void> {
    try {
      // electronAPIに合わせて型を変換
      let electronSettings = {
        quality: settings.quality || 1,
        width: settings.width || 320,
        height: settings.height || 180,
        ...settings,
      };

      // sizeプロパティがある場合は、widthとheightに変換
      if (settings.size && typeof settings.size === "string") {
        const sizeParts = settings.size.split("x");
        if (sizeParts.length === 2) {
          electronSettings.width = parseInt(sizeParts[0]);
          electronSettings.height = parseInt(sizeParts[1]);
        }
      }

      console.log("Updating thumbnail settings:", electronSettings);
      await window.electronAPI.updateThumbnailSettings(electronSettings);
    } catch (error) {
      console.error("VideoManager - Error updating thumbnail settings:", error);
      throw error;
    }
  }

  // タグを編集
  async updateTag(oldTagName: string, newTagName: string): Promise<void> {
    try {
      await window.electronAPI.updateTag(oldTagName, newTagName);

      // ローカルキャッシュでタグ名を更新
      const tagIndex = this.tags.findIndex((tag) => tag.name === oldTagName);
      if (tagIndex !== -1) {
        this.tags[tagIndex].name = newTagName;
      }

      // 動画データ内のタグも更新
      this.videos.forEach((video) => {
        if (video.tags) {
          const videoTagIndex = video.tags.indexOf(oldTagName);
          if (videoTagIndex !== -1) {
            video.tags[videoTagIndex] = newTagName;
          }
        }
      });

      this.hasChanges = true;
    } catch (error) {
      console.error("VideoManager - Error updating tag:", error);
      // エラーの場合は最新のデータを再取得
      await this.loadTags(true);
      await this.loadVideos(true);
      throw error;
    }
  }

  // タグを削除
  async deleteTag(tagName: string): Promise<void> {
    try {
      await window.electronAPI.deleteTag(tagName);

      // ローカルキャッシュからタグを削除
      this.tags = this.tags.filter((tag) => tag.name !== tagName);

      // 動画データからもタグを削除
      this.videos.forEach((video) => {
        if (video.tags) {
          video.tags = video.tags.filter((tag) => tag !== tagName);
        }
      });

      this.hasChanges = true;
    } catch (error) {
      console.error("VideoManager - Error deleting tag:", error);
      // エラーの場合は最新のデータを再取得
      await this.loadTags(true);
      await this.loadVideos(true);
      throw error;
    }
  }

  // 動画にタグを追加
  async addTagToVideo(videoId: number, tagName: string): Promise<void> {
    try {
      await window.electronAPI.addTagToVideo(videoId.toString(), tagName);

      // ローカルキャッシュを更新
      const video = this.videos.find((v) => v.id === videoId);
      if (video) {
        if (!video.tags) {
          video.tags = [];
        }
        if (!video.tags.includes(tagName)) {
          video.tags.push(tagName);
        }
      }

      // タグの使用数を更新
      const tag = this.tags.find((t) => t.name === tagName);
      if (tag) {
        tag.count = (tag.count || 0) + 1;
      } else {
        // 新しいタグの場合、タグリストに追加
        this.tags.push({ name: tagName, count: 1 });
      }

      this.hasChanges = true;
    } catch (error) {
      console.error("VideoManager - Error adding tag to video:", error);
      throw error;
    }
  }

  // 動画からタグを削除
  async removeTagFromVideo(videoId: number, tagName: string): Promise<void> {
    try {
      await window.electronAPI.removeTagFromVideo(videoId.toString(), tagName);

      // ローカルキャッシュを更新
      const video = this.videos.find((v) => v.id === videoId);
      if (video && video.tags) {
        video.tags = video.tags.filter((tag) => tag !== tagName);
      }

      // タグの使用数を更新
      const tag = this.tags.find((t) => t.name === tagName);
      if (tag) {
        tag.count = Math.max(0, (tag.count || 0) - 1);
        // 使用数が0になったタグを削除
        if (tag.count === 0) {
          this.tags = this.tags.filter((t) => t.name !== tagName);
        }
      }

      this.hasChanges = true;
    } catch (error) {
      console.error("VideoManager - Error removing tag from video:", error);
      throw error;
    }
  }

  // 動画情報を更新
  async updateVideo(
    videoId: number,
    updatedData: Partial<Video>
  ): Promise<void> {
    try {
      // electronAPIに合わせて型を変換
      const electronData = {
        ...updatedData,
        id: updatedData.id?.toString(),
        size: updatedData.size,
      };
      await window.electronAPI.updateVideo(videoId.toString(), electronData);

      // ローカルキャッシュを更新
      const videoIndex = this.videos.findIndex((v) => v.id === videoId);
      if (videoIndex !== -1) {
        this.videos[videoIndex] = {
          ...this.videos[videoIndex],
          ...updatedData,
        };
      }

      this.hasChanges = true;
    } catch (error) {
      console.error("VideoManager - Error updating video:", error);
      throw error;
    }
  }

  // 動画を再生
  async playVideo(videoPath: string): Promise<void> {
    try {
      await window.electronAPI.openVideo(videoPath);
    } catch (error) {
      console.error("VideoManager - Error playing video:", error);
      throw error;
    }
  }

  // 動画が追加された時の処理
  async handleVideoAdded(filePath: string): Promise<void> {
    console.log("VideoManager - Video added:", filePath);
    // 動画リストを再読み込み
    await this.loadVideos(true);
  }

  // 動画が削除された時の処理
  async handleVideoRemoved(filePath: string): Promise<void> {
    console.log("VideoManager - Video removed:", filePath);
    // ローカルキャッシュから削除
    this.videos = this.videos.filter((video) => video.path !== filePath);
    this.hasChanges = true;
  }

  // キャッシュされた動画データを取得
  getVideos(): Video[] {
    return [...this.videos];
  }

  // キャッシュされたタグデータを取得
  getTags(): Tag[] {
    return [...this.tags];
  }

  // キャッシュされたディレクトリデータを取得
  getDirectories(): Directory[] {
    return [...this.directories];
  }

  // 特定の動画を取得
  getVideo(videoId: number): Video | undefined {
    return this.videos.find((video) => video.id === videoId);
  }

  // 動画を検索
  searchVideos(query: string): Video[] {
    if (!query) return [...this.videos];

    const lowerQuery = query.toLowerCase();
    return this.videos.filter(
      (video) =>
        video.title.toLowerCase().includes(lowerQuery) ||
        video.filename.toLowerCase().includes(lowerQuery) ||
        (video.description &&
          video.description.toLowerCase().includes(lowerQuery)) ||
        (video.tags &&
          video.tags.some((tag) => tag.toLowerCase().includes(lowerQuery)))
    );
  }

  // データに変更があったかどうか
  hasVideoChanges(): boolean {
    return this.hasChanges;
  }

  // 変更フラグをクリア
  clearChanges(): void {
    this.hasChanges = false;
  }

  // 統計情報を取得
  getStats(): {
    totalVideos: number;
    totalTags: number;
    totalDirectories: number;
    totalDuration: number;
    totalSize: number;
  } {
    const totalDuration = this.videos.reduce(
      (sum, video) => sum + (video.duration || 0),
      0
    );
    const totalSize = this.videos.reduce(
      (sum, video) => sum + Number(video.size || 0n),
      0
    );

    return {
      totalVideos: this.videos.length,
      totalTags: this.tags.length,
      totalDirectories: this.directories.length,
      totalDuration,
      totalSize,
    };
  }

  // メイン動画サムネイルを再生成
  async regenerateMainThumbnail(videoId: number): Promise<Video> {
    try {
      const result = await window.electronAPI.regenerateMainThumbnail(
        videoId.toString()
      );

      // ローカルキャッシュを更新
      const video = this.videos.find((v) => v.id === videoId);
      if (video && result.thumbnailPath) {
        video.thumbnailPath = result.thumbnailPath;
      }

      this.hasChanges = true;

      // electronAPIの型をVideoManager型に変換
      const convertedVideo: Video = {
        ...result,
        id: parseInt(result.id),
        size: result.size,
      };

      return convertedVideo;
    } catch (error) {
      console.error("VideoManager - Error regenerating main thumbnail:", error);
      throw error;
    }
  }

  // 不要なサムネイル画像を削除
  async cleanupThumbnails(): Promise<void> {
    console.log("VideoManager.cleanupThumbnails called");
    console.log("electronAPI available:", !!window.electronAPI);
    console.log(
      "electronAPI.cleanupThumbnails available:",
      !!window.electronAPI?.cleanupThumbnails
    );

    try {
      console.log("Calling window.electronAPI.cleanupThumbnails()");
      await window.electronAPI.cleanupThumbnails();
      console.log(
        "window.electronAPI.cleanupThumbnails() completed successfully"
      );
    } catch (error) {
      console.error("VideoManager - Error cleaning up thumbnails:", error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
  }
}
