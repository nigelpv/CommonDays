import { createHash } from "node:crypto";
import { getAcademicYearDateWindow } from "@commondays/shared/academic-year";
import { z } from "zod";
import type {
  CalendarExtractionInput,
  ModelExtractedCalendar,
  PublishableCalendarActivityPeriod,
  PublishableCalendarEvent,
} from "./types.js";

const isoDateSchema = z.string().date();

export class CalendarExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarExtractionValidationError";
  }
}

export interface PreparedCalendarExtraction {
  periods: PublishableCalendarActivityPeriod[];
  events: PublishableCalendarEvent[];
  resultHash: string;
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

const partialDayEvidencePatterns = [
  /\b(?:noon|midnight|morning|afternoon|evening|half[- ]day)\b/i,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i,
  /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/i,
];

function compareByDateAndName(
  left: { startDate: string; endDate: string; name: string },
  right: { startDate: string; endDate: string; name: string },
) {
  return left.startDate.localeCompare(right.startDate)
    || left.endDate.localeCompare(right.endDate)
    || left.name.localeCompare(right.name, "en-US");
}

function addIsoDays(value: string, amount: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

interface MergedActivityRange {
  startDate: string;
  endDate: string;
  names: string[];
}

function mergedActivityRanges(periods: PublishableCalendarActivityPeriod[]) {
  const ranges: MergedActivityRange[] = [];
  for (const period of [...periods].sort(compareByDateAndName)) {
    const current = ranges.at(-1);
    if (!current || period.startDate > addIsoDays(current.endDate, 1)) {
      ranges.push({ startDate: period.startDate, endDate: period.endDate, names: [period.name] });
      continue;
    }

    if (period.endDate > current.endDate) current.endDate = period.endDate;
    if (!current.names.includes(period.name)) current.names.push(period.name);
  }
  return ranges;
}

function rangeLabel(names: string[]) {
  return names.length === 1 ? names[0]! : "academic periods";
}

/**
 * Finds only fully bounded gaps between confirmed academic-obligation ranges.
 * Dates before the first period and after the last period intentionally remain
 * unknown because an uploaded calendar does not prove either outer edge free.
 */
export function deriveInternalCalendarGaps(
  periods: PublishableCalendarActivityPeriod[],
): PublishableCalendarEvent[] {
  const ranges = mergedActivityRanges(periods);
  const gaps: PublishableCalendarEvent[] = [];

  for (let index = 0; index < ranges.length - 1; index += 1) {
    const left = ranges[index]!;
    const right = ranges[index + 1]!;
    const startDate = addIsoDays(left.endDate, 1);
    const endDate = addIsoDays(right.startDate, -1);
    if (endDate < startDate) continue;

    gaps.push({
      name: `Between ${rangeLabel(left.names)} and ${rangeLabel(right.names)}`.slice(0, 160),
      kind: "term_boundary",
      startDate,
      endDate,
      sourceUploadId: null,
      sourcePage: null,
      rawText: null,
      isDerived: true,
    });
  }

  return gaps;
}

export function prepareCalendarExtraction(
  input: CalendarExtractionInput,
  extraction: ModelExtractedCalendar,
): PreparedCalendarExtraction {
  if (!extraction.complete) {
    throw new CalendarExtractionValidationError("The model could not confirm that every supplied page was processed.");
  }
  if (!extraction.matchesRequestedSchool) {
    throw new CalendarExtractionValidationError("The uploaded calendar does not match the selected school.");
  }
  if (!extraction.matchesRequestedAcademicYear) {
    throw new CalendarExtractionValidationError("The uploaded calendar does not match the selected academic year.");
  }
  if (extraction.warnings.length > 0) {
    throw new CalendarExtractionValidationError("The calendar extraction contained unresolved warnings.");
  }
  if (!extraction.activityPeriods || extraction.activityPeriods.length === 0) {
    throw new CalendarExtractionValidationError("No complete academic activity periods were found.");
  }
  if (extraction.activityPeriods.length > 100) {
    throw new CalendarExtractionValidationError("The calendar extraction returned too many activity periods.");
  }
  if (extraction.events.length > 200) {
    throw new CalendarExtractionValidationError("The calendar extraction returned too many events.");
  }

  const fileByPosition = new Map(input.files.map((file) => [file.position, file]));
  if (fileByPosition.size !== input.files.length || input.files.length === 0) {
    throw new CalendarExtractionValidationError("The calendar source file order is invalid.");
  }

  let window: ReturnType<typeof getAcademicYearDateWindow>;
  try {
    window = getAcademicYearDateWindow(input.academicYear);
  } catch {
    throw new CalendarExtractionValidationError("The requested academic year is not sequential.");
  }
  const validateDateRange = (startDate: string, endDate: string, label: string) => {
    if (!isoDateSchema.safeParse(startDate).success || !isoDateSchema.safeParse(endDate).success) {
      throw new CalendarExtractionValidationError(`${label} contains an invalid date.`);
    }
    if (endDate < startDate) {
      throw new CalendarExtractionValidationError(`${label} ends before it starts.`);
    }
    if (startDate < window.startDate || endDate > window.endDate) {
      throw new CalendarExtractionValidationError(`${label} falls outside the academic-year window.`);
    }
  };

  const resolveEvidence = (
    sourceFilePosition: number,
    sourcePage: number | null,
    sourceText: string,
    label: string,
  ) => {
    const rawText = normalizeText(sourceText);
    if (!rawText || rawText.length > 500) {
      throw new CalendarExtractionValidationError(`${label} is missing concise source evidence.`);
    }

    const sourceFile = fileByPosition.get(sourceFilePosition);
    if (!sourceFile) {
      throw new CalendarExtractionValidationError(`${label} references an unknown source file.`);
    }
    if (sourceFile.mimeType === "application/pdf") {
      if (sourcePage === null || !Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 1000) {
        throw new CalendarExtractionValidationError(`A PDF ${label.toLowerCase()} is missing a valid source page.`);
      }
    } else if (sourcePage !== null) {
      throw new CalendarExtractionValidationError(`A screenshot ${label.toLowerCase()} must not claim a PDF page number.`);
    }

    return {
      sourceUploadId: sourceFile.uploadId,
      sourcePage: sourceFile.mimeType === "application/pdf" ? sourcePage : null,
      rawText,
    };
  };

  const periodNaturalKeys = new Set<string>();
  const periods = extraction.activityPeriods.map((period): PublishableCalendarActivityPeriod => {
    const name = normalizeText(period.name);
    if (!name || name.length > 160) {
      throw new CalendarExtractionValidationError("An extracted activity period name is invalid.");
    }
    validateDateRange(period.startDate, period.endDate, "An extracted activity period");

    const startEvidence = resolveEvidence(
      period.startSourceFilePosition,
      period.startSourcePage,
      period.startSourceText,
      "Activity period start evidence",
    );
    const endEvidence = resolveEvidence(
      period.endSourceFilePosition,
      period.endSourcePage,
      period.endSourceText,
      "Activity period end evidence",
    );

    const naturalKey = `${name.toLocaleLowerCase("en-US")}\u0000${period.startDate}\u0000${period.endDate}`;
    if (periodNaturalKeys.has(naturalKey)) {
      throw new CalendarExtractionValidationError("The calendar extraction contains duplicate activity periods.");
    }
    periodNaturalKeys.add(naturalKey);

    return {
      name,
      startDate: period.startDate,
      endDate: period.endDate,
      startSourceUploadId: startEvidence.sourceUploadId,
      startSourcePage: startEvidence.sourcePage,
      startRawText: startEvidence.rawText,
      endSourceUploadId: endEvidence.sourceUploadId,
      endSourcePage: endEvidence.sourcePage,
      endRawText: endEvidence.rawText,
    };
  }).sort(compareByDateAndName);

  const naturalKeys = new Set<string>();
  const explicitEvents = extraction.events.map((event): PublishableCalendarEvent => {
    const name = normalizeText(event.name);
    if (!name || name.length > 160) {
      throw new CalendarExtractionValidationError("An extracted event name is invalid.");
    }
    validateDateRange(event.startDate, event.endDate, "An extracted event");
    const evidence = resolveEvidence(
      event.sourceFilePosition,
      event.sourcePage,
      event.sourceText,
      "Event evidence",
    );
    if (partialDayEvidencePatterns.some((pattern) => pattern.test(`${name} ${evidence.rawText}`))) {
      throw new CalendarExtractionValidationError(
        "An extracted event contains partial-day or time-of-day evidence.",
      );
    }

    const naturalKey = `${name.toLocaleLowerCase("en-US")}\u0000${event.startDate}\u0000${event.endDate}`;
    if (naturalKeys.has(naturalKey)) {
      throw new CalendarExtractionValidationError("The calendar extraction contains duplicate events.");
    }
    naturalKeys.add(naturalKey);

    return {
      name,
      kind: event.kind,
      startDate: event.startDate,
      endDate: event.endDate,
      sourceUploadId: evidence.sourceUploadId,
      sourcePage: evidence.sourcePage,
      rawText: evidence.rawText,
      isDerived: false,
    };
  }).sort(compareByDateAndName);

  const events = [...explicitEvents, ...deriveInternalCalendarGaps(periods)].sort(compareByDateAndName);

  const resultHash = createHash("sha256")
    .update(JSON.stringify({ calendarId: input.calendarId, academicYear: input.academicYear, periods, events }))
    .digest("hex");

  return { periods, events, resultHash };
}
