import {
  AdminReportActionSchema,
  AdminReportSourceUrlResponseSchema,
  CalendarAvailabilitySchema,
  CalendarSubmissionSchema,
} from "@commondays/shared";
import { describe, expect, it } from "vitest";

const submissionBase = {
  id: "2b04a109-31e1-4b14-a0fd-cbd6df1d826a",
  schoolId: "michigan",
  academicYear: "2026-27",
  status: "processing",
  createdAt: "2026-08-24T12:00:00.000Z",
} as const;

describe("admin source contracts", () => {
  it("accepts only HTTPS private preview links", () => {
    const expiresAt = "2026-08-30T18:00:00.000Z";
    expect(AdminReportSourceUrlResponseSchema.safeParse({
      url: "https://storage.example.test/source.pdf?token=short-lived",
      expiresAt,
    }).success).toBe(true);
    expect(AdminReportSourceUrlResponseSchema.safeParse({
      url: "javascript:alert(1)",
      expiresAt,
    }).success).toBe(false);
    expect(AdminReportSourceUrlResponseSchema.safeParse({
      url: "http://storage.example.test/source.pdf",
      expiresAt,
    }).success).toBe(false);
  });

  it("requires source evidence when an admin adds a free-day event", () => {
    const action = {
      action: "apply_correction",
      operationId: "10000000-0000-4000-8000-000000000001",
      expectedCalendarId: "calendar-id",
      expectedCalendarVersion: 1,
      resolutionNotes: "Added the missing closure from the official calendar.",
      correction: {
        operation: "add_event",
        name: "Founders Day",
        kind: "no_classes",
        startDate: "2027-02-12",
        endDate: "2027-02-12",
      },
    };

    expect(AdminReportActionSchema.safeParse(action).success).toBe(false);
    expect(AdminReportActionSchema.safeParse({
      ...action,
      correction: {
        ...action.correction,
        evidence: {
          uploadId: "official-calendar.pdf",
          sourcePage: 1,
          rawText: "Founders Day — no classes",
        },
      },
    }).success).toBe(true);
  });
});

describe("calendar upload contracts", () => {
  it("requires a submission ID only while availability is processing", () => {
    expect(
      CalendarAvailabilitySchema.safeParse({
        schoolId: "michigan",
        academicYear: "2026-27",
        status: "processing",
      }).success,
    ).toBe(false);
    expect(
      CalendarAvailabilitySchema.safeParse({
        schoolId: "michigan",
        academicYear: "2026-27",
        status: "missing",
      }).success,
    ).toBe(true);
    expect(
      CalendarAvailabilitySchema.safeParse({
        schoolId: "michigan",
        academicYear: "2026-27",
        status: "missing",
        submissionId: "2b04a109-31e1-4b14-a0fd-cbd6df1d826a",
      }).success,
    ).toBe(false);
  });

  it("enforces the file count for each upload source", () => {
    expect(
      CalendarSubmissionSchema.safeParse({ ...submissionBase, sourceType: "pdf", fileCount: 1 }).success,
    ).toBe(true);
    expect(
      CalendarSubmissionSchema.safeParse({ ...submissionBase, sourceType: "pdf", fileCount: 2 }).success,
    ).toBe(false);
    expect(
      CalendarSubmissionSchema.safeParse({ ...submissionBase, sourceType: "screenshots", fileCount: 10 }).success,
    ).toBe(true);
    expect(
      CalendarSubmissionSchema.safeParse({ ...submissionBase, sourceType: "screenshots", fileCount: 11 }).success,
    ).toBe(false);
  });
});
