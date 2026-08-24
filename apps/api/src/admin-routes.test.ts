import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AdminTokenVerifier } from "./auth/admin-auth.js";
import { createSeedRepository } from "./repositories/calendar-repository.js";

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
  const repository = createSeedRepository({ adminUserId });
  return createApp(repository, { adminTokenVerifier: verifier });
}

function adminHeaders(token = "admin-token") {
  return { authorization: `Bearer ${token}` };
}

async function submitReport(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schoolId: "uiuc",
      academicYear: "2026-27",
      eventId: "uiuc-winter",
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
    const app = createApp(createSeedRepository({ adminUserId }), {
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
    expect(() => createApp(createSeedRepository({ adminUserId }), {
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
    const app = createApp(createSeedRepository({ adminUserId }), { adminTokenVerifier: null });
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
    expect((await detail.json()).report.id).toBe(reportId);
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

  it("does not expose a resolve action before calendar correction is atomic", async () => {
    const app = createAdminTestApp();
    const reportId = await submitReport(app);
    const response = await app.request(`/api/v1/admin/reports/${reportId}`, {
      method: "PATCH",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ action: "resolve", resolutionNotes: "Fixed" }),
    });

    expect(response.status).toBe(400);
  });
});
