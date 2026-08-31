import { describe, expect, it } from "vitest";
import { createTestCalendarRepository } from "../testing/calendar-repository.fixture.js";
import { prepareCalendarExtraction } from "./calendar-extraction-service.js";

describe("automatic calendar publication pipeline", () => {
  it("publishes validated AI output without creating an admin report", async () => {
    const repository = createTestCalendarRepository();
    const submission = await repository.createCalendarSubmission(
      { schoolId: "michigan", academicYear: "2027-28" },
      [{
        name: "official-calendar.pdf",
        mimeType: "application/pdf",
        size: 12,
        content: new TextEncoder().encode("%PDF-1.7\n"),
      }],
    );
    const claim = await repository.claimCalendarExtraction(submission.id);
    expect(claim).not.toBeNull();

    const input = await repository.getCalendarExtractionInput(claim!);
    const prepared = prepareCalendarExtraction(input, {
      complete: true,
      matchesRequestedSchool: true,
      matchesRequestedAcademicYear: true,
      warnings: [],
      activityPeriods: [
        {
          name: "Autumn Block",
          startDate: "2027-08-24",
          endDate: "2027-12-18",
          startSourceFilePosition: 1,
          startSourcePage: 2,
          startSourceText: "Autumn Block classes begin August 24",
          endSourceFilePosition: 1,
          endSourcePage: 2,
          endSourceText: "Autumn Block final examinations end December 18",
        },
        {
          name: "Winter Quarter",
          startDate: "2028-01-13",
          endDate: "2028-05-06",
          startSourceFilePosition: 1,
          startSourcePage: 2,
          startSourceText: "Winter Quarter classes begin January 13",
          endSourceFilePosition: 1,
          endSourcePage: 2,
          endSourceText: "Winter Quarter final examinations end May 6",
        },
      ],
      events: [{
        name: "Thanksgiving recess",
        kind: "break",
        startDate: "2027-11-24",
        endDate: "2027-11-28",
        sourceFilePosition: 1,
        sourcePage: 2,
        sourceText: "November 24-28 Thanksgiving recess, no classes",
      }],
    });

    await repository.publishCalendarExtraction(
      claim!,
      "gemini-3.5-flash-lite",
      prepared.periods,
      prepared.events,
      prepared.resultHash,
    );

    await expect(repository.getCalendarSubmission(submission.id)).resolves.toMatchObject({
      status: "ready",
    });
    await expect(repository.getAvailability("michigan", "2027-28")).resolves.toMatchObject({
      status: "available",
    });
    const comparison = await repository.getComparison({
      academicYear: "2027-28",
      schoolIds: ["michigan"],
    });
    expect(comparison.events).toMatchObject([
      {
        schoolId: "michigan",
        name: "Thanksgiving recess",
        startDate: "2027-11-24",
        endDate: "2027-11-28",
      },
      {
        schoolId: "michigan",
        kind: "term_boundary",
        startDate: "2027-12-19",
        endDate: "2028-01-12",
      },
    ]);
    await expect(repository.listAdminReports()).resolves.toEqual([]);
  });

  it("keeps failed extraction unpublished and out of the admin report queue", async () => {
    const repository = createTestCalendarRepository();
    const submission = await repository.createCalendarSubmission(
      { schoolId: "michigan", academicYear: "2028-29" },
      [{
        name: "calendar.png",
        mimeType: "image/png",
        size: 3,
        content: new Uint8Array([1, 2, 3]),
      }],
    );

    await repository.failCalendarExtraction(submission.id, "Incomplete calendar");

    await expect(repository.getCalendarSubmission(submission.id)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(repository.getAvailability("michigan", "2028-29")).resolves.toMatchObject({
      status: "missing",
    });
    await expect(repository.listAdminReports()).resolves.toEqual([]);
  });
});
