-- 変換前ファイルはディスクに残したまま、通常のライブラリ一覧から除外する。
ALTER TABLE "videos" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "videos_hidden_idx" ON "videos"("hidden");
