import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createTestCalendarRepository } from "./testing/calendar-repository.fixture.js";

let app: ReturnType<typeof createApp>;

function pngFile(name: string) {
  return new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), name],
    name,
    { type: "image/png" },
  );
}

function pdfFile(name = "calendar.pdf") {
  return new File(["%PDF-1.7\ncalendar"], name, { type: "application/pdf" });
}

describe("Common Days API", () => {
  beforeEach(() => {
    app = createApp(createTestCalendarRepository());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns searchable schools", async () => {
    const response = await app.request("/api/v1/schools?q=%20Illinois%20");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schools).toHaveLength(1);
    expect(body.schools[0].shortName).toBe("UIUC");
  });

  it("returns a calendar comparison", async () => {
    const response = await app.request("/api/v1/calendars?schools=uiuc,nyu,uiuc&year=2026-27");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schools).toHaveLength(2);
    expect(body.schools.map((school: { id: string }) => school.id)).toEqual(["uiuc", "nyu"]);
    expect(body.events.every((event: { schoolId: string }) => ["uiuc", "nyu"].includes(event.schoolId))).toBe(true);
    expect(body.source).toBe("supabase");
  });

  it("rejects an invalid academic year", async () => {
    const response = await app.request("/api/v1/calendars?schools=uiuc&year=2026/27");
    expect(response.status).toBe(400);
  });

  it("rejects a comparison without schools", async () => {
    const response = await app.request("/api/v1/calendars?schools=&year=2026-27");
    expect(response.status).toBe(400);
  });

  it("requires an explicit academic year and school selection", async () => {
    const missingYear = await app.request("/api/v1/calendars?schools=uiuc");
    const missingSchools = await app.request("/api/v1/calendars?year=2026-27");

    expect(missingYear.status).toBe(400);
    expect(missingSchools.status).toBe(400);
  });

  it("submits a correction report", async () => {
    const response = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schoolId: "uiuc",
        academicYear: "2026-27",
        reason: "missing_date",
        details: "The calendar is missing reading day.",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.report.status).toBe("submitted");
    expect(body.report.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects malformed report JSON", async () => {
    const response = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(400);
  });

  it("rejects an event that belongs to another school", async () => {
    const response = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schoolId: "uiuc",
        academicYear: "2026-27",
        eventId: "nyu-winter",
        reason: "wrong_date",
        details: "This event belongs to a different school.",
      }),
    });

    expect(response.status).toBe(422);
  });

  it("reports which persistence source is active", async () => {
    const response = await app.request("/health");
    const body = await response.json();

    expect(body.dataSource).toBe("supabase");
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });

  it("distinguishes reusable and missing school years", async () => {
    const availableResponse = await app.request("/api/v1/schools/uiuc/calendars/2026-27/availability");
    const missingResponse = await app.request("/api/v1/schools/michigan/calendars/2026-27/availability");

    expect(await availableResponse.json()).toMatchObject({ schoolId: "uiuc", status: "available" });
    expect(await missingResponse.json()).toMatchObject({ schoolId: "michigan", status: "missing" });
  });

  it("rejects an upload when that school year is already published", async () => {
    const form = new FormData();
    form.append("files", pdfFile());

    const response = await app.request("/api/v1/schools/uiuc/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("CALENDAR_ALREADY_AVAILABLE");
  });

  it("rejects mixed screenshot and PDF submissions", async () => {
    const form = new FormData();
    form.append("files", pngFile("page.png"));
    form.append("files", pdfFile());

    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("MIXED_UPLOAD_TYPES");
  });

  it("rejects more than one PDF", async () => {
    const form = new FormData();
    form.append("files", pdfFile("fall.pdf"));
    form.append("files", pdfFile("spring.pdf"));

    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("MULTIPLE_PDFS");
  });

  it("returns a client error for malformed multipart data", async () => {
    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "not-a-multipart-body",
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_MULTIPART");
  });

  it("surfaces the screenshot limit only after an over-limit submission", async () => {
    const form = new FormData();
    for (let index = 0; index < 11; index += 1) {
      form.append("files", pngFile(`page-${index}.png`));
    }

    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("TOO_MANY_SCREENSHOTS");
  });

  it("accepts a complete ten-screenshot calendar", async () => {
    const form = new FormData();
    for (let index = 0; index < 10; index += 1) {
      form.append("files", pngFile(`page-${index}.png`));
    }

    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.submission).toMatchObject({ sourceType: "screenshots", fileCount: 10, status: "processing" });
  });

  it("processes an uploaded calendar and makes it reusable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const form = new FormData();
    form.append("files", pdfFile());

    const createResponse = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const created = await createResponse.json();

    expect(createResponse.status).toBe(202);
    expect(created.submission).toMatchObject({ schoolId: "michigan", status: "processing", sourceType: "pdf" });

    vi.advanceTimersByTime(1_300);
    const statusResponse = await app.request(`/api/v1/calendar-submissions/${created.submission.id}`);
    const statusBody = await statusResponse.json();
    expect(statusBody.submission.status).toBe("ready");

    const comparisonResponse = await app.request("/api/v1/calendars?schools=michigan&year=2026-27");
    const comparisonBody = await comparisonResponse.json();
    expect(comparisonBody.schools[0].id).toBe("michigan");
    expect(comparisonBody.events.length).toBeGreaterThan(0);
  });

  it("keeps fixture events attached to their exact academic year calendar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const form = new FormData();
    form.append("files", pdfFile());

    const createResponse = await app.request("/api/v1/schools/uiuc/calendars/2027-28/submissions", {
      method: "POST",
      body: form,
    });
    const created = await createResponse.json();
    vi.advanceTimersByTime(1_300);
    await app.request(`/api/v1/calendar-submissions/${created.submission.id}`);

    const oldComparison = await app.request("/api/v1/calendars?schools=uiuc&year=2026-27");
    const oldBody = await oldComparison.json();
    const newComparison = await app.request("/api/v1/calendars?schools=uiuc&year=2027-28");
    const newBody = await newComparison.json();

    expect(oldBody.events).toHaveLength(4);
    expect(newBody.events).toHaveLength(4);
    expect(oldBody.events.every((event: { id: string }) => !event.id.startsWith(created.submission.id))).toBe(true);
    expect(newBody.events.every((event: { id: string }) => event.id.startsWith(created.submission.id))).toBe(true);

    const crossYearReport = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schoolId: "uiuc",
        academicYear: "2026-27",
        eventId: newBody.events[0].id,
        reason: "wrong_date",
        details: "This event belongs to another academic year.",
      }),
    });
    expect(crossYearReport.status).toBe(422);
  });

  it("rejects files whose bytes do not match their claimed type", async () => {
    const form = new FormData();
    form.append("files", new File(["not a real image"], "fake.png", { type: "image/png" }));

    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(415);
    expect(body.code).toBe("FILE_CONTENT_MISMATCH");
  });

  it("rejects a second submission while one is processing", async () => {
    const firstForm = new FormData();
    firstForm.append("files", pdfFile());
    await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: firstForm,
    });

    const secondForm = new FormData();
    secondForm.append("files", pdfFile("new-calendar.pdf"));
    const response = await app.request("/api/v1/schools/michigan/calendars/2026-27/submissions", {
      method: "POST",
      body: secondForm,
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("SUBMISSION_ALREADY_IN_PROGRESS");
    expect(body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
