import type {
  ProgressEvent,
  ThumbnailResult,
} from "../types/types.js";
import type { VideoScanRecord } from "../database/PrismaDatabaseManager.js";

export type ThumbnailBatchVideo = Pick<
  VideoScanRecord,
  "id" | "path" | "filename" | "duration"
>;

interface ThumbnailBatchOptions {
  fetchPage: (limit: number, afterId: number) => Promise<ThumbnailBatchVideo[]>;
  totalVideos: number;
  verb: string;
  stablePagination?: boolean;
  generate: (video: ThumbnailBatchVideo) => Promise<ThumbnailResult>;
  sendProgress: (payload: ProgressEvent) => void;
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await task(item);
      }
    },
  );
  await Promise.allSettled(workers);
}

/**
 * サムネイルをページング取得しながら並列生成する。
 * 条件が生成中に変わる一覧は毎回先頭を再取得し、全件再生成のように
 * 条件が変わらない一覧はIDカーソルでページを進める。
 */
export async function generateThumbnailsBatch({
  fetchPage,
  totalVideos,
  verb,
  stablePagination = false,
  generate,
  sendProgress,
}: ThumbnailBatchOptions): Promise<ThumbnailResult[]> {
  const BATCH_SIZE = 50;
  const CONCURRENCY = 3;
  const results: ThumbnailResult[] = [];
  let processedVideos = 0;
  let afterId = 0;

  // 失敗行が残り続ける場合でも無限ループにしない。
  const maxRounds = Math.ceil(totalVideos / BATCH_SIZE) + 10;
  for (let round = 0; round < maxRounds; round++) {
    const videos = await fetchPage(
      BATCH_SIZE,
      stablePagination ? afterId : 0,
    );
    if (videos.length === 0) break;

    await runConcurrent(videos, CONCURRENCY, async (video) => {
      try {
        sendProgress({
          kind: "progress",
          current: processedVideos,
          total: totalVideos,
          message: `${verb}中: ${video.filename}`,
          file: video.filename,
        });

        results.push(await generate(video));
        processedVideos++;
        sendProgress({
          kind: "progress",
          current: processedVideos,
          total: totalVideos,
          message: `${verb}完了: ${video.filename}`,
          file: video.filename,
        });
      } catch (error) {
        console.error(`Error generating thumbnails (${verb}):`, video.path, error);
        processedVideos++;
        sendProgress({
          kind: "progress",
          current: processedVideos,
          total: totalVideos,
          message: `${verb}エラー: ${video.filename}`,
          file: video.filename,
        });
      }
    });

    if (stablePagination) {
      afterId = videos[videos.length - 1]!.id;
    }
  }

  return results;
}
