import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";

const schools = [
  { id: "uiuc", name: "University of Illinois Urbana-Champaign", shortName: "UIUC", location: "Champaign, Illinois", initials: "IL", color: "#6574f7", availableYears: ["2026-27"] },
  { id: "berkeley", name: "University of California, Berkeley", shortName: "UC Berkeley", location: "Berkeley, California", initials: "CA", color: "#ff765f", availableYears: ["2026-27"] },
  { id: "nyu", name: "New York University", shortName: "NYU", location: "New York, New York", initials: "NY", color: "#1fb09f", availableYears: ["2026-27"] },
  { id: "purdue", name: "Purdue University", shortName: "Purdue", location: "West Lafayette, Indiana", initials: "IN", color: "#bd8c32", availableYears: ["2026-27"] },
  { id: "michigan", name: "University of Michigan", shortName: "Michigan", location: "Ann Arbor, Michigan", initials: "MI", color: "#e3ad22", availableYears: [] },
];

const submissionId = "9e6c83d3-cdbb-4d0c-a81c-823463cced1f";
let comparisonSchoolIdsOverride: string[] | null = null;

function screenshot(name: string) {
  return new File([name], name, { type: "image/png", lastModified: 1 });
}

function pdf(name = "calendar.pdf") {
  return new File(["%PDF-1.7\ncalendar"], name, { type: "application/pdf", lastModified: 1 });
}

function comparisonRequests() {
  return vi.mocked(fetch).mock.calls.filter(([input]) =>
    new URL(String(input), "http://localhost").pathname === "/api/v1/calendars",
  );
}

async function addReadySchool(name: RegExp, shortName: string) {
  const openPicker = screen.queryByRole("button", { name: "Choose a school" })
    ?? screen.getByRole("button", { name: "Add another school" });
  await fireEvent.click(openPicker);
  await fireEvent.click(screen.getByRole("button", { name }));
  expect(await screen.findByText(`${shortName} is ready to use.`)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: `Add ${shortName}` }));
  await waitFor(() => {
    expect(within(screen.getByRole("complementary")).getByText(shortName)).toBeInTheDocument();
  });
}

describe("Common Days app", () => {
  beforeEach(() => {
    comparisonSchoolIdsOverride = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown;

      if (url.pathname.endsWith("/availability")) {
        const schoolId = url.pathname.split("/")[4];
        body = { schoolId, academicYear: "2026-27", status: schoolId === "michigan" ? "missing" : "available" };
      } else if (url.pathname.endsWith("/submissions") && init?.method === "POST") {
        body = {
          submission: {
            id: submissionId,
            schoolId: "michigan",
            academicYear: "2026-27",
            status: "processing",
            sourceType: "pdf",
            fileCount: 1,
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        };
      } else if (url.pathname === `/api/v1/calendar-submissions/${submissionId}`) {
        body = {
          submission: {
            id: submissionId,
            schoolId: "michigan",
            academicYear: "2026-27",
            status: "ready",
            sourceType: "pdf",
            fileCount: 1,
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        };
      } else if (url.pathname === "/api/v1/calendars") {
        const requestedIds = (url.searchParams.get("schools") ?? "").split(",").filter(Boolean);
        const responseIds = comparisonSchoolIdsOverride ?? requestedIds;
        body = {
          academicYear: "2026-27",
          schools: schools.filter((school) => responseIds.includes(school.id)),
          events: [],
          source: "supabase",
        };
      } else {
        body = { schools };
      }

      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts empty without requesting a prototype comparison", async () => {
    render(App);
    expect(await screen.findByRole("heading", { name: "Add your first school." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a school" })).toBeInTheDocument();
    expect(screen.queryByText("Summer plans")).not.toBeInTheDocument();
    expect(screen.queryByText("DEVELOPMENT DATA")).not.toBeInTheDocument();
    expect(screen.queryByText("UIUC")).not.toBeInTheDocument();
    expect(comparisonRequests()).toHaveLength(0);
  });

  it("adds the first available school and begins at the academic-year start", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");

    expect(screen.getByText("When is everyone free?")).toBeInTheDocument();
    expect(screen.getByText("August 2026")).toBeInTheDocument();
    expect(comparisonRequests()).toHaveLength(1);
    expect(new URL(String(comparisonRequests()[0][0]), "http://localhost").searchParams.get("schools")).toBe("uiuc");
  });

  it("removes the final school locally and returns to onboarding", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");
    expect(comparisonRequests()).toHaveLength(1);

    await fireEvent.click(screen.getByRole("button", { name: "Remove UIUC" }));

    expect(await screen.findByRole("heading", { name: "Add your first school." })).toBeInTheDocument();
    expect(screen.queryByText("When is everyone free?")).not.toBeInTheDocument();
    expect(comparisonRequests()).toHaveLength(1);
  });

  it("keeps the first-school state when availability changes before add", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Illinois Urbana-Champaign/i }));
    expect(await screen.findByText("UIUC is ready to use.")).toBeInTheDocument();

    comparisonSchoolIdsOverride = [];
    await fireEvent.click(screen.getByRole("button", { name: "Add UIUC" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("UIUC 2026-27 is no longer available");
    expect(screen.getByRole("heading", { name: "What school are we adding?" })).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /University of Illinois Urbana-Champaign/i })).getByText("2026-27 NEEDED")).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).queryByText("UIUC")).not.toBeInTheDocument();
    expect(screen.queryByText("When is everyone free?")).not.toBeInTheDocument();
  });

  it("removes an already-selected school when its published calendar disappears", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");

    await fireEvent.click(screen.getByRole("button", { name: "Add another school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of California, Berkeley/i }));
    expect(await screen.findByText("UC Berkeley is ready to use.")).toBeInTheDocument();

    comparisonSchoolIdsOverride = ["berkeley"];
    await fireEvent.click(screen.getByRole("button", { name: "Add UC Berkeley" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("UIUC 2026-27 is no longer available");
    expect(await screen.findByRole("heading", { name: "Add your first school." })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).queryByText("UIUC")).not.toBeInTheDocument();
    expect(screen.queryByText("When is everyone free?")).not.toBeInTheDocument();
  });

  it("prevents duplicate report submissions while a request is pending", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");

    const fetchMock = vi.mocked(fetch);
    let finishReport!: (response: Response) => void;
    const pendingReport = new Promise<Response>((resolve) => { finishReport = resolve; });
    fetchMock.mockImplementationOnce(() => pendingReport);
    const requestCount = fetchMock.mock.calls.length;

    await fireEvent.click(screen.getAllByRole("button", { name: "Report" })[0]);
    await fireEvent.input(screen.getByPlaceholderText(/Spring break should end/i), {
      target: { value: "The official calendar lists a different end date." },
    });
    const submit = screen.getByRole("button", { name: "Submit report" });
    await fireEvent.click(submit);
    await fireEvent.click(submit);

    expect(screen.getByRole("button", { name: "Submitting..." })).toBeDisabled();
    expect(fetchMock.mock.calls).toHaveLength(requestCount + 1);

    finishReport(new Response(JSON.stringify({ report: { id: "report-1" } }), { status: 201 }));
    expect(await screen.findByText("Report submitted for review.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submitted" })).toBeDisabled();
  });

  it("ignores a report response after the modal is closed and reopened", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");
    await addReadySchool(/University of California, Berkeley/i, "UC Berkeley");

    const fetchMock = vi.mocked(fetch);
    let finishReport!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishReport = resolve; }));

    await fireEvent.click(screen.getAllByRole("button", { name: "Report" })[0]);
    await fireEvent.input(screen.getByPlaceholderText(/Spring break should end/i), {
      target: { value: "This report belongs only to the first open modal." },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await fireEvent.click(screen.getAllByRole("button", { name: "Report" })[1]);

    finishReport(new Response(JSON.stringify({ report: { id: "report-1" } }), { status: 201 }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /UC Berkeley/ })).toBeInTheDocument());
    expect(screen.queryByText("Report submitted for review.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit report" })).toBeDisabled();
  });

  it("shows that an existing school year can be reused", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /Purdue University/i }));

    expect(await screen.findByText("Purdue is ready to use.")).toBeInTheDocument();
    expect(screen.queryByText("Submit calendar for processing")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add Purdue" }));

    await waitFor(() => {
      expect(within(screen.getByRole("complementary")).getByText("Purdue")).toBeInTheDocument();
    });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname.endsWith("/submissions") && init?.method === "POST";
    })).toBe(false);
  });

  it("opens the uploader only when the school year is missing", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));

    expect(await screen.findByText("Be the first to add Michigan.")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText(/Upload multiple screenshots.*one official PDF/i)).toBeInTheDocument();
    expect(screen.queryByText(/10 screenshots/i)).not.toBeInTheDocument();
  });

  it("reveals the screenshot limit only after ten screenshots are selected", async () => {
    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const firstNine = Array.from({ length: 9 }, (_, index) => screenshot(`page-${index + 1}.png`));
    await fireEvent.change(input!, { target: { files: firstNine } });
    expect(await screen.findByText("9 screenshots selected")).toBeInTheDocument();
    expect(screen.queryByText(/You have added 10 screenshots/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add more pages" })).toBeInTheDocument();

    await fireEvent.change(input!, { target: { files: [screenshot("page-10.png")] } });
    expect(await screen.findByText("10 screenshots selected")).toBeInTheDocument();
    expect(screen.getByText(/You have added 10 screenshots/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add more pages" })).not.toBeInTheDocument();

    await fireEvent.change(input!, { target: { files: [screenshot("page-11.png")] } });
    expect(screen.getByText("10 screenshots selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove page-11.png" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("already added 10 screenshots");

    await fireEvent.click(screen.getByRole("button", { name: "Remove page-1.png" }));
    expect(screen.queryByText(/You have added 10 screenshots/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add more pages" })).toBeInTheDocument();
  });

  it("submits a missing PDF, waits for processing, and adds the reusable school", async () => {
    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await fireEvent.change(input!, { target: { files: [pdf()] } });
    await fireEvent.click(screen.getByRole("button", { name: "Submit calendar for processing" }));

    expect(await screen.findByText("Michigan 2026-27 is ready.")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(screen.getByRole("complementary")).getByText("Michigan")).toBeInTheDocument();
    }, { timeout: 2_500 });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname.endsWith("/submissions") && init?.method === "POST" && init.body instanceof FormData;
    })).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) =>
      new URL(String(input), "http://localhost").pathname === `/api/v1/calendar-submissions/${submissionId}`,
    )).toBe(true);
  });
});
