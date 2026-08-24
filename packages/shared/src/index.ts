import { z } from "zod";

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
  source: z.literal("development_seed"),
});

export const CalendarReportSchema = z.object({
  schoolId: z.string().min(1),
  academicYear: AcademicYearSchema,
  eventId: z.string().optional(),
  reason: z.enum(["wrong_date", "missing_date", "wrong_name", "other"]),
  details: z.string().trim().min(10).max(1000),
});

export type School = z.infer<typeof SchoolSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarComparison = z.infer<typeof CalendarComparisonSchema>;
export type CalendarReport = z.infer<typeof CalendarReportSchema>;
