import { PrismaClient as GeneratedPrismaClient } from "../../generated/prisma";
import path from "path";
import type {
  Video as AppVideo,
  Directory as AppDirectory,
  Tag as AppTag,
  ChapterThumbnail,
  VideoCreateData,
  VideoUpdateData,
} from "../types/types";

// データベース操作用の型定義（Prismaの型とアプリの型を橋渡し）
export interface VideoRecord extends AppVideo {
  videoTags?: {
    tag: { name: string; id: number; createdAt: Date; color: string };
  }[];
}

export interface DirectoryRecord extends AppDirectory {}

export interface TagRecord extends AppTag {}

class PrismaDatabaseManager {
  private prisma: GeneratedPrismaClient;

  constructor() {
    this.prisma = new GeneratedPrismaClient();
  }

  async initialize(): Promise<void> {
    try {
      // Prismaを使用してデータベース接続をテスト
      await this.prisma.$connect();
      console.log("Prisma database connection established");
    } catch (error) {
      console.error("Failed to initialize Prisma database:", error);
      throw error;
    }
  }

  async addVideo(videoData: VideoCreateData): Promise<number> {
    // 日付の型変換（DateオブジェクトはISO文字列に変換）
    const createdAtString = videoData.createdAt;
    const modifiedAtString = videoData.modifiedAt;

    const video = await this.prisma.video.upsert({
      where: { path: videoData.path },
      update: {
        filename: videoData.filename,
        title: videoData.title || videoData.filename,
        duration: videoData.duration,
        size: videoData.size,
        width: videoData.width,
        height: videoData.height,
        fps: videoData.fps,
        codec: videoData.codec,
        bitrate: videoData.bitrate,
        createdAt: createdAtString,
        modifiedAt: modifiedAtString,
        thumbnailPath: videoData.thumbnailPath,
        chapterThumbnails: JSON.stringify(videoData.chapterThumbnails || []),
        updatedAt: new Date(),
      },
      create: {
        path: videoData.path,
        filename: videoData.filename,
        title: videoData.title || videoData.filename,
        duration: videoData.duration,
        size: videoData.size,
        width: videoData.width,
        height: videoData.height,
        fps: videoData.fps,
        codec: videoData.codec,
        bitrate: videoData.bitrate,
        createdAt: createdAtString,
        modifiedAt: modifiedAtString,
        thumbnailPath: videoData.thumbnailPath,
        chapterThumbnails: JSON.stringify(videoData.chapterThumbnails || []),
      },
    });

    return video.id;
  }

  async getVideos(
    sortBy: string = "filename",
    sortOrder: string = "ASC",
    limit: number | null = null,
    offset: number = 0
  ): Promise<VideoRecord[]> {
    const orderBy = { [sortBy]: sortOrder.toLowerCase() };

    const videos = await this.prisma.video.findMany({
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
      orderBy,
      take: limit || undefined,
      skip: offset,
    });

    return videos.map((video) => ({
      ...video,
      modifiedAt: video.modifiedAt ? new Date(video.modifiedAt) : undefined,
      createdAt: video.createdAt ? new Date(video.createdAt) : undefined,
      updatedAt: video.updatedAt ? new Date(video.updatedAt) : undefined,
      tags: video.videoTags.map((vt) => vt.tag.name),
      chapterThumbnails: video.chapterThumbnails
        ? (JSON.parse(video.chapterThumbnails) as ChapterThumbnail[])
        : [],
    }));
  }

  async getVideo(id: number): Promise<VideoRecord | null> {
    const video = await this.prisma.video.findUnique({
      where: { id },
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
    });

    if (!video) return null;

    return {
      ...video,
      modifiedAt: video.modifiedAt ? new Date(video.modifiedAt) : undefined,
      createdAt: video.createdAt ? new Date(video.createdAt) : undefined,
      updatedAt: video.updatedAt ? new Date(video.updatedAt) : undefined,
      tags: video.videoTags.map((vt) => vt.tag.name),
      chapterThumbnails: video.chapterThumbnails
        ? (JSON.parse(video.chapterThumbnails) as ChapterThumbnail[])
        : [],
    };
  }

  async getVideoByPath(path: string): Promise<VideoRecord | null> {
    const video = await this.prisma.video.findUnique({
      where: { path },
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
    });

    if (!video) return null;

    return {
      ...video,
      modifiedAt: video.modifiedAt ? new Date(video.modifiedAt) : undefined,
      createdAt: video.createdAt ? new Date(video.createdAt) : undefined,
      updatedAt: video.updatedAt ? new Date(video.updatedAt) : undefined,
      tags: video.videoTags.map((vt) => vt.tag.name),
      chapterThumbnails: video.chapterThumbnails
        ? (JSON.parse(video.chapterThumbnails) as ChapterThumbnail[])
        : [],
    };
  }

  async updateVideo(id: number, data: VideoUpdateData): Promise<boolean> {
    try {
      const updateData: {
        title?: string;
        rating?: number;
        description?: string;
        thumbnailPath?: string;
        chapterThumbnails?: string;
        updatedAt?: Date;
      } = {};

      if (data.title !== undefined) updateData.title = data.title;
      if (data.rating !== undefined) updateData.rating = data.rating;
      if (data.description !== undefined)
        updateData.description = data.description;
      if (data.thumbnailPath !== undefined)
        updateData.thumbnailPath = data.thumbnailPath;
      if (data.chapterThumbnails !== undefined) {
        updateData.chapterThumbnails = JSON.stringify(data.chapterThumbnails);
      }

      if (Object.keys(updateData).length === 0) return false;

      updateData.updatedAt = new Date();

      await this.prisma.video.update({
        where: { id },
        data: updateData,
      });

      return true;
    } catch (error) {
      console.error("Error updating video:", error);
      return false;
    }
  }

  async removeVideo(path: string): Promise<boolean> {
    try {
      await this.prisma.video.delete({
        where: { path },
      });
      return true;
    } catch (error) {
      console.error("Error removing video:", error);
      return false;
    }
  }

  async searchVideos(query: string): Promise<VideoRecord[]> {
    const videos = await this.prisma.video.findMany({
      where: {
        OR: [
          { title: { contains: query } },
          { filename: { contains: query } },
          { description: { contains: query } },
          {
            videoTags: {
              some: {
                tag: {
                  name: { contains: query },
                },
              },
            },
          },
        ],
      },
      include: {
        videoTags: {
          include: {
            tag: true,
          },
        },
      },
      orderBy: { title: "asc" },
    });

    return videos.map((video) => ({
      ...video,
      modifiedAt: video.modifiedAt ? new Date(video.modifiedAt) : undefined,
      createdAt: video.createdAt ? new Date(video.createdAt) : undefined,
      updatedAt: video.updatedAt ? new Date(video.updatedAt) : undefined,
      tags: video.videoTags.map((vt) => vt.tag.name),
      chapterThumbnails: video.chapterThumbnails
        ? (JSON.parse(video.chapterThumbnails) as ChapterThumbnail[])
        : [],
    }));
  }

  async getVideosWithoutThumbnails(): Promise<VideoRecord[]> {
    try {
      console.log("getVideosWithoutThumbnails: Starting Prisma query");

      const videos = await this.prisma.video.findMany({
        where: {
          OR: [{ thumbnailPath: null }, { thumbnailPath: "" }],
        },
        include: {
          videoTags: {
            include: {
              tag: true,
            },
          },
        },
      });

      console.log(
        `getVideosWithoutThumbnails: Found ${videos.length} videos without thumbnails`
      );
      if (videos.length > 0) {
        console.log(
          "Sample videos without thumbnails:",
          videos.slice(0, 3).map((v) => ({
            id: v.id,
            filename: v.filename,
            thumbnailPath: v.thumbnailPath,
          }))
        );
      }

      return videos.map((video) => ({
        ...video,
        modifiedAt: video.modifiedAt ? new Date(video.modifiedAt) : undefined,
        createdAt: video.createdAt ? new Date(video.createdAt) : undefined,
        updatedAt: video.updatedAt ? new Date(video.updatedAt) : undefined,
        tags: video.videoTags.map((vt) => vt.tag.name),
        chapterThumbnails: video.chapterThumbnails
          ? (JSON.parse(video.chapterThumbnails) as ChapterThumbnail[])
          : [],
      }));
    } catch (error) {
      console.error("Error in getVideosWithoutThumbnails:", error);
      throw error;
    }
  }

  // Directory management
  async addDirectory(directoryPath: string): Promise<number> {
    const name = path.basename(directoryPath);
    const directory = await this.prisma.directory.upsert({
      where: { path: directoryPath },
      update: {},
      create: {
        path: directoryPath,
        name,
      },
    });
    return directory.id;
  }

  async removeDirectory(directoryPath: string): Promise<boolean> {
    try {
      await this.prisma.directory.delete({
        where: { path: directoryPath },
      });
      return true;
    } catch (error) {
      console.error("Error removing directory:", error);
      return false;
    }
  }

  async getDirectories(): Promise<DirectoryRecord[]> {
    return await this.prisma.directory.findMany({
      orderBy: { name: "asc" },
    });
  }

  // Tag management
  async getTags(): Promise<TagRecord[]> {
    return await this.prisma.tag.findMany({
      orderBy: { name: "asc" },
    });
  }

  async addTag(name: string, color: string = "#007AFF"): Promise<number> {
    const tag = await this.prisma.tag.upsert({
      where: { name },
      update: {},
      create: {
        name,
        color,
      },
    });
    return tag.id;
  }

  async addTagToVideo(videoId: number, tagName: string): Promise<boolean> {
    try {
      // First ensure the tag exists
      const tag = await this.prisma.tag.upsert({
        where: { name: tagName },
        update: {},
        create: {
          name: tagName,
          color: "#007AFF",
        },
      });

      // Then create the video-tag relationship
      await this.prisma.videoTag.upsert({
        where: {
          videoId_tagId: {
            videoId,
            tagId: tag.id,
          },
        },
        update: {},
        create: {
          videoId,
          tagId: tag.id,
        },
      });

      return true;
    } catch (error) {
      console.error("Error adding tag to video:", error);
      return false;
    }
  }

  async removeTagFromVideo(videoId: number, tagName: string): Promise<boolean> {
    try {
      const tag = await this.prisma.tag.findUnique({
        where: { name: tagName },
      });

      if (!tag) return false;

      await this.prisma.videoTag.delete({
        where: {
          videoId_tagId: {
            videoId,
            tagId: tag.id,
          },
        },
      });

      return true;
    } catch (error) {
      console.error("Error removing tag from video:", error);
      return false;
    }
  }

  async deleteTag(tagName: string): Promise<boolean> {
    try {
      await this.prisma.tag.delete({
        where: { name: tagName },
      });
      return true;
    } catch (error) {
      console.error("Error deleting tag:", error);
      return false;
    }
  }

  async updateTag(oldName: string, newName: string): Promise<boolean> {
    try {
      await this.prisma.tag.update({
        where: { name: oldName },
        data: { name: newName },
      });
      return true;
    } catch (error) {
      console.error("Error updating tag:", error);
      return false;
    }
  }

  // 指定時刻以降にビデオが更新されているかチェック
  async hasVideoUpdates(lastCheckTime: number): Promise<boolean> {
    const checkTime = new Date(lastCheckTime);

    try {
      const count = await this.prisma.video.count({
        where: {
          OR: [
            { updatedAt: { gt: checkTime } },
            { addedAt: { gt: checkTime } },
          ],
        },
      });

      console.log("hasVideoUpdates check:", {
        lastCheckTime: checkTime.toISOString(),
        hasUpdates: count > 0,
        updateCount: count,
      });

      return count > 0;
    } catch (error) {
      console.error("Error checking video updates:", error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export default PrismaDatabaseManager;
