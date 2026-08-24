import { describe, expect, it, vi } from "vitest";
import type { CalendarStorage } from "../storage/calendar-storage.js";
import {
  createDurableCalendarSubmission,
  type CalendarSubmissionPersistence,
  type CalendarUploadFile,
  type PersistedCalendarUpload,
} from "./calendar-submission-service.js";

const calendarId = "3f72ea79-93b3-4ff2-937c-e689f7d4a33e";
const request = { schoolId: "michigan", academicYear: "2026-27" };

function imageFile(name: string, marker: number): CalendarUploadFile {
  const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, marker]);
  return { name, mimeType: "image/png", size: content.byteLength, content };
}

function createFakes(options: { failUploadAt?: number; failMetadata?: boolean } = {}) {
  const uploads: { path: string; contentType: string }[] = [];
  const removedPaths: string[][] = [];
  const insertedRows: PersistedCalendarUpload[][] = [];
  const failedCalendarIds: string[] = [];

  const storage: CalendarStorage = {
    bucket: "calendar-sources",
    async upload(file) {
      if (uploads.length + 1 === options.failUploadAt) throw new Error("storage unavailable");
      uploads.push({ path: file.path, contentType: file.contentType });
    },
    async remove(paths) {
      removedPaths.push([...paths]);
    },
  };

  const persistence: CalendarSubmissionPersistence = {
    async reserve(submissionRequest, sourceType) {
      return {
        id: calendarId,
        schoolId: submissionRequest.schoolId,
        academicYear: submissionRequest.academicYear,
        sourceType,
        createdAt: new Date("2026-08-24T12:00:00.000Z"),
      };
    },
    async insertUploads(rows) {
      if (options.failMetadata) throw new Error("database unavailable");
      insertedRows.push(rows);
    },
    async markFailed(id) {
      failedCalendarIds.push(id);
    },
  };

  return { storage, persistence, uploads, removedPaths, insertedRows, failedCalendarIds };
}

describe("durable calendar submissions", () => {
  it("uploads source bytes and saves ordered, hashed metadata", async () => {
    const fakes = createFakes();
    const files = [imageFile("fall calendar.png", 1), imageFile("spring calendar.png", 2)];

    const submission = await createDurableCalendarSubmission({
      request,
      files,
      storage: fakes.storage,
      persistence: fakes.persistence,
      createPath: (id, position) => `${id}/${String(position).padStart(2, "0")}-generated.png`,
    });

    expect(submission).toEqual({
      id: calendarId,
      schoolId: "michigan",
      academicYear: "2026-27",
      status: "processing",
      sourceType: "screenshots",
      fileCount: 2,
      createdAt: "2026-08-24T12:00:00.000Z",
    });
    expect(fakes.uploads).toEqual([
      { path: `${calendarId}/01-generated.png`, contentType: "image/png" },
      { path: `${calendarId}/02-generated.png`, contentType: "image/png" },
    ]);
    expect(fakes.insertedRows).toHaveLength(1);
    expect(fakes.insertedRows[0]).toMatchObject([
      {
        calendarId,
        fileType: "image",
        position: 1,
        storageBucket: "calendar-sources",
        storagePath: `${calendarId}/01-generated.png`,
        originalFilename: "fall calendar.png",
        mimeType: "image/png",
        byteSize: 5,
      },
      {
        calendarId,
        fileType: "image",
        position: 2,
        storageBucket: "calendar-sources",
        storagePath: `${calendarId}/02-generated.png`,
        originalFilename: "spring calendar.png",
        mimeType: "image/png",
        byteSize: 5,
      },
    ]);
    expect(fakes.insertedRows[0][0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fakes.insertedRows[0][0].sha256).not.toBe(fakes.insertedRows[0][1].sha256);
    expect(fakes.removedPaths).toEqual([]);
    expect(fakes.failedCalendarIds).toEqual([]);
  });

  it("removes completed objects and marks the calendar failed when an upload fails", async () => {
    const fakes = createFakes({ failUploadAt: 2 });
    const files = [imageFile("page-one.png", 1), imageFile("page-two.png", 2)];

    await expect(
      createDurableCalendarSubmission({
        request,
        files,
        storage: fakes.storage,
        persistence: fakes.persistence,
        createPath: (id, position) => `${id}/${position}.png`,
      }),
    ).rejects.toThrow("storage unavailable");

    expect(fakes.removedPaths).toEqual([[`${calendarId}/1.png`, `${calendarId}/2.png`]]);
    expect(fakes.failedCalendarIds).toEqual([calendarId]);
    expect(fakes.insertedRows).toEqual([]);
  });

  it("removes every object and marks the calendar failed when metadata persistence fails", async () => {
    const fakes = createFakes({ failMetadata: true });
    const files = [imageFile("page-one.png", 1), imageFile("page-two.png", 2)];

    await expect(
      createDurableCalendarSubmission({
        request,
        files,
        storage: fakes.storage,
        persistence: fakes.persistence,
        createPath: (id, position) => `${id}/${position}.png`,
      }),
    ).rejects.toThrow("database unavailable");

    expect(fakes.removedPaths).toEqual([[`${calendarId}/1.png`, `${calendarId}/2.png`]]);
    expect(fakes.failedCalendarIds).toEqual([calendarId]);
  });

  it("does not touch storage when the database cannot reserve the submission", async () => {
    const fakes = createFakes();
    fakes.persistence.reserve = vi.fn().mockRejectedValue(new Error("submission already exists"));

    await expect(
      createDurableCalendarSubmission({
        request,
        files: [imageFile("page.png", 1)],
        storage: fakes.storage,
        persistence: fakes.persistence,
      }),
    ).rejects.toThrow("submission already exists");

    expect(fakes.uploads).toEqual([]);
    expect(fakes.removedPaths).toEqual([]);
    expect(fakes.failedCalendarIds).toEqual([]);
  });
});
