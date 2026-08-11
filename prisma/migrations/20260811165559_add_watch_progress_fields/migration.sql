-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_videos" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "path" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "size" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "fps" INTEGER NOT NULL DEFAULT 0,
    "codec" TEXT NOT NULL DEFAULT '',
    "bitrate" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER NOT NULL DEFAULT 0,
    "thumbnail_path" TEXT,
    "chapter_thumbnails" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT,
    "created_at" TEXT NOT NULL,
    "modified_at" TEXT NOT NULL,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "file_hash" TEXT,
    "partial_hash" TEXT,
    "watched_at" DATETIME,
    "watch_position" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_videos" ("added_at", "bitrate", "chapter_thumbnails", "codec", "created_at", "description", "duration", "file_hash", "filename", "fps", "height", "id", "modified_at", "partial_hash", "path", "rating", "size", "thumbnail_path", "title", "updated_at", "width") SELECT "added_at", "bitrate", "chapter_thumbnails", "codec", "created_at", "description", "duration", "file_hash", "filename", "fps", "height", "id", "modified_at", "partial_hash", "path", "rating", "size", "thumbnail_path", "title", "updated_at", "width" FROM "videos";
DROP TABLE "videos";
ALTER TABLE "new_videos" RENAME TO "videos";
CREATE UNIQUE INDEX "videos_path_key" ON "videos"("path");
CREATE INDEX "videos_updated_at_idx" ON "videos"("updated_at");
CREATE INDEX "videos_added_at_idx" ON "videos"("added_at");
CREATE INDEX "videos_thumbnail_path_idx" ON "videos"("thumbnail_path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
