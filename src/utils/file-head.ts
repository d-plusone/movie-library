import { promises as fs } from "fs";

/** コンテナ判定などでファイル先頭を読み取る（読めない場合は null）。 */
export async function readFileHead(
  filePath: string,
  bytes: number,
): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
