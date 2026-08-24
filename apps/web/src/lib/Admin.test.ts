import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInWithOtp: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  adminFetch: vi.fn(),
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

const report = {
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
  reason: "wrong_date",
  details: "Spring break should end one day later.",
  status: "submitted",
  createdAt: "2026-08-24T12:00:00.000Z",
  resolutionNotes: null,
  resolvedAt: null,
} as const;

const secondReport = {
  ...report,
  id: "report-2",
  schoolId: "nyu",
  schoolName: "New York University",
  schoolShortName: "NYU",
  eventId: "event-2",
  eventName: "Winter recess",
  details: "Winter recess should start one day earlier.",
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "http://localhost:3000/admin/reports",
      },
    }));
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
  });

  it("loads the protected queue and starts a review", async () => {
    authMocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    authMocks.adminFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path === "/api/v1/admin/reports/report-1" && init?.method === "PATCH") {
        return json({ report: { ...report, status: "reviewing" }, message: "Review started." });
      }
      if (path === "/api/v1/admin/reports/report-1") return json({ report });
      if (path.includes("status=reviewing")) return json({ reports: [{ ...report, status: "reviewing" }] });
      if (path.includes("status=submitted")) return json({ reports: [report] });
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    expect(await screen.findByText("UIUC calendar report")).toBeInTheDocument();
    expect(screen.getByText("No source file available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(authMocks.adminFetch).toHaveBeenCalledWith(
      "/api/v1/admin/reports/report-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "start_review" }) }),
    ));
    expect(await screen.findByText("Review started.")).toBeInTheDocument();
  });

  it("keeps the latest selected report when detail responses finish out of order", async () => {
    authMocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    let finishSecondDetail!: (response: Response) => void;
    const pendingSecondDetail = new Promise<Response>((resolve) => { finishSecondDetail = resolve; });
    authMocks.adminFetch.mockImplementation(async (path: string) => {
      if (path === "/api/v1/admin/me") return json({ admin: { id: "admin-1", email: "admin@example.com" } });
      if (path.includes("status=submitted")) return json({ reports: [report, secondReport] });
      if (path === "/api/v1/admin/reports/report-2") return pendingSecondDetail;
      if (path === "/api/v1/admin/reports/report-1") return json({ report });
      return json({ error: "Not found" }, 404);
    });

    render(AdminReports);
    expect(await screen.findByText("UIUC calendar report")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /NYU.*Wrong date/i }));
    await waitFor(() => expect(authMocks.adminFetch).toHaveBeenCalledWith("/api/v1/admin/reports/report-2", undefined));
    await fireEvent.click(screen.getByRole("button", { name: /UIUC.*Wrong date/i }));
    expect(await screen.findByText("UIUC calendar report")).toBeInTheDocument();

    finishSecondDetail(json({ report: secondReport }));
    await waitFor(() => expect(screen.getByText("UIUC calendar report")).toBeInTheDocument());
    expect(screen.queryByText("NYU calendar report")).not.toBeInTheDocument();
  });
});
