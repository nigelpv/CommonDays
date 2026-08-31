import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AdminTokenVerifier } from "./auth/admin-auth.js";
import { createTestCalendarRepository } from "./testing/calendar-repository.fixture.js";

const adminUserId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";

const verifier: AdminTokenVerifier = async (accessToken) => {
  if (accessToken === "admin-token") {
    return { status: "authenticated", user: { id: adminUserId, email: "admin@example.com" } };
  }
  if (accessToken === "other-token") {
    return { status: "authenticated", user: { id: otherUserId, email: "other@example.com" } };
  }
  return { status: "invalid" };
};

function createAdminTestApp() {
  const repository = createTestCalendarRepository({ adminUserId });
  return createApp(repository, { adminTokenVerifier: verifier });
}

function adminHeaders(token = "admin-token") {
  return { authorization: `Bearer ${token}` };
}

function eventEvidence(event: {
  sourceUploadId: string;
  sourcePage: number | null;
  rawText: string;
}) {
  return {
    uploadId: event.sourceUploadId,
    sourcePage: event.sourcePage,
    rawText: event.rawText,
  };
}

function periodEndEvidence(period: {
  endSourceUploadId: string;
  endSourcePage: number | null;
  endRawText: string;
}) {
  return {
    uploadId: period.endSourceUploadId,
    sourcePage: period.endSourcePage,
    rawText: period.endRawText,
  };
}

async function submitReport(app: ReturnType<typeof createApp>, eventId: string | null = "uiuc-winter") {
  const response = await app.request("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schoolId: "uiuc",
      academicYear: "2026-27",
      ...(eventId ? { eventId } : {}),
      reason: "wrong_date",
      details: "Winter break ends on a different date.",
    }),
  });
  const body = await response.json();
  return body.report.id as string;
}

describe("Common Days admin report API", () => {
  it("allows configured CORS preflights without requiring an admin token", async () => {
    const app = createAdminTestApp();
    const response = await app.request("/api/v1/admin/reports", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
  });

  it("only emits CORS access for an exact validated origin", async () => {
    const app = createApp(createTestCalendarRepository({ adminUserId }), {
      adminTokenVerifier: verifier,
      corsOrigins: ["https://admin.commondays.test"],
    });
    const blocked = await app.request("/api/v1/admin/reports", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });

    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
    expect(() => createApp(createTestCalendarRepository({ adminUserId }), {
      adminTokenVerifier: verifier,
      corsOrigins: ["https://admin.commondays.test/not-an-origin"],
    })).toThrow("Invalid CORS origin");
  });

  it("requires a verified Supabase access token", async () => {
    const app = createAdminTestApp();
    const missing = await app.request("/api/v1/admin/me");
    const invalid = await app.request("/api/v1/admin/me", { headers: adminHeaders("bad-token") });

    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe("ADMIN_AUTH_REQUIRED");
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).code).toBe("INVALID_ADMIN_TOKEN");
  });

  it("fails closed when server-side auth is not configured", async () => {
    const app = createApp(createTestCalendarRepository({ adminUserId }), { adminTokenVerifier: null });
    const response = await app.request("/api/v1/admin/me", { headers: adminHeaders() });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ADMIN_AUTH_NOT_CONFIGURED");
  });

  it("rejects a valid non-admin account", async () => {
    const app = createAdminTestApp();
    const response = await app.request("/api/v1/admin/me", { headers: adminHeaders("other-token") });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("ADMIN_FORBIDDEN");
  });

  it("returns the verified singleton admin identity", async () => {
    const app = createAdminTestApp();
    const response = await app.request("/api/v1/admin/me", { headers: adminHeaders() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      admin: { id: adminUserId, email: "admin@example.com" },
    });
  });

  it("retains submitted reports and supports status filtering", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    const response = await app.request("/api/v1/admin/reports?status=submitted", {
      headers: adminHeaders(),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({
      id: reportId,
      schoolId: "uiuc",
      schoolShortName: "UIUC",
      eventId: "uiuc-winter",
      eventName: "Winter break",
      status: "submitted",
    });
    expect(body.reports[0]).not.toHaveProperty("storagePath");
  });

  it("rejects an unknown report status filter", async () => {
    const app = createAdminTestApp();
    const response = await app.request("/api/v1/admin/reports?status=pending", {
      headers: adminHeaders(),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_REPORT_STATUS");
  });

  it("loads report detail and moves a submitted report into review", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    const detail = await app.request(`/api/v1/admin/reports/${reportId}`, { headers: adminHeaders() });
    const update = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });

    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.report.id).toBe(reportId);
    expect(detailBody.report.reportedCalendar).toEqual({ id: "test-uiuc-2026-27", version: 1 });
    expect(detailBody.report.currentCalendar).toEqual({ id: "test-uiuc-2026-27", version: 1 });
    expect(detailBody.report.currentEvent).toMatchObject({ name: "Winter break", isDerived: false });
    expect(detailBody.report.currentPeriods).toHaveLength(2);
    expect(detailBody.report.sourceFiles[0]).toMatchObject({
      originalFilename: "UIUC-2026-27.pdf",
      mimeType: "application/pdf",
    });
    expect(JSON.stringify(detailBody)).not.toContain("storagePath");
    expect(update.status).toBe(200);
    expect((await update.json()).report.status).toBe("reviewing");

    const filtered = await app.request("/api/v1/admin/reports?status=reviewing", {
      headers: adminHeaders(),
    });
    expect((await filtered.json()).reports).toHaveLength(1);
  });

  it("conditionally rejects a report with review notes", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });

    const rejected = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "reject", resolutionNotes: "The official calendar confirms the stored date." }),
    });
    const body = await rejected.json();

    expect(rejected.status).toBe(200);
    expect(body.report).toMatchObject({
      status: "rejected",
      resolutionNotes: "The official calendar confirms the stored date.",
    });
    expect(body.report.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const staleUpdate = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    expect(staleUpdate.status).toBe(409);
    expect((await staleUpdate.json()).code).toBe("REPORT_STATUS_CONFLICT");
  });

  it("returns only a short-lived private source URL for a report-owned upload", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    const detail = await app.request(`/api/v1/admin/reports/${reportId}`, { headers: adminHeaders() });
    const sourceId = (await detail.json()).report.sourceFiles[0].id as string;

    const unauthenticated = await app.request(
      `/api/v1/admin/reports/${reportId}/source-files/${sourceId}/signed-url`,
      { method: "POST" },
    );
    expect(unauthenticated.status).toBe(401);

    const response = await app.request(
      `/api/v1/admin/reports/${reportId}/source-files/${sourceId}/signed-url`,
      { method: "POST", headers: adminHeaders() },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({
      url: expect.stringMatching(/^https:\/\/storage\.test\/private\//),
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(body).not.toHaveProperty("storagePath");

    const crossSource = await app.request(
      `/api/v1/admin/reports/${reportId}/source-files/source-nyu-2026-27/signed-url`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(crossSource.status).toBe(404);
    expect((await crossSource.json()).code).toBe("REPORT_SOURCE_NOT_FOUND");
  });

  it("publishes an atomic corrected version, preserves history, and makes retries idempotent", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const detailResponse = await app.request(`/api/v1/admin/reports/${reportId}`, {
      headers: adminHeaders(),
    });
    const detail = (await detailResponse.json()).report;
    const operationId = "10000000-0000-4000-8000-000000000010";
    const action = {
      action: "apply_correction",
      operationId,
      expectedCalendarId: detail.currentCalendar.id,
      expectedCalendarVersion: detail.currentCalendar.version,
      resolutionNotes: "Corrected against the official PDF.",
      correction: {
        operation: "update_event",
        targetLineageId: detail.currentEvent.lineageId,
        name: "Corrected winter recess",
        kind: "break",
        startDate: "2026-12-20",
        endDate: "2027-01-18",
        evidence: eventEvidence(detail.currentEvent),
      },
    };

    const corrected = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    const correctedBody = await corrected.json();
    expect(corrected.status).toBe(200);
    expect(correctedBody.report).toMatchObject({
      status: "resolved",
      resolutionNotes: "Corrected against the official PDF.",
    });
    expect(correctedBody.report.resolutionCalendarId).not.toBe(detail.currentCalendar.id);

    const after = await app.request(`/api/v1/admin/reports/${reportId}`, { headers: adminHeaders() });
    const afterDetail = (await after.json()).report;
    expect(afterDetail.reportedCalendar).toEqual(detail.reportedCalendar);
    expect(afterDetail.currentCalendar).toEqual({
      id: correctedBody.report.resolutionCalendarId,
      version: 2,
    });
    expect(afterDetail.currentEvent).toMatchObject({
      lineageId: detail.currentEvent.lineageId,
      name: "Corrected winter recess",
      endDate: "2027-01-18",
    });

    const retry = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).report.resolutionCalendarId).toBe(afterDetail.currentCalendar.id);

    const comparison = await app.request("/api/v1/calendars?schools=uiuc&year=2026-27");
    const events = (await comparison.json()).events as Array<{ name: string; endDate: string }>;
    expect(events).toContainEqual(expect.objectContaining({
      name: "Corrected winter recess",
      endDate: "2027-01-18",
    }));
  });

  it("rejects a stale correction after another report publishes a newer version", async () => {
    const app = createAdminTestApp();
    const firstReportId = await submitReport(app);
    const secondReportId = await submitReport(app);
    for (const reportId of [firstReportId, secondReportId]) {
      await app.request(`/api/v1/admin/reports/${reportId}`, {
        method: "PATCH",
        headers: { ...adminHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ action: "start_review" }),
      });
    }
    const secondDetail = (await (await app.request(`/api/v1/admin/reports/${secondReportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    const firstDetail = (await (await app.request(`/api/v1/admin/reports/${firstReportId}`, {
      headers: adminHeaders(),
    })).json()).report;

    await app.request(`/api/v1/admin/reports/${firstReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000011",
        expectedCalendarId: firstDetail.currentCalendar.id,
        expectedCalendarVersion: firstDetail.currentCalendar.version,
        resolutionNotes: "First correction published.",
        correction: {
          operation: "delete_event",
          targetLineageId: firstDetail.currentEvent.lineageId,
        },
      }),
    });
    const stale = await app.request(`/api/v1/admin/reports/${secondReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000012",
        expectedCalendarId: secondDetail.currentCalendar.id,
        expectedCalendarVersion: secondDetail.currentCalendar.version,
        resolutionNotes: "This correction used a stale base.",
        correction: {
          operation: "delete_event",
          targetLineageId: secondDetail.currentEvent.lineageId,
        },
      }),
    });

    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("CALENDAR_VERSION_CONFLICT");
  });

  it("rejects direct edits to derived gaps and accepts an activity-period correction", async () => {
    const app = createAdminTestApp();
    const initialReportId = await submitReport(app);
    await app.request(`/api/v1/admin/reports/${initialReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const initialDetail = (await (await app.request(`/api/v1/admin/reports/${initialReportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    await app.request(`/api/v1/admin/reports/${initialReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000013",
        expectedCalendarId: initialDetail.currentCalendar.id,
        expectedCalendarVersion: initialDetail.currentCalendar.version,
        resolutionNotes: "Created a new reviewed version.",
        correction: {
          operation: "update_event",
          targetLineageId: initialDetail.currentEvent.lineageId,
          name: initialDetail.currentEvent.name,
          kind: initialDetail.currentEvent.kind,
          startDate: initialDetail.currentEvent.startDate,
          endDate: initialDetail.currentEvent.endDate,
        },
      }),
    });

    const comparison = await app.request("/api/v1/calendars?schools=uiuc&year=2026-27");
    const derivedEvent = (await comparison.json()).events.find(
      (event: { kind: string }) => event.kind === "term_boundary",
    );
    const reportResponse = await app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schoolId: "uiuc",
        academicYear: "2026-27",
        eventId: derivedEvent.id,
        reason: "wrong_date",
        details: "This derived gap should follow the corrected activity period.",
      }),
    });
    const reportId = (await reportResponse.json()).report.id as string;
    await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const detail = (await (await app.request(`/api/v1/admin/reports/${reportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    expect(detail.currentEvent.isDerived).toBe(true);

    const directEdit = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000014",
        expectedCalendarId: detail.currentCalendar.id,
        expectedCalendarVersion: detail.currentCalendar.version,
        resolutionNotes: "Attempted direct derived edit.",
        correction: {
          operation: "update_event",
          targetLineageId: detail.currentEvent.lineageId,
          name: detail.currentEvent.name,
          kind: "break",
          startDate: detail.currentEvent.startDate,
          endDate: detail.currentEvent.endDate,
        },
      }),
    });
    expect(directEdit.status).toBe(422);
    expect((await directEdit.json()).code).toBe("INVALID_CALENDAR_CORRECTION");

    const period = detail.currentPeriods[0];
    const missingEvidence = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000019",
        expectedCalendarId: detail.currentCalendar.id,
        expectedCalendarVersion: detail.currentCalendar.version,
        resolutionNotes: "Tried to change a boundary without source evidence.",
        correction: {
          operation: "update_period",
          targetLineageId: period.lineageId,
          name: period.name,
          startDate: period.startDate,
          endDate: "2026-12-19",
        },
      }),
    });
    expect(missingEvidence.status).toBe(422);
    expect((await missingEvidence.json()).code).toBe("INVALID_CALENDAR_CORRECTION");

    const periodCorrection = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000015",
        expectedCalendarId: detail.currentCalendar.id,
        expectedCalendarVersion: detail.currentCalendar.version,
        resolutionNotes: "Corrected the source activity period.",
        correction: {
          operation: "update_period",
          targetLineageId: period.lineageId,
          name: period.name,
          startDate: period.startDate,
          endDate: "2026-12-19",
          endEvidence: periodEndEvidence(period),
        },
      }),
    });
    expect(periodCorrection.status).toBe(200);
    expect((await periodCorrection.json()).report.status).toBe("resolved");
  });

  it("does not allow a correction to delete the final activity period", async () => {
    const app = createAdminTestApp();
    const firstReportId = await submitReport(app);
    await app.request(`/api/v1/admin/reports/${firstReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const firstDetail = (await (await app.request(`/api/v1/admin/reports/${firstReportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    await app.request(`/api/v1/admin/reports/${firstReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000016",
        expectedCalendarId: firstDetail.currentCalendar.id,
        expectedCalendarVersion: firstDetail.currentCalendar.version,
        resolutionNotes: "Removed a duplicate activity period.",
        correction: {
          operation: "delete_period",
          targetLineageId: firstDetail.currentPeriods[0].lineageId,
        },
      }),
    });

    const secondReportId = await submitReport(app, null);
    await app.request(`/api/v1/admin/reports/${secondReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const secondDetail = (await (await app.request(`/api/v1/admin/reports/${secondReportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    expect(secondDetail.currentPeriods).toHaveLength(1);

    const response = await app.request(`/api/v1/admin/reports/${secondReportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000017",
        expectedCalendarId: secondDetail.currentCalendar.id,
        expectedCalendarVersion: secondDetail.currentCalendar.version,
        resolutionNotes: "Tried to remove the only remaining period.",
        correction: {
          operation: "delete_period",
          targetLineageId: secondDetail.currentPeriods[0].lineageId,
        },
      }),
    });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("INVALID_CALENDAR_CORRECTION");
  });

  it("rejects correction dates outside the selected academic year", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const detail = (await (await app.request(`/api/v1/admin/reports/${reportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    const response = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000018",
        expectedCalendarId: detail.currentCalendar.id,
        expectedCalendarVersion: detail.currentCalendar.version,
        resolutionNotes: "This date is outside the selected academic year.",
        correction: {
          operation: "update_event",
          targetLineageId: detail.currentEvent.lineageId,
          name: detail.currentEvent.name,
          kind: detail.currentEvent.kind,
          startDate: "2028-01-01",
          endDate: "2028-01-02",
          evidence: eventEvidence(detail.currentEvent),
        },
      }),
    });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("INVALID_CALENDAR_CORRECTION");
  });

  it("requires evidence for changed events and rejects partial-day evidence", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "start_review" }),
    });
    const detail = (await (await app.request(`/api/v1/admin/reports/${reportId}`, {
      headers: adminHeaders(),
    })).json()).report;
    const correction = {
      operation: "update_event",
      targetLineageId: detail.currentEvent.lineageId,
      name: detail.currentEvent.name,
      kind: detail.currentEvent.kind,
      startDate: detail.currentEvent.startDate,
      endDate: "2027-01-18",
    };

    const missingEvidence = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000020",
        expectedCalendarId: detail.currentCalendar.id,
        expectedCalendarVersion: detail.currentCalendar.version,
        resolutionNotes: "Tried to change a date without source evidence.",
        correction,
      }),
    });
    expect(missingEvidence.status).toBe(422);
    expect((await missingEvidence.json()).code).toBe("INVALID_CALENDAR_CORRECTION");

    const partialDay = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply_correction",
        operationId: "10000000-0000-4000-8000-000000000021",
        expectedCalendarId: detail.currentCalendar.id,
        expectedCalendarVersion: detail.currentCalendar.version,
        resolutionNotes: "Tried to save a partial-day closure as a full free day.",
        correction: {
          ...correction,
          evidence: {
            ...eventEvidence(detail.currentEvent),
            rawText: "Classes end at noon for the holiday.",
          },
        },
      }),
    });
    expect(partialDay.status).toBe(422);
    expect((await partialDay.json()).code).toBe("INVALID_CALENDAR_CORRECTION");
  });

  it("rejects an oversized admin correction body before parsing it", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    const response = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        action: "reject",
        resolutionNotes: "x".repeat(17 * 1024),
      }),
    });

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("CORRECTION_TOO_LARGE");
  });
});
