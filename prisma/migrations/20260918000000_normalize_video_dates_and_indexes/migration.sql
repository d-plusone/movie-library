-- Normalize file timestamps to Prisma DateTime and add indexes used by
-- sorting, duplicate detection, and the sidebar/filter queries.
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
    "created_at" DATETIME NOT NULL,
    "modified_at" DATETIME NOT NULL,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "file_hash" TEXT,
    "partial_hash" TEXT,
    "watched_at" DATETIME,
    "watch_position" INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "new_videos" (
    "id", "path", "filename", "title", "duration", "size", "width",
    "height", "fps", "codec", "bitrate", "rating", "thumbnail_path",
    "chapter_thumbnails", "description", "created_at", "modified_at",
    "added_at", "updated_at", "file_hash", "partial_hash", "watched_at",
    "watch_position"
)
SELECT
    "id", "path", "filename", "title", "duration", "size", "width",
    "height", "fps", "codec", "bitrate", "rating", "thumbnail_path",
    "chapter_thumbnails", "description", "created_at", "modified_at",
    "added_at", "updated_at", "file_hash", "partial_hash", "watched_at",
    "watch_position"
FROM "videos";

DROP TABLE "videos";
ALTER TABLE "new_videos" RENAME TO "videos";

CREATE UNIQUE INDEX "videos_path_key" ON "videos"("path");
CREATE INDEX "videos_updated_at_idx" ON "videos"("updated_at");
CREATE INDEX "videos_added_at_idx" ON "videos"("added_at");
CREATE INDEX "videos_thumbnail_path_idx" ON "videos"("thumbnail_path");
CREATE INDEX "videos_created_at_idx" ON "videos"("created_at");
CREATE INDEX "videos_modified_at_idx" ON "videos"("modified_at");
CREATE INDEX "videos_file_hash_idx" ON "videos"("file_hash");
CREATE INDEX "videos_partial_hash_idx" ON "videos"("partial_hash");
CREATE INDEX "videos_rating_idx" ON "videos"("rating");
CREATE INDEX "videos_duration_idx" ON "videos"("duration");
CREATE INDEX "videos_size_idx" ON "videos"("size");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
