-- 変換後の動画から、保持している変換元ファイルを開けるようにする。
ALTER TABLE "videos" ADD COLUMN "original_path" TEXT;

CREATE INDEX "videos_original_path_idx" ON "videos"("original_path");
