import {
  AcademicYearSchema,
  CALENDAR_UPLOAD_IMAGE_TYPES,
  CALENDAR_UPLOAD_MAX_FILE_BYTES,
  CALENDAR_UPLOAD_MAX_SCREENSHOTS,
  CALENDAR_UPLOAD_MAX_TOTAL_BYTES,
  CalendarReportSchema,
  CalendarSubmissionRequestSchema,
} from "@commondays/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  CalendarNotFoundError,
  CalendarAlreadyAvailableError,
  CalendarSubmissionNotFoundError,
  createCalendarRepository,
  ReportEventMismatchError,
  SchoolNotFoundError,
  SubmissionAlreadyInProgressError,
  type CalendarRepository,
  type CalendarUploadFile,
  UploadStorageNotConfiguredError,
} from "./repositories/calendar-repository.js";

const acceptedImageTypes = new Set<string>(CALENDAR_UPLOAD_IMAGE_TYPES);
const calendarUploadBodyLimit = bodyLimit({
  maxSize: CALENDAR_UPLOAD_MAX_TOTAL_BYTES + 1024 * 1024,
  onError: (context) =>
    context.json({ error: "Those files are too large together.", code: "UPLOAD_TOO_LARGE" }, 413),
});

function bodyFiles(value: string | File | (string | File)[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.filter((item): item is File => typeof item !== "string");
}

function startsWithBytes(content: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => content[offset + index] === byte);
}

function hasPdfSignature(content: Uint8Array) {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const searchLength = Math.min(content.length - signature.length + 1, 1024);
  for (let offset = 0; offset < searchLength; offset += 1) {
    if (startsWithBytes(content, signature, offset)) return true;
  }
  return false;
}

function contentMatchesMimeType(file: CalendarUploadFile) {
  if (file.mimeType === "application/pdf") return hasPdfSignature(file.content);
  if (file.mimeType === "image/png") {
    return startsWithBytes(file.content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (file.mimeType === "image/jpeg") return startsWithBytes(file.content, [0xff, 0xd8, 0xff]);
  if (file.mimeType === "image/webp") {
    return startsWithBytes(file.content, [0x52, 0x49, 0x46, 0x46]) &&
      startsWithBytes(file.content, [0x57, 0x45, 0x42, 0x50], 8);
  }
  return false;
}

export function createApp(repository: CalendarRepository = createCalendarRepository()) {
  const app = new Hono();

  app.use("/api/*", cors({ origin: ["http://localhost:5173"] }));

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "common-days-api", dataSource: repository.source }),
  );

  app.get("/api/v1/schools", async (context) => {
    const query = context.req.query("q")?.trim() ?? "";
    return context.json({ schools: await repository.searchSchools(query) });
  });

  app.get("/api/v1/schools/:schoolId/calendars/:academicYear/availability", async (context) => {
    const result = CalendarSubmissionRequestSchema.safeParse({
      schoolId: context.req.param("schoolId"),
      academicYear: context.req.param("academicYear"),
    });
    if (!result.success) return context.json({ error: "Invalid school or academic year." }, 400);

    try {
      return context.json(await repository.getAvailability(result.data.schoolId, result.data.academicYear));
    } catch (error) {
      if (error instanceof SchoolNotFoundError) return context.json({ error: error.message }, 404);
      throw error;
    }
  });

  app.post("/api/v1/schools/:schoolId/calendars/:academicYear/submissions", calendarUploadBodyLimit, async (context) => {
    const requestResult = CalendarSubmissionRequestSchema.safeParse({
      schoolId: context.req.param("schoolId"),
      academicYear: context.req.param("academicYear"),
    });
    if (!requestResult.success) return context.json({ error: "Invalid school or academic year." }, 400);

    if (!context.req.header("content-type")?.startsWith("multipart/form-data")) {
      return context.json({ error: "Upload files using multipart form data.", code: "EXPECTED_MULTIPART" }, 415);
    }
    try {
      const availability = await repository.getAvailability(
        requestResult.data.schoolId,
        requestResult.data.academicYear,
      );
      if (availability.status === "available") {
        return context.json({ error: "That calendar is already available.", code: "CALENDAR_ALREADY_AVAILABLE" }, 409);
      }
      if (availability.status === "processing") {
        return context.json(
          {
            error: "Someone already submitted that calendar and it is being processed.",
            code: "SUBMISSION_ALREADY_IN_PROGRESS",
            submissionId: availability.submissionId,
          },
          409,
        );
      }

      let form: Awaited<ReturnType<typeof context.req.parseBody>>;
      try {
        form = await context.req.parseBody({ all: true });
      } catch {
        return context.json({ error: "That multipart upload is malformed.", code: "INVALID_MULTIPART" }, 400);
      }
      const files = bodyFiles(form.files);
      if (files.length === 0) {
        return context.json({ error: "Add at least one screenshot or one PDF.", code: "NO_FILES" }, 422);
      }
      if (files.some((file) => file.size === 0)) {
        return context.json({ error: "One of those files is empty.", code: "EMPTY_FILE" }, 422);
      }
      if (files.some((file) => file.size > CALENDAR_UPLOAD_MAX_FILE_BYTES)) {
        return context.json({ error: "One of those files is too large.", code: "FILE_TOO_LARGE" }, 413);
      }
      if (files.reduce((total, file) => total + file.size, 0) > CALENDAR_UPLOAD_MAX_TOTAL_BYTES) {
        return context.json({ error: "Those files are too large together.", code: "UPLOAD_TOO_LARGE" }, 413);
      }

      const pdfFiles = files.filter((file) => file.type === "application/pdf");
      const imageFiles = files.filter((file) => acceptedImageTypes.has(file.type));
      if (pdfFiles.length + imageFiles.length !== files.length) {
        return context.json(
          { error: "Use PNG, JPG, WebP, or PDF files.", code: "UNSUPPORTED_FILE_TYPE" },
          415,
        );
      }
      if (pdfFiles.length > 0 && imageFiles.length > 0) {
        return context.json(
          { error: "Choose screenshots or one PDF, not both.", code: "MIXED_UPLOAD_TYPES" },
          422,
        );
      }
      if (pdfFiles.length > 1) {
        return context.json({ error: "Upload one PDF at a time.", code: "MULTIPLE_PDFS" }, 422);
      }
      if (imageFiles.length > CALENDAR_UPLOAD_MAX_SCREENSHOTS) {
        return context.json(
          {
            error: "You have already added 10 screenshots. Remove one before adding another.",
            code: "TOO_MANY_SCREENSHOTS",
          },
          422,
        );
      }

      const uploadFiles: CalendarUploadFile[] = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: file.type,
          size: file.size,
          content: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      if (uploadFiles.some((file) => !contentMatchesMimeType(file))) {
        return context.json(
          { error: "A file's contents do not match its file type.", code: "FILE_CONTENT_MISMATCH" },
          415,
        );
      }
      const submission = await repository.createCalendarSubmission(requestResult.data, uploadFiles);

      return context.json(
        { submission, message: "Academic calendar submitted for processing." },
        202,
      );
    } catch (error) {
      if (error instanceof SchoolNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof CalendarAlreadyAvailableError) {
        return context.json({ error: error.message, code: "CALENDAR_ALREADY_AVAILABLE" }, 409);
      }
      if (error instanceof SubmissionAlreadyInProgressError) {
        return context.json(
          { error: error.message, code: "SUBMISSION_ALREADY_IN_PROGRESS", submissionId: error.submissionId },
          409,
        );
      }
      if (error instanceof UploadStorageNotConfiguredError) {
        return context.json({ error: error.message, code: "UPLOAD_STORAGE_NOT_CONFIGURED" }, 503);
      }
      throw error;
    }
  });

  app.get("/api/v1/calendar-submissions/:id", async (context) => {
    try {
      return context.json({ submission: await repository.getCalendarSubmission(context.req.param("id")) });
    } catch (error) {
      if (error instanceof CalendarSubmissionNotFoundError) return context.json({ error: error.message }, 404);
      throw error;
    }
  });

  app.get("/api/v1/calendars", async (context) => {
    const yearResult = AcademicYearSchema.safeParse(context.req.query("year") ?? "2026-27");
    if (!yearResult.success) return context.json({ error: "Invalid academic year." }, 400);

    const schoolIds = [
      ...new Set(
        (context.req.query("schools") ?? "uiuc,berkeley,nyu")
          .split(",")
          .map((schoolId) => schoolId.trim())
          .filter(Boolean),
      ),
    ];
    if (schoolIds.length === 0) return context.json({ error: "Select at least one school." }, 400);

    return context.json(await repository.getComparison({ academicYear: yearResult.data, schoolIds }));
  });

  app.post("/api/v1/reports", async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return context.json({ error: "Invalid JSON body." }, 400);
    }

    const result = CalendarReportSchema.safeParse(payload);
    if (!result.success) return context.json({ error: "Invalid report", issues: result.error.flatten() }, 400);

    try {
      const report = await repository.createReport(result.data);
      return context.json({ report, message: "Correction report submitted for review." }, 201);
    } catch (error) {
      if (error instanceof CalendarNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof ReportEventMismatchError) return context.json({ error: error.message }, 422);
      throw error;
    }
  });

  app.onError((error, context) => {
    console.error("Common Days API request failed", error);
    return context.json({ error: "The data service is temporarily unavailable." }, 503);
  });

  return app;
}
