import {
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
