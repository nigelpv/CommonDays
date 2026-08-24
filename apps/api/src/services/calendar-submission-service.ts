import { createHash, randomUUID } from "node:crypto";
import { CalendarSubmissionSchema } from "@commondays/shared";
import type { CalendarSubmission, CalendarSubmissionRequest } from "@commondays/shared";
import type { CalendarStorage } from "../storage/calendar-storage.js";

export interface CalendarUploadFile {
  name: string;
  mimeType: string;
  size: number;
  content: Uint8Array;
}

export interface ReservedCalendarSubmission {
  id: string;
  schoolId: string;
  academicYear: string;
  sourceType: "screenshots" | "pdf";
  createdAt: Date;
}

export interface PersistedCalendarUpload {
  calendarId: string;
  fileType: "image" | "pdf";
  position: number;
  storageBucket: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export interface CalendarSubmissionPersistence {
  reserve(
    request: CalendarSubmissionRequest,
    sourceType: ReservedCalendarSubmission["sourceType"],
  ): Promise<ReservedCalendarSubmission>;
  insertUploads(uploads: PersistedCalendarUpload[]): Promise<void>;
  markFailed(calendarId: string): Promise<void>;
}

interface CreateDurableCalendarSubmissionOptions {
  request: CalendarSubmissionRequest;
  files: CalendarUploadFile[];
  storage: CalendarStorage;
  persistence: CalendarSubmissionPersistence;
  createPath?: (calendarId: string, position: number, mimeType: string) => string;
}

const extensionByMimeType: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function defaultStoragePath(calendarId: string, position: number, mimeType: string) {
  const extension = extensionByMimeType[mimeType];
  if (!extension) throw new Error("A validated calendar upload has an unsupported MIME type.");
  return `${calendarId}/${String(position).padStart(2, "0")}-${randomUUID()}.${extension}`;
}

function hashContent(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export async function createDurableCalendarSubmission({
  request,
  files,
  storage,
  persistence,
  createPath = defaultStoragePath,
}: CreateDurableCalendarSubmissionOptions): Promise<CalendarSubmission> {
  if (files.length === 0) throw new Error("A durable calendar submission requires at least one file.");

  const sourceType = files[0]?.mimeType === "application/pdf" ? "pdf" : "screenshots";
  const reserved = await persistence.reserve(request, sourceType);
  const storagePathsToCleanUp: string[] = [];

  try {
    const uploadRows: PersistedCalendarUpload[] = [];

    for (const [index, file] of files.entries()) {
      const position = index + 1;
      const storagePath = createPath(reserved.id, position, file.mimeType);

      storagePathsToCleanUp.push(storagePath);
      await storage.upload({
        path: storagePath,
        content: file.content,
        contentType: file.mimeType,
      });

      uploadRows.push({
        calendarId: reserved.id,
        fileType: sourceType === "pdf" ? "pdf" : "image",
        position,
        storageBucket: storage.bucket,
        storagePath,
        originalFilename: file.name,
        mimeType: file.mimeType,
        byteSize: file.size,
        sha256: hashContent(file.content),
      });
    }

    await persistence.insertUploads(uploadRows);

    return CalendarSubmissionSchema.parse({
      id: reserved.id,
      schoolId: reserved.schoolId,
      academicYear: reserved.academicYear,
      status: "processing",
      sourceType: reserved.sourceType,
      fileCount: files.length,
      createdAt: reserved.createdAt.toISOString(),
    });
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      storage.remove(storagePathsToCleanUp),
      persistence.markFailed(reserved.id),
    ]);

    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status === "rejected") {
        console.error("Calendar submission cleanup failed", cleanupResult.reason);
      }
    }

    throw error;
  }
}
