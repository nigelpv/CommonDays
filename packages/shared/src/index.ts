import { z } from "zod";
import { CALENDAR_UPLOAD_MAX_SCREENSHOTS } from "./upload-limits.js";

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
  source: z.enum(["development_seed", "supabase"]),
});

export const CalendarReportSchema = z.object({
  schoolId: z.string().min(1),
  academicYear: AcademicYearSchema,
  eventId: z.string().optional(),
  reason: z.enum(["wrong_date", "missing_date", "wrong_name", "other"]),
  details: z.string().trim().min(10).max(1000),
});

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
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarComparison = z.infer<typeof CalendarComparisonSchema>;
export type CalendarReport = z.infer<typeof CalendarReportSchema>;
export type CalendarAvailability = z.infer<typeof CalendarAvailabilitySchema>;
export type CalendarSubmissionRequest = z.infer<typeof CalendarSubmissionRequestSchema>;
export type CalendarSubmission = z.infer<typeof CalendarSubmissionSchema>;
