import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminReport } from "@commondays/shared";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(), signInWithOtp: vi.fn(), signOut: vi.fn(),
  onAuthStateChange: vi.fn(), unsubscribe: vi.fn(), adminFetch: vi.fn(),
}));

vi.mock("./supabase", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: authMocks.getSession,
      signInWithOtp: authMocks.signInWithOtp,
      signOut: authMocks.signOut,
      onAuthStateChange: authMocks.onAuthStateChange,
    },
  }),
  adminFetch: authMocks.adminFetch,
}));

import AdminLogin from "./AdminLogin.svelte";
import AdminReports from "./AdminReports.svelte";

const uploadId = "11111111-1111-4111-8111-111111111111";
const report: AdminReport = {
  id: "report-1",
  calendarId: "calendar-1",
  schoolId: "uiuc",
  schoolName: "University of Illinois Urbana-Champaign",
  schoolShortName: "UIUC",
  academicYear: "2026-27",
  eventId: "event-1",
  eventName: "Spring break",
  eventStartDate: "2027-03-13",
  eventEndDate: "2027-03-21",
  eventKind: "break",
  reason: "wrong_date",
  details: "Spring break should end one day later.",
  status: "submitted",
  createdAt: "2026-08-24T12:00:00.000Z",
  resolutionNotes: null,
  resolutionCalendarId: null,
  resolvedAt: null,
};

const currentEvent = {
  id: "current-event-1",
  lineageId: "event-lineage-1",
  name: "Spring break",
  kind: "break",
  startDate: "2027-03-13",
  endDate: "2027-03-21",
  sourceUploadId: uploadId,
  sourcePage: null,
  rawText: "Spring break: March 13–21",
  isDerived: false,
} as const;

const activityPeriod = {
  id: "period-1",
  lineageId: "period-lineage-1",
  name: "Spring instruction",
  startDate: "2027-01-18",
  endDate: "2027-05-12",
  startSourceUploadId: uploadId,
  startSourcePage: null,
  startRawText: "Instruction begins January 18",
  endSourceUploadId: uploadId,
  endSourcePage: null,
  endRawText: "Instruction ends May 12",
} as const;

const sourceFile = {
  id: uploadId,
  fileType: "image",
  position: 1,
  originalFilename: "uiuc-calendar-page-1.png",
  mimeType: "image/png",
  byteSize: 428_000,
} as const;

function detail(base: AdminReport = report, overrides: Record<string, unknown> = {}) {
  return {
    ...base,
    reportedCalendar: { id: base.calendarId, version: 1 },
    currentCalendar: { id: "calendar-current", version: 3 },
    currentEvent,
    currentEvents: [currentEvent],
    currentPeriods: [activityPeriod],
    sourceFiles: [sourceFile],
    ...overrides,
  };
}

const secondReport: AdminReport = {
  ...report,
  id: "report-2",
  schoolId: "nyu",
  schoolName: "New York University",
  schoolShortName: "NYU",
  eventId: "event-2",
  eventName: "Winter recess",
  details: "Winter recess should start one day earlier.",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authenticate() {
  authMocks.getSession.mockResolvedValue({
    data: { session: { access_token: "test-access-token" } }, error: null,
  });
}

describe("Common Days admin frontend", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
    authMocks.signInWithOtp.mockReset().mockResolvedValue({ error: null });
    authMocks.signOut.mockReset().mockResolvedValue({ error: null });
    authMocks.unsubscribe.mockReset();
    authMocks.onAuthStateChange.mockReset().mockReturnValue({ data: { subscription: { unsubscribe: authMocks.unsubscribe } } });
    authMocks.adminFetch.mockReset();
  });

  afterEach(() => cleanup());

  it("uses a passwordless link without creating a user", async () => {
    render(AdminLogin);
    const emailInput = await screen.findByLabelText("Admin email");
    await fireEvent.input(emailInput, { target: { value: "admin@example.com" } });
    await fireEvent.click(screen.getByRole("button", { name: /Email me a sign-in link/i }));

    await waitFor(() => expect(authMocks.signInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "http://localhost:3000/admin/reports" },
    }));
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
  });

  it("loads the protected queue, distinguishes calendar versions, and starts a review", async () => {
    authenticate();
    let reviewStarted = false;
    authMocks.adminFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path === "/api/v1/admin/reports/report-1" && init?.method === "PATCH") {
        reviewStarted = true;
        return json({ report: { ...report, status: "reviewing" }, message: "Review started." });
      }
      if (path === "/api/v1/admin/reports/report-1") {
        return json({ report: detail({ ...report, status: reviewStarted ? "reviewing" : "submitted" }) });
      }
      if (path.includes("status=reviewing")) return json({ reports: [{ ...report, status: "reviewing" }] });
      if (path.includes("status=submitted")) return json({ reports: [report] });
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    expect(await screen.findByText("UIUC calendar report")).toBeInTheDocument();
    expect(screen.getByText("REPORTED VERSION 1")).toBeInTheDocument();
    expect(screen.getByText("LIVE VERSION 3")).toBeInTheDocument();
    expect(screen.getByText("uiuc-calendar-page-1.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(authMocks.adminFetch).toHaveBeenCalledWith(
      "/api/v1/admin/reports/report-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "start_review" }) }),
    ));
    expect(await screen.findByText("Review started.")).toBeInTheDocument();
  });

  it("keeps the latest selected report when detail responses finish out of order", async () => {
    authenticate();
    let finishSecondDetail!: (response: Response) => void;
    const pendingSecondDetail = new Promise<Response>((resolve) => { finishSecondDetail = resolve; });
    authMocks.adminFetch.mockImplementation(async (path: string) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path.includes("status=submitted")) return json({ reports: [report, secondReport] });
      if (path === "/api/v1/admin/reports/report-2") return pendingSecondDetail;
      if (path === "/api/v1/admin/reports/report-1") return json({ report: detail() });
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    expect(await screen.findByText("UIUC calendar report")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /NYU.*Wrong date/i }));
    await waitFor(() => expect(authMocks.adminFetch).toHaveBeenCalledWith("/api/v1/admin/reports/report-2", undefined));
    await fireEvent.click(screen.getByRole("button", { name: /UIUC.*Wrong date/i }));
    expect(await screen.findByText("UIUC calendar report")).toBeInTheDocument();

    finishSecondDetail(json({ report: detail(secondReport) }));
    await waitFor(() => expect(screen.getByText("UIUC calendar report")).toBeInTheDocument());
    expect(screen.queryByText("NYU calendar report")).not.toBeInTheDocument();
  });

  it("opens a scoped signed source preview and clears it when the selected file changes", async () => {
    authenticate();
    const secondSource = { ...sourceFile, id: "22222222-2222-4222-8222-222222222222", position: 2, originalFilename: "uiuc-calendar-page-2.png" };
    const reviewing: AdminReport = { ...report, status: "reviewing" };
    authMocks.adminFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path.includes("status=submitted")) return json({ reports: [] });
      if (path.includes("status=reviewing")) return json({ reports: [reviewing] });
      if (path === "/api/v1/admin/reports/report-1") return json({ report: detail(reviewing, { sourceFiles: [sourceFile, secondSource] }) });
      if (path.endsWith(`source-files/${uploadId}/signed-url`) && init?.method === "POST") {
        return json({ url: "https://storage.example.test/secure-source.png?token=short-lived", expiresAt: "2099-08-24T12:05:00.000Z" });
      }
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    await fireEvent.click(await screen.findByRole("button", { name: "Reviewing" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Open secure preview" }));
    const preview = await screen.findByRole("img", { name: "Academic calendar source: uiuc-calendar-page-1.png" });
    expect(preview).toHaveAttribute("src", expect.stringContaining("token=short-lived"));
    expect(authMocks.adminFetch).toHaveBeenCalledWith(
      `/api/v1/admin/reports/report-1/source-files/${uploadId}/signed-url`, { method: "POST" },
    );

    await fireEvent.click(screen.getByRole("button", { name: /uiuc-calendar-page-2.png/i }));
    expect(screen.queryByRole("img", { name: /Academic calendar source/i })).not.toBeInTheDocument();
  });

  it("publishes an event correction with the current version guard and confirmation", async () => {
    authenticate();
    const reviewing: AdminReport = { ...report, status: "reviewing" };
    let correctionBody: Record<string, unknown> | undefined;
    authMocks.adminFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path.includes("status=submitted")) return json({ reports: [] });
      if (path.includes("status=reviewing")) return json({ reports: [reviewing] });
      if (path.includes("status=resolved")) return json({ reports: [{ ...reviewing, status: "resolved", resolutionNotes: "Verified against page one.", resolutionCalendarId: "calendar-next", resolvedAt: "2026-08-25T12:00:00.000Z" }] });
      if (path === "/api/v1/admin/reports/report-1" && init?.method === "PATCH") {
        correctionBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ report: { ...reviewing, status: "resolved", resolutionNotes: "Verified against page one.", resolutionCalendarId: "calendar-next", resolvedAt: "2026-08-25T12:00:00.000Z" }, message: "Correction published and report resolved." });
      }
      if (path === "/api/v1/admin/reports/report-1") {
        if (correctionBody) return json({ report: detail({ ...reviewing, status: "resolved" }, { resolutionNotes: "Verified against page one.", resolutionCalendarId: "calendar-next", resolvedAt: "2026-08-25T12:00:00.000Z" }) });
        return json({ report: detail(reviewing) });
      }
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    await fireEvent.click(await screen.findByRole("button", { name: "Reviewing" }));
    expect(await screen.findByRole("heading", { name: "Create the next live calendar version" })).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText("End date"), { target: { value: "2027-03-22" } });
    await fireEvent.input(screen.getByLabelText("Decision notes"), { target: { value: "Verified against page one." } });
    await fireEvent.click(screen.getByLabelText(/I verified this correction against the official source/i));
    await fireEvent.click(screen.getByRole("button", { name: "Publish correction & resolve" }));

    await waitFor(() => expect(correctionBody).toMatchObject({
      action: "apply_correction",
      operationId: expect.any(String),
      expectedCalendarId: "calendar-current",
      expectedCalendarVersion: 3,
      resolutionNotes: "Verified against page one.",
      correction: {
        operation: "update_event",
        targetLineageId: "event-lineage-1",
        name: "Spring break",
        kind: "break",
        startDate: "2027-03-13",
        endDate: "2027-03-22",
      },
    }));
    expect(await screen.findByText("Correction published and report resolved.")).toBeInTheDocument();
  });

  it("keeps a failed correction intact and reuses its operation id on retry", async () => {
    authenticate();
    const reviewing: AdminReport = { ...report, status: "reviewing" };
    const patchBodies: Array<Record<string, unknown>> = [];
    authMocks.adminFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path.includes("status=submitted")) return json({ reports: [] });
      if (path.includes("status=reviewing")) return json({ reports: [reviewing] });
      if (path === "/api/v1/admin/reports/report-1" && init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ error: "The live calendar changed. Reload this report before correcting it." }, 409);
      }
      if (path === "/api/v1/admin/reports/report-1") return json({ report: detail(reviewing) });
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    await fireEvent.click(await screen.findByRole("button", { name: "Reviewing" }));
    await fireEvent.input(await screen.findByLabelText("End date"), { target: { value: "2027-03-22" } });
    await fireEvent.input(screen.getByLabelText("Decision notes"), { target: { value: "Verified against page one." } });
    await fireEvent.click(screen.getByLabelText(/I verified this correction against the official source/i));
    await fireEvent.click(screen.getByRole("button", { name: "Publish correction & resolve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The live calendar changed");
    expect(screen.getByLabelText("End date")).toHaveValue("2027-03-22");
    await fireEvent.click(screen.getByRole("button", { name: "Publish correction & resolve" }));
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]?.operationId).toBe(patchBodies[0]?.operationId);
  });

  it("routes a report about a derived gap through activity-period correction only", async () => {
    authenticate();
    const derivedReport: AdminReport = {
      ...report,
      status: "reviewing",
      eventName: "No classes between Fall and Winter sessions",
      eventKind: "term_boundary",
    };
    const derivedEvent = {
      ...currentEvent,
      id: "derived-event",
      lineageId: "derived-lineage",
      name: derivedReport.eventName,
      kind: "term_boundary",
      startDate: "2026-12-20",
      endDate: "2027-01-17",
      sourceUploadId: null,
      rawText: null,
      isDerived: true,
    } as const;
    authMocks.adminFetch.mockImplementation(async (path: string) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path.includes("status=submitted")) return json({ reports: [] });
      if (path.includes("status=reviewing")) return json({ reports: [derivedReport] });
      if (path === "/api/v1/admin/reports/report-1") return json({ report: detail(derivedReport, { currentEvent: derivedEvent, currentEvents: [], currentPeriods: [activityPeriod] }) });
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    await fireEvent.click(await screen.findByRole("button", { name: "Reviewing" }));
    expect(await screen.findByText("This is a derived free-time gap.")).toBeInTheDocument();
    expect(screen.getByLabelText("Correction type")).toHaveValue("update_period");
    expect(screen.queryByRole("option", { name: "Correct an existing calendar event" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Live instructional/activity period")).toBeInTheDocument();
  });
});
