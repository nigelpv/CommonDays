import { describe, expect, it } from "vitest";
import type {
  CalendarExtractionInput,
  ModelExtractedCalendar,
  PublishableCalendarActivityPeriod,
} from "./types.js";
import {
  CalendarExtractionValidationError,
  deriveInternalCalendarGaps,
  prepareCalendarExtraction,
} from "./calendar-extraction-service.js";

const input: CalendarExtractionInput = {
  calendarId: "3f72ea79-93b3-4ff2-937c-e689f7d4a33e",
  schoolId: "uiuc",
  schoolName: "University of Illinois Urbana-Champaign",
  academicYear: "2026-27",
  files: [
    {
      uploadId: "64ba0a2b-2a27-4f90-8cab-47a4a75fe31c",
      position: 1,
      originalFilename: "calendar.pdf",
      mimeType: "application/pdf",
      content: new Uint8Array([1, 2, 3]),
    },
  ],
};

function extraction(overrides: Partial<ModelExtractedCalendar> = {}): ModelExtractedCalendar {
  return {
    complete: true,
    matchesRequestedSchool: true,
    matchesRequestedAcademicYear: true,
    warnings: [],
    activityPeriods: [
      {
        name: "  Fall   Block 4 ",
        startDate: "2026-08-24",
        endDate: "2026-12-18",
        startSourceFilePosition: 1,
        startSourcePage: 1,
        startSourceText: " Fall Block 4 begins August 24. ",
        endSourceFilePosition: 1,
        endSourcePage: 2,
        endSourceText: " Final assessments end December 18. ",
      },
      {
        name: "Winter Term",
        startDate: "2027-01-18",
        endDate: "2027-05-07",
        startSourceFilePosition: 1,
        startSourcePage: 3,
        startSourceText: "Winter Term classes begin January 18.",
        endSourceFilePosition: 1,
        endSourcePage: 4,
        endSourceText: "Winter Term examinations end May 7.",
      },
    ],
    events: [
      {
        name: "  Winter   break ",
        kind: "break",
        startDate: "2026-12-19",
        endDate: "2027-01-17",
        sourceFilePosition: 1,
        sourcePage: 3,
        sourceText: "  Winter recess: December 19 through January 17. ",
      },
    ],
    ...overrides,
  };
}

describe("calendar extraction publication gate", () => {
  it("normalizes validated events and maps source positions to upload IDs", () => {
    const result = prepareCalendarExtraction(input, extraction());

    expect(result.periods).toEqual([
      expect.objectContaining({
        name: "Fall Block 4",
        startDate: "2026-08-24",
        endDate: "2026-12-18",
        startSourceUploadId: input.files[0].uploadId,
        startRawText: "Fall Block 4 begins August 24.",
        endSourceUploadId: input.files[0].uploadId,
        endRawText: "Final assessments end December 18.",
      }),
      expect.objectContaining({ name: "Winter Term" }),
    ]);
    expect(result.events).toEqual([
      {
        name: "Between Fall Block 4 and Winter Term",
        kind: "term_boundary",
        startDate: "2026-12-19",
        endDate: "2027-01-17",
        sourceUploadId: null,
        sourcePage: null,
        rawText: null,
        isDerived: true,
      },
      {
        name: "Winter break",
        kind: "break",
        startDate: "2026-12-19",
        endDate: "2027-01-17",
        sourceUploadId: input.files[0].uploadId,
        sourcePage: 3,
        rawText: "Winter recess: December 19 through January 17.",
        isDerived: false,
      },
    ]);
    expect(result.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["incomplete", { complete: false }],
    ["wrong school", { matchesRequestedSchool: false }],
    ["wrong year", { matchesRequestedAcademicYear: false }],
    ["warnings", { warnings: ["The spring page is missing."] }],
    ["missing activity periods", { activityPeriods: [] }],
  ])("rejects %s model output", (_label, overrides) => {
    expect(() => prepareCalendarExtraction(input, extraction(overrides))).toThrow(
      CalendarExtractionValidationError,
    );
  });

  it("allows an extraction with no explicit no-class events", () => {
    const result = prepareCalendarExtraction(input, extraction({ events: [] }));

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "term_boundary",
        startDate: "2026-12-19",
        endDate: "2027-01-17",
        isDerived: true,
      }),
    ]);
  });

  it("does not invent outer-edge gaps when a complete source has one activity period", () => {
    const result = prepareCalendarExtraction(input, extraction({
      activityPeriods: [extraction().activityPeriods![0]],
      events: [],
    }));

    expect(result.periods).toHaveLength(1);
    expect(result.events).toEqual([]);
  });

  it("rejects reversed, invalid, and out-of-window dates", () => {
    const cases = [
      { startDate: "2027-02-10", endDate: "2027-02-01" },
      { startDate: "2027-02-30", endDate: "2027-03-01" },
      { startDate: "2028-01-01", endDate: "2028-01-02" },
    ];

    for (const dates of cases) {
      expect(() => prepareCalendarExtraction(input, extraction({
        events: [{ ...extraction().events[0], ...dates }],
      }))).toThrow(CalendarExtractionValidationError);
    }
  });

  it("accepts source-backed dates throughout both named calendar years", () => {
    const result = prepareCalendarExtraction(input, extraction({
      events: [
        {
          ...extraction().events[0],
          name: "January closure",
          startDate: "2026-01-12",
          endDate: "2026-01-12",
          sourceText: "January 12 university holiday, no classes",
        },
        {
          ...extraction().events[0],
          name: "December closure",
          startDate: "2027-12-03",
          endDate: "2027-12-03",
          sourceText: "December 3 university holiday, no classes",
        },
      ],
    }));

    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ startDate: "2026-01-12" }),
      expect.objectContaining({ startDate: "2027-12-03" }),
    ]));
  });

  it("rejects partial-day or time-of-day evidence before automatic publication", () => {
    expect(() => prepareCalendarExtraction(input, extraction({
      events: [{
        ...extraction().events[0],
        name: "Vacation begins",
        startDate: "2027-03-06",
        endDate: "2027-03-14",
        sourceText: "Vacation begins at 12:00 noon Saturday, March 6",
      }],
    }))).toThrow(/partial-day or time-of-day/i);
  });

  it("rejects unknown provenance, duplicate events, and missing PDF pages", () => {
    expect(() => prepareCalendarExtraction(input, extraction({
      events: [{ ...extraction().events[0], sourceFilePosition: 2 }],
    }))).toThrow("unknown source file");

    expect(() => prepareCalendarExtraction(input, extraction({
      events: [extraction().events[0], { ...extraction().events[0] }],
    }))).toThrow("duplicate events");

    expect(() => prepareCalendarExtraction(input, extraction({
      events: [{ ...extraction().events[0], sourcePage: null }],
    }))).toThrow("source page");
  });

  it("rejects invalid, duplicate, and unproven activity periods", () => {
    const basePeriod = extraction().activityPeriods![0];

    expect(() => prepareCalendarExtraction(input, extraction({
      activityPeriods: [{ ...basePeriod, startDate: "2027-02-01", endDate: "2027-01-31" }],
    }))).toThrow("ends before it starts");
    expect(() => prepareCalendarExtraction(input, extraction({
      activityPeriods: [basePeriod, { ...basePeriod }],
    }))).toThrow("duplicate activity periods");
    expect(() => prepareCalendarExtraction(input, extraction({
      activityPeriods: [{ ...basePeriod, endSourceFilePosition: 2 }],
    }))).toThrow("unknown source file");
    expect(() => prepareCalendarExtraction(input, extraction({
      activityPeriods: [{ ...basePeriod, endSourcePage: null }],
    }))).toThrow("source page");
  });

  it("requires screenshots to use their file position instead of a PDF page", () => {
    const screenshotInput: CalendarExtractionInput = {
      ...input,
      files: [{ ...input.files[0], mimeType: "image/png", originalFilename: "page.png" }],
    };

    expect(() => prepareCalendarExtraction(screenshotInput, extraction())).toThrow(
      "must not claim a PDF page number",
    );
    const result = prepareCalendarExtraction(screenshotInput, extraction({
      activityPeriods: extraction().activityPeriods!.map((period) => ({
        ...period,
        startSourcePage: null,
        endSourcePage: null,
      })),
      events: [{ ...extraction().events[0], sourcePage: null }],
    }));
    expect(result.events[0].sourcePage).toBeNull();
    expect(result.periods[0].startSourcePage).toBeNull();
  });

  it("derives only internal gaps and merges overlapping or adjacent periods", () => {
    const period = (
      name: string,
      startDate: string,
      endDate: string,
    ): PublishableCalendarActivityPeriod => ({
      name,
      startDate,
      endDate,
      startSourceUploadId: input.files[0].uploadId,
      startSourcePage: 1,
      startRawText: `${name} begins`,
      endSourceUploadId: input.files[0].uploadId,
      endSourcePage: 1,
      endRawText: `${name} ends`,
    });

    const gaps = deriveInternalCalendarGaps([
      period("Module A", "2026-08-01", "2026-09-10"),
      period("Overlapping Session", "2026-09-01", "2026-09-20"),
      period("Adjacent Session", "2026-09-21", "2026-10-01"),
      period("Quarter Two", "2026-10-05", "2026-12-15"),
    ]);

    expect(gaps).toEqual([
      expect.objectContaining({
        startDate: "2026-10-02",
        endDate: "2026-10-04",
        sourceUploadId: null,
        isDerived: true,
      }),
    ]);
    expect(gaps.some((gap) => gap.startDate < "2026-08-01" || gap.endDate > "2026-12-15")).toBe(false);
  });

  it("includes period evidence in the deterministic result hash", () => {
    const first = prepareCalendarExtraction(input, extraction());
    const changed = extraction();
    changed.activityPeriods = changed.activityPeriods!.map((period, index) => index === 0
      ? { ...period, endSourceText: "A corrected final-assessment excerpt." }
      : period);
    const second = prepareCalendarExtraction(input, changed);

    expect(first.resultHash).not.toBe(second.resultHash);
  });
});
