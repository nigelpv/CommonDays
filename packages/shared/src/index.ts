import { z } from "zod";
import { CALENDAR_UPLOAD_MAX_SCREENSHOTS } from "./upload-limits.js";

export { getAcademicYearDateWindow } from "./academic-year.js";

export {
  CALENDAR_UPLOAD_IMAGE_TYPES,
  CALENDAR_UPLOAD_MAX_FILE_BYTES,
  CALENDAR_UPLOAD_MAX_SCREENSHOTS,
  CALENDAR_UPLOAD_MAX_TOTAL_BYTES,
} from "./upload-limits.js";

export const AcademicYearSchema = z.string().regex(/^\d{4}-\d{2}$/);

export const SchoolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shortName: z.string().min(1),
  location: z.string().min(1),
  initials: z.string().min(2).max(3),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  availableYears: z.array(AcademicYearSchema),
});

export const SimilarSchoolSchema = SchoolSchema.extend({
  similarity: z.number().min(0).max(1),
});

export const SchoolSearchResponseSchema = z.object({
  schools: z.array(SchoolSchema),
  similarSchools: z.array(SimilarSchoolSchema),
}).strict();

const SchoolDirectoryTextSchema = z.string().trim().refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "Use visible text without control characters.",
);

export const SchoolCreateRequestSchema = z.object({
  name: SchoolDirectoryTextSchema.min(3).max(160).refine(
    (value) => (value.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2,
    "Enter a school name with at least two letters or numbers.",
  ),
  location: SchoolDirectoryTextSchema.min(2).max(160).refine(
    (value) => /[\p{L}\p{N}]/u.test(value),
    "Enter a location with a letter or number.",
  ),
}).strict();

export const SchoolCreateResponseSchema = z.object({
  school: SchoolSchema,
  similarSchools: z.array(SimilarSchoolSchema),
  alertQueued: z.boolean(),
}).strict();

export const CalendarEventSchema = z.object({
  id: z.string().min(1),
  schoolId: z.string().min(1),
  name: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  kind: z.enum(["break", "holiday", "no_classes", "term_boundary"]),
});

export const CalendarComparisonSchema = z.object({
  academicYear: AcademicYearSchema,
  schools: z.array(SchoolSchema),
  events: z.array(CalendarEventSchema),
  source: z.literal("supabase"),
});

export const CalendarReportSchema = z.object({
  schoolId: z.string().min(1),
  academicYear: AcademicYearSchema,
  eventId: z.string().optional(),
  reason: z.enum(["wrong_date", "missing_date", "wrong_name", "other"]),
  details: z.string().trim().min(10).max(1000),
});

export const AdminReportStatusSchema = z.enum([
  "submitted",
  "reviewing",
  "resolved",
  "rejected",
]);

export const AdminReportSchema = z.object({
  id: z.string().min(1),
  calendarId: z.string().min(1),
  schoolId: z.string().min(1),
  schoolName: z.string().min(1),
  schoolShortName: z.string().min(1),
  academicYear: AcademicYearSchema,
  eventId: z.string().min(1).nullable(),
  eventName: z.string().min(1).nullable(),
  eventStartDate: z.string().date().nullable(),
  eventEndDate: z.string().date().nullable(),
  eventKind: CalendarEventSchema.shape.kind.nullable(),
  reason: CalendarReportSchema.shape.reason,
  details: z.string().min(1),
  status: AdminReportStatusSchema,
  createdAt: z.string().datetime(),
  resolutionNotes: z.string().nullable(),
  resolutionCalendarId: z.string().min(1).nullable(),
  resolvedAt: z.string().datetime().nullable(),
}).strict();

export const AdminReportsResponseSchema = z.object({
  reports: z.array(AdminReportSchema),
}).strict();

export const AdminReportListResponseSchema = AdminReportsResponseSchema;

export const AdminIdentitySchema = z.object({
  id: z.string().min(1),
  email: z.string().email().nullable(),
}).strict();

export const AdminMeResponseSchema = z.object({
  admin: AdminIdentitySchema,
}).strict();

export const AdminSessionResponseSchema = AdminMeResponseSchema;

export const AdminCalendarVersionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
}).strict();

export const AdminEditableEventSchema = z.object({
  id: z.string().min(1),
  lineageId: z.string().min(1),
  name: z.string().min(1),
  kind: CalendarEventSchema.shape.kind,
  startDate: z.string().date(),
  endDate: z.string().date(),
  sourceUploadId: z.string().min(1).nullable(),
  sourcePage: z.number().int().positive().nullable(),
  rawText: z.string().nullable(),
  isDerived: z.boolean(),
}).strict();

export const AdminEditableActivityPeriodSchema = z.object({
  id: z.string().min(1),
  lineageId: z.string().min(1),
  name: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  startSourceUploadId: z.string().min(1).nullable(),
  startSourcePage: z.number().int().positive().nullable(),
  startRawText: z.string().min(1),
  endSourceUploadId: z.string().min(1).nullable(),
  endSourcePage: z.number().int().positive().nullable(),
  endRawText: z.string().min(1),
}).strict();

export const AdminReportSourceFileSchema = z.object({
  id: z.string().min(1),
  fileType: z.enum(["image", "pdf"]),
  position: z.number().int().min(1).max(CALENDAR_UPLOAD_MAX_SCREENSHOTS),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
}).strict();

export const AdminReportDetailSchema = AdminReportSchema.extend({
  reportedCalendar: AdminCalendarVersionSchema,
  currentCalendar: AdminCalendarVersionSchema,
  currentEvent: AdminEditableEventSchema.nullable(),
  currentEvents: z.array(AdminEditableEventSchema),
  currentPeriods: z.array(AdminEditableActivityPeriodSchema),
  sourceFiles: z.array(AdminReportSourceFileSchema),
}).strict();

export const AdminReportDetailResponseSchema = z.object({
  report: AdminReportDetailSchema,
}).strict();

export const AdminReportSourceUrlResponseSchema = z.object({
  url: z.string().url().refine(
    (value) => new URL(value).protocol === "https:",
    "Private source links must use HTTPS.",
  ),
  expiresAt: z.string().datetime(),
}).strict();

export const AdminCorrectionEvidenceSchema = z.object({
  uploadId: z.string().min(1),
  sourcePage: z.number().int().positive().nullable(),
  rawText: z.string().trim().min(1).max(4000),
}).strict();

const AdminCorrectionNameSchema = z.string().trim().min(1).max(160);
const AdminCorrectableEventKindSchema = z.enum(["break", "holiday", "no_classes"]);

export const AdminCorrectionOperationSchema = z.enum([
  "add_event",
  "update_event",
  "delete_event",
  "add_period",
  "update_period",
  "delete_period",
]);

export const AdminCalendarCorrectionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("add_event"),
    name: AdminCorrectionNameSchema,
    kind: AdminCorrectableEventKindSchema,
    startDate: z.string().date(),
    endDate: z.string().date(),
    evidence: AdminCorrectionEvidenceSchema,
  }).strict(),
  z.object({
    operation: z.literal("update_event"),
    targetLineageId: z.string().min(1),
    name: AdminCorrectionNameSchema,
    kind: AdminCorrectableEventKindSchema,
    startDate: z.string().date(),
    endDate: z.string().date(),
    evidence: AdminCorrectionEvidenceSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal("delete_event"),
    targetLineageId: z.string().min(1),
  }).strict(),
  z.object({
    operation: z.literal("add_period"),
    name: AdminCorrectionNameSchema,
    startDate: z.string().date(),
    endDate: z.string().date(),
    startEvidence: AdminCorrectionEvidenceSchema,
    endEvidence: AdminCorrectionEvidenceSchema,
  }).strict(),
  z.object({
    operation: z.literal("update_period"),
    targetLineageId: z.string().min(1),
    name: AdminCorrectionNameSchema,
    startDate: z.string().date(),
    endDate: z.string().date(),
    startEvidence: AdminCorrectionEvidenceSchema.optional(),
    endEvidence: AdminCorrectionEvidenceSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal("delete_period"),
    targetLineageId: z.string().min(1),
  }).strict(),
]).superRefine((correction, context) => {
  if ("startDate" in correction && correction.endDate < correction.startDate) {
    context.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "The end date must be on or after the start date.",
    });
  }
});

export const AdminReportActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review") }).strict(),
  z.object({
    action: z.literal("reject"),
    resolutionNotes: z.string().trim().min(3).max(1000),
  }).strict(),
  z.object({
    action: z.literal("apply_correction"),
    operationId: z.string().uuid(),
    expectedCalendarId: z.string().min(1),
    expectedCalendarVersion: z.number().int().positive(),
    resolutionNotes: z.string().trim().min(3).max(1000),
    correction: AdminCalendarCorrectionSchema,
  }).strict(),
]);

export const AdminReportResponseSchema = z.object({
  report: AdminReportSchema,
  message: z.string().min(1).optional(),
}).strict();

const CalendarAvailabilityBaseSchema = z.object({
  schoolId: z.string().min(1),
  academicYear: AcademicYearSchema,
});

export const CalendarAvailabilitySchema = z.discriminatedUnion("status", [
  CalendarAvailabilityBaseSchema.extend({ status: z.literal("available") }).strict(),
  CalendarAvailabilityBaseSchema.extend({ status: z.literal("missing") }).strict(),
  CalendarAvailabilityBaseSchema.extend({
    status: z.literal("processing"),
    submissionId: z.string().uuid(),
  }).strict(),
]);

export const CalendarSubmissionRequestSchema = z.object({
  schoolId: z.string().min(1),
  academicYear: AcademicYearSchema,
});

const CalendarSubmissionBaseSchema = z.object({
  id: z.string().uuid(),
  schoolId: z.string().min(1),
  academicYear: AcademicYearSchema,
  status: z.enum(["processing", "ready", "failed"]),
  createdAt: z.string().datetime(),
});

export const CalendarSubmissionSchema = z.discriminatedUnion("sourceType", [
  CalendarSubmissionBaseSchema.extend({
    sourceType: z.literal("screenshots"),
    fileCount: z.number().int().min(1).max(CALENDAR_UPLOAD_MAX_SCREENSHOTS),
  }),
  CalendarSubmissionBaseSchema.extend({
    sourceType: z.literal("pdf"),
    fileCount: z.literal(1),
  }),
]);

export type School = z.infer<typeof SchoolSchema>;
export type SimilarSchool = z.infer<typeof SimilarSchoolSchema>;
export type SchoolSearchResponse = z.infer<typeof SchoolSearchResponseSchema>;
export type SchoolCreateRequest = z.infer<typeof SchoolCreateRequestSchema>;
export type SchoolCreateResponse = z.infer<typeof SchoolCreateResponseSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarComparison = z.infer<typeof CalendarComparisonSchema>;
export type CalendarReport = z.infer<typeof CalendarReportSchema>;
export type AdminReportStatus = z.infer<typeof AdminReportStatusSchema>;
export type AdminReport = z.infer<typeof AdminReportSchema>;
export type AdminReportsResponse = z.infer<typeof AdminReportsResponseSchema>;
export type AdminReportListResponse = AdminReportsResponse;
export type AdminIdentity = z.infer<typeof AdminIdentitySchema>;
export type AdminMeResponse = z.infer<typeof AdminMeResponseSchema>;
export type AdminSessionResponse = AdminMeResponse;
export type AdminCalendarVersion = z.infer<typeof AdminCalendarVersionSchema>;
export type AdminEditableEvent = z.infer<typeof AdminEditableEventSchema>;
export type AdminEditableActivityPeriod = z.infer<typeof AdminEditableActivityPeriodSchema>;
export type AdminReportSourceFile = z.infer<typeof AdminReportSourceFileSchema>;
export type AdminReportDetail = z.infer<typeof AdminReportDetailSchema>;
export type AdminReportDetailResponse = z.infer<typeof AdminReportDetailResponseSchema>;
export type AdminReportSourceUrlResponse = z.infer<typeof AdminReportSourceUrlResponseSchema>;
export type AdminCorrectionEvidence = z.infer<typeof AdminCorrectionEvidenceSchema>;
export type AdminCorrectionOperation = z.infer<typeof AdminCorrectionOperationSchema>;
export type AdminCalendarCorrection = z.infer<typeof AdminCalendarCorrectionSchema>;
export type AdminReportAction = z.infer<typeof AdminReportActionSchema>;
export type AdminReportResponse = z.infer<typeof AdminReportResponseSchema>;
export type CalendarAvailability = z.infer<typeof CalendarAvailabilitySchema>;
export type CalendarSubmissionRequest = z.infer<typeof CalendarSubmissionRequestSchema>;
export type CalendarSubmission = z.infer<typeof CalendarSubmissionSchema>;
