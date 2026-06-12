-- CreateIndex
CREATE INDEX "videos_updated_at_idx" ON "videos"("updated_at");

-- CreateIndex
CREATE INDEX "videos_added_at_idx" ON "videos"("added_at");

-- CreateIndex
CREATE INDEX "videos_thumbnail_path_idx" ON "videos"("thumbnail_path");

-- CreateIndex
CREATE INDEX "video_tags_tag_id_idx" ON "video_tags"("tag_id");
