import Database from "better-sqlite3";
import path from "path";
import { promises as fs } from "fs";
import { app } from "electron";

// better-sqlite3の型定義
type DatabaseInstance = Database.Database;

interface VideoData {
  path: string;
  filename: string;
  title?: string;
  duration?: number;
  size?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrate?: number;
  createdAt?: string;
  modifiedAt?: string;
  thumbnailPath?: string;
  chapterThumbnails?: any[];
}

interface VideoUpdateData {
  title?: string;
  rating?: number;
  description?: string;
  thumbnailPath?: string;
  chapterThumbnails?: any[];
}

interface VideoRecord {
  id: number;
  path: string;
  filename: string;
  title?: string;
  duration?: number;
  size?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrate?: number;
  created_at?: string;
  modified_at?: string;
  rating: number;
  thumbnail_path?: string;
  chapter_thumbnails: string;
  description?: string;
  added_at: string;
  updated_at: string;
  tags?: string[];
}

interface DirectoryRecord {
  id: number;
  path: string;
  name: string;
  added_at: string;
}

interface TagRecord {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

class DatabaseManager {
  private dbPath: string;
  private db: DatabaseInstance | null = null;

  constructor() {
    const userDataPath = app.getPath("userData");
    this.dbPath = path.join(userDataPath, "movie-library.db");
    this.db = null;
  }

  async initialize(): Promise<void> {
    try {
      this.db = new Database(this.dbPath);
      // Enable foreign key constraints
      this.db.pragma('foreign_keys = ON');
      await this.createTables();
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  async createTables(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        title TEXT,
        duration REAL,
        size INTEGER,
        width INTEGER,
        height INTEGER,
        fps REAL,
        codec TEXT,
        bitrate INTEGER,
        created_at TEXT,
        modified_at TEXT,
        rating INTEGER DEFAULT 0,
        thumbnail_path TEXT,
        chapter_thumbnails TEXT,
        description TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#007AFF',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS video_tags (
        video_id INTEGER,
        tag_id INTEGER,
        PRIMARY KEY (video_id, tag_id),
        FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_videos_path ON videos(path);
      CREATE INDEX IF NOT EXISTS idx_videos_filename ON videos(filename);
      CREATE INDEX IF NOT EXISTS idx_videos_title ON videos(title);
      CREATE INDEX IF NOT EXISTS idx_videos_rating ON videos(rating);
      CREATE INDEX IF NOT EXISTS idx_videos_duration ON videos(duration);
      CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at);
    `;

    this.db!.exec(sql);
  }

  async addVideo(videoData: VideoData): Promise<number> {
    const sql = `
      INSERT OR REPLACE INTO videos (
        path, filename, title, duration, size, width, height, fps, codec, bitrate,
        created_at, modified_at, thumbnail_path, chapter_thumbnails, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    const stmt = this.db!.prepare(sql);
    const result = stmt.run(
      videoData.path,
      videoData.filename,
      videoData.title || videoData.filename,
      videoData.duration,
      videoData.size,
      videoData.width,
      videoData.height,
      videoData.fps,
      videoData.codec,
      videoData.bitrate,
      videoData.createdAt,
      videoData.modifiedAt,
      videoData.thumbnailPath,
      JSON.stringify(videoData.chapterThumbnails || [])
    );

    return result.lastInsertRowid as number;
  }

  async getVideos(
    sortBy: string = "filename",
    sortOrder: string = "ASC",
    limit: number | null = null,
    offset: number = 0
  ): Promise<VideoRecord[]> {
    let sql = `
      SELECT v.*, GROUP_CONCAT(t.name) as tags
      FROM videos v
      LEFT JOIN video_tags vt ON v.id = vt.video_id
      LEFT JOIN tags t ON vt.tag_id = t.id
      GROUP BY v.id
      ORDER BY v.${sortBy} ${sortOrder}
    `;

    if (limit) {
      sql += ` LIMIT ${limit} OFFSET ${offset}`;
    }

    const stmt = this.db!.prepare(sql);
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? row.tags.split(",") : [],
      chapterThumbnails: row.chapter_thumbnails
        ? JSON.parse(row.chapter_thumbnails)
        : [],
    }));
  }

  async getVideo(id: number): Promise<VideoRecord | null> {
    const sql = `
      SELECT v.*, GROUP_CONCAT(t.name) as tags
      FROM videos v
      LEFT JOIN video_tags vt ON v.id = vt.video_id
      LEFT JOIN tags t ON vt.tag_id = t.id
      WHERE v.id = ?
      GROUP BY v.id
    `;

    const stmt = this.db!.prepare(sql);
    const row = stmt.get(id) as any;

    if (row) {
      return {
        ...row,
        tags: row.tags ? row.tags.split(",") : [],
        chapterThumbnails: row.chapter_thumbnails
          ? JSON.parse(row.chapter_thumbnails)
          : [],
      };
    }
    return null;
  }

  async getVideoByPath(path: string): Promise<VideoRecord | null> {
    const sql = `
      SELECT v.*, GROUP_CONCAT(t.name) as tags
      FROM videos v
      LEFT JOIN video_tags vt ON v.id = vt.video_id
      LEFT JOIN tags t ON vt.tag_id = t.id
      WHERE v.path = ?
      GROUP BY v.id
    `;

    const stmt = this.db!.prepare(sql);
    const row = stmt.get(path) as any;

    if (row) {
      return {
        ...row,
        tags: row.tags ? row.tags.split(",") : [],
        chapterThumbnails: row.chapter_thumbnails
          ? JSON.parse(row.chapter_thumbnails)
          : [],
      };
    }
    return null;
  }

  async updateVideo(id: number, data: VideoUpdateData): Promise<boolean> {
    const fields: string[] = [];
    const values: any[] = [];

    if (data.title !== undefined) {
      fields.push("title = ?");
      values.push(data.title);
    }
    if (data.rating !== undefined) {
      fields.push("rating = ?");
      values.push(data.rating);
    }
    if (data.description !== undefined) {
      fields.push("description = ?");
      values.push(data.description);
    }
    if (data.thumbnailPath !== undefined) {
      fields.push("thumbnail_path = ?");
      values.push(data.thumbnailPath);
    }
    if (data.chapterThumbnails !== undefined) {
      fields.push("chapter_thumbnails = ?");
      values.push(JSON.stringify(data.chapterThumbnails));
    }

    if (fields.length === 0) {
      return false;
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);

    const sql = `UPDATE videos SET ${fields.join(", ")} WHERE id = ?`;

    const stmt = this.db!.prepare(sql);
    const result = stmt.run(...values);
    return result.changes > 0;
  }

  async removeVideo(path: string): Promise<boolean> {
    const sql = "DELETE FROM videos WHERE path = ?";
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(path);
    return result.changes > 0;
  }

  async searchVideos(query: string): Promise<VideoRecord[]> {
    const sql = `
      SELECT v.*, GROUP_CONCAT(t.name) as tags
      FROM videos v
      LEFT JOIN video_tags vt ON v.id = vt.video_id
      LEFT JOIN tags t ON vt.tag_id = t.id
      WHERE v.title LIKE ? OR v.filename LIKE ? OR v.description LIKE ? OR t.name LIKE ?
      GROUP BY v.id
      ORDER BY v.title ASC
    `;

    const searchPattern = `%${query}%`;
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(searchPattern, searchPattern, searchPattern, searchPattern) as any[];

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? row.tags.split(",") : [],
      chapterThumbnails: row.chapter_thumbnails
        ? JSON.parse(row.chapter_thumbnails)
        : [],
    }));
  }

  async getVideosWithoutThumbnails(): Promise<VideoRecord[]> {
    try {
      console.log("getVideosWithoutThumbnails: Starting query");
      // より安全なクエリ：COALESCEを使用してNULLを空文字列に変換
      const sql = "SELECT * FROM videos WHERE COALESCE(thumbnail_path, '') = ''";
      console.log("getVideosWithoutThumbnails: SQL query:", sql);
      
      const stmt = this.db!.prepare(sql);
      const rows = stmt.all() as any[];
      
      console.log(`getVideosWithoutThumbnails: Found ${rows.length} videos without thumbnails`);
      if (rows.length > 0) {
        console.log("Sample videos without thumbnails:", rows.slice(0, 3).map(v => ({ id: v.id, filename: v.filename, thumbnail_path: v.thumbnail_path })));
      }
      
      return rows;
    } catch (error) {
      console.error("Error in getVideosWithoutThumbnails:", error);
      console.error("Error details:", {
        message: error.message,
        code: error.code,
        stack: error.stack
      });
      throw error;
    }
  }

  // Directory management
  async addDirectory(directoryPath: string): Promise<number> {
    const name = path.basename(directoryPath);
    const sql = "INSERT OR IGNORE INTO directories (path, name) VALUES (?, ?)";
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(directoryPath, name);
    return result.lastInsertRowid as number;
  }

  async removeDirectory(directoryPath: string): Promise<boolean> {
    const sql = "DELETE FROM directories WHERE path = ?";
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(directoryPath);
    return result.changes > 0;
  }

  async getDirectories(): Promise<DirectoryRecord[]> {
    const sql = "SELECT * FROM directories ORDER BY name ASC";
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all() as any[];
    return rows;
  }

  // Tag management
  async getTags(): Promise<TagRecord[]> {
    const sql = "SELECT * FROM tags ORDER BY name ASC";
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all() as any[];
    return rows;
  }

  async addTag(name: string, color: string = "#007AFF"): Promise<number> {
    const sql = "INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)";
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(name, color);
    return result.lastInsertRowid as number;
  }

  async addTagToVideo(videoId: number, tagName: string): Promise<boolean> {
    // First ensure the tag exists
    await this.addTag(tagName);

    const sql = `
      INSERT OR IGNORE INTO video_tags (video_id, tag_id)
      SELECT ?, id FROM tags WHERE name = ?
    `;
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(videoId, tagName);
    return result.changes > 0;
  }

  async removeTagFromVideo(videoId: number, tagName: string): Promise<boolean> {
    const sql = `
      DELETE FROM video_tags
      WHERE video_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)
    `;
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(videoId, tagName);
    return result.changes > 0;
  }

  async deleteTag(tagName: string): Promise<boolean> {
    // With foreign key constraints enabled, deleting from tags will automatically
    // delete related records from video_tags due to ON DELETE CASCADE
    const deleteTagSql = `DELETE FROM tags WHERE name = ?`;
    const stmt = this.db!.prepare(deleteTagSql);
    const result = stmt.run(tagName);
    return result.changes > 0;
  }

  async updateTag(oldName: string, newName: string): Promise<boolean> {
    const sql = `UPDATE tags SET name = ? WHERE name = ?`;
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(newName, oldName);
    return result.changes > 0;
  }

  // 指定時刻以降にビデオが更新されているかチェック
  async hasVideoUpdates(lastCheckTime: number): Promise<boolean> {
    const sql = `
      SELECT COUNT(*) as count
      FROM videos
      WHERE datetime(updated_at) > datetime(?, 'unixepoch')
         OR datetime(added_at) > datetime(?, 'unixepoch')
    `;

    const checkTimeSeconds = Math.floor(lastCheckTime / 1000);

    try {
      const stmt = this.db!.prepare(sql);
      const row = stmt.get(checkTimeSeconds, checkTimeSeconds) as any;
      
      console.log("hasVideoUpdates check:", {
        lastCheckTime: new Date(lastCheckTime).toISOString(),
        checkTimeSeconds,
        hasUpdates: row.count > 0,
        updateCount: row.count,
      });
      
      return row.count > 0;
    } catch (error) {
      console.error("Error checking video updates:", error);
      throw error;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export default DatabaseManager;
