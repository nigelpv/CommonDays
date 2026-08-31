export type ExtractionEventKind = "break" | "holiday" | "no_classes";
export type PublishableCalendarEventKind = ExtractionEventKind | "term_boundary";

export interface CalendarExtractionSourceFile {
  uploadId: string;
  position: number;
  originalFilename: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  content: Uint8Array;
}

export interface CalendarExtractionInput {
  calendarId: string;
  schoolId: string;
  schoolName: string;
  academicYear: string;
  files: CalendarExtractionSourceFile[];
}

export interface ModelExtractedCalendarEvent {
  name: string;
  kind: ExtractionEventKind;
  startDate: string;
  endDate: string;
  sourceFilePosition: number;
  sourcePage: number | null;
  sourceText: string;
}

/**
 * A continuous span during which the selected calendar population may have
 * ordinary classes, exams, or another required assessment. The labels used by
 * a source (term, quarter, block, module, session, and so on) are deliberately
 * not normalized into a cadence enum.
 */
export interface ModelExtractedCalendarActivityPeriod {
  name: string;
  startDate: string;
  endDate: string;
  startSourceFilePosition: number;
  startSourcePage: number | null;
  startSourceText: string;
  endSourceFilePosition: number;
  endSourcePage: number | null;
  endSourceText: string;
}

export interface ModelExtractedCalendar {
  complete: boolean;
  matchesRequestedSchool: boolean;
  matchesRequestedAcademicYear: boolean;
  warnings: string[];
  // Optional at the TypeScript boundary so older callers fail through the
  // deterministic publication gate instead of becoming compile-time hazards.
  // Gemini output and every newly publishable extraction require this field.
  activityPeriods?: ModelExtractedCalendarActivityPeriod[];
  events: ModelExtractedCalendarEvent[];
}

export interface CalendarExtractor {
  readonly model: string;
  extract(input: CalendarExtractionInput): Promise<ModelExtractedCalendar>;
}

export interface PublishableCalendarEvent {
  name: string;
  kind: PublishableCalendarEventKind;
  startDate: string;
  endDate: string;
  sourceUploadId: string | null;
  sourcePage: number | null;
  rawText: string | null;
  isDerived: boolean;
}

export interface PublishableCalendarActivityPeriod {
  name: string;
  startDate: string;
  endDate: string;
  startSourceUploadId: string;
  startSourcePage: number | null;
  startRawText: string;
  endSourceUploadId: string;
  endSourcePage: number | null;
  endRawText: string;
}

export interface CalendarExtractionClaim {
  calendarId: string;
  leaseToken: string;
}
