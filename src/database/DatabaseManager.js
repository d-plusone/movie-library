const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs").promises;
const { app } = require("electron");

class DatabaseManager {
  constructor() {
    const userDataPath = app.getPath("userData");
    this.dbPath = path.join(userDataPath, "movie-library.db");
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
        } else {
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    // Enable foreign key constraints
    await new Promise((resolve, reject) => {
      this.db.run("PRAGMA foreign_keys = ON", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

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

    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async addVideo(videoData) {
    const sql = `
      INSERT OR REPLACE INTO videos (
        path, filename, title, duration, size, width, height, fps, codec, bitrate,
        created_at, modified_at, thumbnail_path, chapter_thumbnails, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(
        sql,
        [
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
          JSON.stringify(videoData.chapterThumbnails || []),
        ],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async getVideos(
    sortBy = "filename",
    sortOrder = "ASC",
    limit = null,
    offset = 0
  ) {
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

    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const videos = rows.map((row) => ({
            ...row,
            tags: row.tags ? row.tags.split(",") : [],
            chapterThumbnails: row.chapter_thumbnails
              ? JSON.parse(row.chapter_thumbnails)
              : [],
          }));
          resolve(videos);
        }
      });
    });
  }

  async getVideo(id) {
    const sql = `
      SELECT v.*, GROUP_CONCAT(t.name) as tags
      FROM videos v
      LEFT JOIN video_tags vt ON v.id = vt.video_id
      LEFT JOIN tags t ON vt.tag_id = t.id
      WHERE v.id = ?
      GROUP BY v.id
    `;

    return new Promise((resolve, reject) => {
      this.db.get(sql, [id], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          resolve({
            ...row,
            tags: row.tags ? row.tags.split(",") : [],
            chapterThumbnails: row.chapter_thumbnails
              ? JSON.parse(row.chapter_thumbnails)
              : [],
          });
        } else {
          resolve(null);
        }
      });
    });
  }

  async updateVideo(id, data) {
    const fields = [];
    const values = [];

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

    return new Promise((resolve, reject) => {
      this.db.run(sql, values, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  async removeVideo(path) {
    const sql = "DELETE FROM videos WHERE path = ?";
    return new Promise((resolve, reject) => {
      this.db.run(sql, [path], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  async searchVideos(query) {
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

    return new Promise((resolve, reject) => {
      this.db.all(
        sql,
        [searchPattern, searchPattern, searchPattern, searchPattern],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const videos = rows.map((row) => ({
              ...row,
              tags: row.tags ? row.tags.split(",") : [],
              chapterThumbnails: row.chapter_thumbnails
                ? JSON.parse(row.chapter_thumbnails)
                : [],
            }));
            resolve(videos);
          }
        }
      );
    });
  }

  async getVideosWithoutThumbnails() {
    const sql =
      'SELECT * FROM videos WHERE thumbnail_path IS NULL OR thumbnail_path = ""';
    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Directory management
  async addDirectory(directoryPath) {
    const name = path.basename(directoryPath);
    const sql = "INSERT OR IGNORE INTO directories (path, name) VALUES (?, ?)";
    return new Promise((resolve, reject) => {
      this.db.run(sql, [directoryPath, name], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  async removeDirectory(directoryPath) {
    const sql = "DELETE FROM directories WHERE path = ?";
    return new Promise((resolve, reject) => {
      this.db.run(sql, [directoryPath], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  async getDirectories() {
    const sql = "SELECT * FROM directories ORDER BY name ASC";
    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Tag management
  async getTags() {
    const sql = "SELECT * FROM tags ORDER BY name ASC";
    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async addTag(name, color = "#007AFF") {
    const sql = "INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)";
    return new Promise((resolve, reject) => {
      this.db.run(sql, [name, color], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  async addTagToVideo(videoId, tagName) {
    // First ensure the tag exists
    await this.addTag(tagName);

    const sql = `
      INSERT OR IGNORE INTO video_tags (video_id, tag_id)
      SELECT ?, id FROM tags WHERE name = ?
    `;
    return new Promise((resolve, reject) => {
      this.db.run(sql, [videoId, tagName], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  async removeTagFromVideo(videoId, tagName) {
    const sql = `
      DELETE FROM video_tags
      WHERE video_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)
    `;
    return new Promise((resolve, reject) => {
      this.db.run(sql, [videoId, tagName], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  async deleteTag(tagName) {
    // With foreign key constraints enabled, deleting from tags will automatically
    // delete related records from video_tags due to ON DELETE CASCADE
    const deleteTagSql = `DELETE FROM tags WHERE name = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(deleteTagSql, [tagName], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  async updateTag(oldName, newName) {
    const sql = `UPDATE tags SET name = ? WHERE name = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [newName, oldName], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = DatabaseManager;
