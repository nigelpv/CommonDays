import {
  AdminMeResponseSchema,
  AdminReportActionSchema,
  AdminReportDetailResponseSchema,
  AdminReportResponseSchema,
  AdminReportSourceUrlResponseSchema,
  AdminReportsResponseSchema,
  AdminReportStatusSchema,
  AcademicYearSchema,
  CALENDAR_UPLOAD_IMAGE_TYPES,
  CALENDAR_UPLOAD_MAX_FILE_BYTES,
  CALENDAR_UPLOAD_MAX_SCREENSHOTS,
  CALENDAR_UPLOAD_MAX_TOTAL_BYTES,
  CalendarReportSchema,
  CalendarSubmissionRequestSchema,
  SchoolCreateRequestSchema,
  SchoolCreateResponseSchema,
  SchoolSearchResponseSchema,
  type AdminIdentity,
} from "@commondays/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  createAdminTokenVerifier,
  type AdminTokenVerifier,
} from "./auth/admin-auth.js";
import {
  AdminCorrectionConflictError,
  AdminCorrectionValidationError,
  AdminReportNotFoundError,
  AdminReportSourceNotFoundError,
  AdminReportSourceUnavailableError,
  AdminReportTransitionError,
  AdminReviewerAuthorizationError,
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
import type {
  CalendarExtractionQueue,
  SchoolSimilarityAlertQueue,
} from "./inngest/calendar-extraction.js";

const acceptedImageTypes = new Set<string>(CALENDAR_UPLOAD_IMAGE_TYPES);
type AppEnvironment = {
  Variables: {
    adminUser: AdminIdentity;
  };
};

type AppOptions = {
  adminTokenVerifier?: AdminTokenVerifier | null;
  corsOrigins?: string[];
  calendarExtractionQueue?: CalendarExtractionQueue | null;
  schoolSimilarityAlertQueue?: SchoolSimilarityAlertQueue | null;
  schoolCreationRateLimit?: { maxCreations: number; windowMs: number } | null;
  inngestHandler?: ((context: Context) => Promise<Response>) | null;
};

function normalizeCorsOrigin(origin: string) {
  const trimmedOrigin = origin.trim();
  if (!trimmedOrigin || trimmedOrigin === "*") {
    throw new Error("CORS origins must be explicit HTTP or HTTPS origins.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmedOrigin);
  } catch {
    throw new Error(`Invalid CORS origin: ${trimmedOrigin}`);
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Invalid CORS origin: ${trimmedOrigin}`);
  }
  return parsed.origin;
}

export function resolveCorsOrigins(explicitOrigins?: string[]) {
  const configuredOrigins = explicitOrigins ?? (
    process.env.CORS_ALLOWED_ORIGINS === undefined
      ? process.env.NODE_ENV === "production"
        ? []
        : ["http://localhost:5173"]
      : process.env.CORS_ALLOWED_ORIGINS.split(",")
  );
  return [...new Set(configuredOrigins.map(normalizeCorsOrigin))];
}

const calendarUploadBodyLimit = bodyLimit({
  maxSize: CALENDAR_UPLOAD_MAX_TOTAL_BYTES + 1024 * 1024,
  onError: (context) =>
    context.json({ error: "Those files are too large together.", code: "UPLOAD_TOO_LARGE" }, 413),
});

const schoolCreateBodyLimit = bodyLimit({
  maxSize: 8 * 1024,
  onError: (context) =>
    context.json({ error: "That school entry is too large.", code: "SCHOOL_ENTRY_TOO_LARGE" }, 413),
});

const adminReportActionBodyLimit = bodyLimit({
  maxSize: 16 * 1024,
  onError: (context) =>
    context.json({ error: "That correction request is too large.", code: "CORRECTION_TOO_LARGE" }, 413),
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

export function createApp(
  repository: CalendarRepository = createCalendarRepository(),
  options: AppOptions = {},
) {
  const app = new Hono<AppEnvironment>();
  const adminTokenVerifier = "adminTokenVerifier" in options
    ? options.adminTokenVerifier ?? null
    : createAdminTokenVerifier();
  const corsOrigins = resolveCorsOrigins(options.corsOrigins);
  const calendarExtractionQueue = options.calendarExtractionQueue ?? null;
  const schoolSimilarityAlertQueue = options.schoolSimilarityAlertQueue ?? null;
  const schoolCreationRateLimit = options.schoolCreationRateLimit === undefined
    ? { maxCreations: 20, windowMs: 60 * 60 * 1000 }
    : options.schoolCreationRateLimit;
  let schoolCreationTimestamps: number[] = [];

  app.use("/api/*", cors({
    origin: corsOrigins,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  }));

  if (options.inngestHandler) {
    app.on(["GET", "PUT", "POST"], "/api/inngest", options.inngestHandler);
  }

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      service: "common-days-api",
      dataSource: repository.source,
      schoolSimilarityEmail: schoolSimilarityAlertQueue ? "configured" : "queued_only",
    }),
  );

  app.use("/api/v1/admin/*", async (context, next) => {
    const authorization = context.req.header("authorization") ?? "";
    const bearerToken = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    if (!bearerToken) {
      return context.json({ error: "Sign in to access the admin area.", code: "ADMIN_AUTH_REQUIRED" }, 401);
    }
    if (!adminTokenVerifier) {
      return context.json(
        { error: "Admin authentication is not configured.", code: "ADMIN_AUTH_NOT_CONFIGURED" },
        503,
      );
    }

    const verification = await adminTokenVerifier(bearerToken);
    if (verification.status === "invalid") {
      return context.json({ error: "That sign-in session is invalid or expired.", code: "INVALID_ADMIN_TOKEN" }, 401);
    }
    if (verification.status === "unavailable") {
      return context.json(
        { error: "The sign-in service is temporarily unavailable.", code: "ADMIN_AUTH_UNAVAILABLE" },
        503,
      );
    }
    if (!(await repository.isAdminUser(verification.user.id))) {
      return context.json({ error: "This account is not a Common Days administrator.", code: "ADMIN_FORBIDDEN" }, 403);
    }

    context.set("adminUser", verification.user);
    await next();
  });

  app.get("/api/v1/admin/me", (context) => {
    return context.json(AdminMeResponseSchema.parse({ admin: context.get("adminUser") }));
  });

  app.get("/api/v1/admin/reports", async (context) => {
    const rawStatus = context.req.query("status");
    const status = rawStatus === undefined ? undefined : AdminReportStatusSchema.safeParse(rawStatus);
    if (status && !status.success) {
      return context.json({ error: "Invalid report status.", code: "INVALID_REPORT_STATUS" }, 400);
    }

    return context.json(AdminReportsResponseSchema.parse({
      reports: await repository.listAdminReports(status?.data),
    }));
  });

  app.get("/api/v1/admin/reports/:id", async (context) => {
    try {
      return context.json(AdminReportDetailResponseSchema.parse({
        report: await repository.getAdminReport(context.req.param("id")),
      }));
    } catch (error) {
      if (error instanceof AdminReportNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof AdminCorrectionConflictError) {
        return context.json({ error: error.message, code: "CALENDAR_VERSION_CONFLICT" }, 409);
      }
      if (error instanceof AdminReportSourceUnavailableError) {
        return context.json({ error: error.message, code: "REPORT_SOURCE_UNAVAILABLE" }, 503);
      }
      throw error;
    }
  });

  app.post("/api/v1/admin/reports/:id/source-files/:uploadId/signed-url", async (context) => {
    context.header("Cache-Control", "private, no-store");
    try {
      const response = AdminReportSourceUrlResponseSchema.parse(
        await repository.createAdminReportSourceUrl(
          context.req.param("id"),
          context.req.param("uploadId"),
        ),
      );
      return context.json(response);
    } catch (error) {
      if (error instanceof AdminReportSourceNotFoundError) {
        return context.json({ error: error.message, code: "REPORT_SOURCE_NOT_FOUND" }, 404);
      }
      if (error instanceof UploadStorageNotConfiguredError) {
        return context.json({ error: error.message, code: "UPLOAD_STORAGE_NOT_CONFIGURED" }, 503);
      }
      if (error instanceof AdminReportSourceUnavailableError) {
        return context.json({ error: error.message, code: "REPORT_SOURCE_UNAVAILABLE" }, 503);
      }
      throw error;
    }
  });

  app.patch("/api/v1/admin/reports/:id", adminReportActionBodyLimit, async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return context.json({ error: "Invalid JSON body." }, 400);
    }

    const action = AdminReportActionSchema.safeParse(payload);
    if (!action.success) {
      const isCorrection = typeof payload === "object" && payload !== null &&
        "action" in payload && payload.action === "apply_correction";
      return context.json(
        { error: "Invalid report action.", issues: action.error.flatten() },
        isCorrection ? 422 : 400,
      );
    }

    try {
      const report = await repository.updateAdminReport(
        context.req.param("id"),
        action.data,
        context.get("adminUser").id,
      );
      const message = action.data.action === "start_review"
        ? "Report marked as under review."
        : action.data.action === "reject"
          ? "Report rejected with review notes."
          : "The corrected calendar is now published and the report is resolved.";
      return context.json(AdminReportResponseSchema.parse({ report, message }));
    } catch (error) {
      if (error instanceof AdminReportNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof AdminReportTransitionError) {
        return context.json({ error: error.message, code: "REPORT_STATUS_CONFLICT" }, 409);
      }
      if (error instanceof AdminCorrectionConflictError) {
        return context.json({ error: error.message, code: "CALENDAR_VERSION_CONFLICT" }, 409);
      }
      if (error instanceof AdminCorrectionValidationError) {
        return context.json({ error: error.message, code: "INVALID_CALENDAR_CORRECTION" }, 422);
      }
      if (error instanceof AdminReviewerAuthorizationError) {
        return context.json({ error: error.message, code: "ADMIN_FORBIDDEN" }, 403);
      }
      throw error;
    }
  });

  app.get("/api/v1/schools", async (context) => {
    const query = context.req.query("q")?.trim() ?? "";
    if (query.length > 160) {
      return context.json({ error: "Search using 160 characters or fewer." }, 400);
    }
    return context.json(SchoolSearchResponseSchema.parse(await repository.searchSchools(query)));
  });

  app.post("/api/v1/schools", schoolCreateBodyLimit, async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return context.json({ error: "Invalid JSON body." }, 400);
    }

    const result = SchoolCreateRequestSchema.safeParse(payload);
    if (!result.success) {
      return context.json({ error: "Enter a full school name and location.", issues: result.error.flatten() }, 400);
    }

    if (schoolCreationRateLimit) {
      const now = Date.now();
      schoolCreationTimestamps = schoolCreationTimestamps.filter(
        (createdAt) => createdAt > now - schoolCreationRateLimit.windowMs,
      );
      if (schoolCreationTimestamps.length >= schoolCreationRateLimit.maxCreations) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((schoolCreationTimestamps[0]! + schoolCreationRateLimit.windowMs - now) / 1000),
        );
        context.header("Retry-After", String(retryAfterSeconds));
        return context.json({
          error: "Too many schools were added recently. Try again later.",
          code: "SCHOOL_CREATION_RATE_LIMITED",
        }, 429);
      }
      schoolCreationTimestamps.push(now);
    }

    const created = await repository.createSchool(result.data);
    if (created.alertId && schoolSimilarityAlertQueue) {
      void schoolSimilarityAlertQueue.enqueue(created.alertId).catch((error) => {
        // The alert was committed atomically with the school and the recovery
        // worker will retry it. Notification infrastructure never blocks a
        // trusted user from creating the school they entered.
        console.error("School similarity alert enqueue failed", error);
      });
    }

    return context.json(SchoolCreateResponseSchema.parse({
      school: created.school,
      similarSchools: created.similarSchools,
      alertQueued: created.alertId !== null,
    }), 201);
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
      if (!calendarExtractionQueue) {
        return context.json(
          {
            error: "Automatic calendar processing is not configured yet.",
            code: "CALENDAR_PROCESSING_NOT_CONFIGURED",
          },
          503,
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

      try {
        await calendarExtractionQueue.enqueue(submission.id);
      } catch (error) {
        console.error("Calendar extraction enqueue failed", error);
        try {
          await repository.failCalendarExtraction(
            submission.id,
            "The background extraction service could not accept this submission.",
          );
        } catch (cleanupError) {
          console.error("Calendar extraction enqueue cleanup failed", cleanupError);
        }
        return context.json(
          {
            error: "The calendar was saved, but automatic processing could not start. Please try again.",
            code: "CALENDAR_PROCESSING_UNAVAILABLE",
          },
          503,
        );
      }

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
    const yearResult = AcademicYearSchema.safeParse(context.req.query("year"));
    if (!yearResult.success) return context.json({ error: "Invalid academic year." }, 400);

    const schoolIds = [
      ...new Set(
        (context.req.query("schools") ?? "")
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
