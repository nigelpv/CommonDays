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

function screenshot(name: string) {
  return new File([name], name, { type: "image/png", lastModified: 1 });
}

function pdf(name = "calendar.pdf") {
  return new File(["%PDF-1.7\ncalendar"], name, { type: "application/pdf", lastModified: 1 });
}

describe("Common Days app", () => {
  beforeEach(() => {
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
        body = { academicYear: "2026-27", schools, events: [], source: "development_seed" };
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

  it("renders the core calendar comparison", async () => {
    render(App);
    expect(await screen.findByText("When is everyone free?")).toBeInTheDocument();
    expect(screen.getAllByText("UIUC").length).toBeGreaterThan(0);
    expect(screen.getByText("December 2026")).toBeInTheDocument();
  });

  it("shows that an existing school year can be reused", async () => {
    render(App);
    await screen.findByText("When is everyone free?");
    await fireEvent.click(screen.getByRole("button", { name: "Add another school" }));
    await fireEvent.click(screen.getByRole("button", { name: /Purdue University/i }));

    expect(await screen.findByText("Purdue is ready to use.")).toBeInTheDocument();
    expect(screen.queryByText("Read calendar with AI")).not.toBeInTheDocument();
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
    await screen.findByText("When is everyone free?");
    await fireEvent.click(screen.getByRole("button", { name: "Add another school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));

    expect(await screen.findByText("Be the first to add Michigan.")).toBeInTheDocument();
    expect(screen.getByText(/Upload multiple screenshots.*one official PDF/i)).toBeInTheDocument();
    expect(screen.queryByText(/10 screenshots/i)).not.toBeInTheDocument();
  });

  it("reveals the screenshot limit only after ten screenshots are selected", async () => {
    const { container } = render(App);
    await screen.findByText("When is everyone free?");
    await fireEvent.click(screen.getByRole("button", { name: "Add another school" }));
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
    await screen.findByText("When is everyone free?");
    await fireEvent.click(screen.getByRole("button", { name: "Add another school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await fireEvent.change(input!, { target: { files: [pdf()] } });
    await fireEvent.click(screen.getByRole("button", { name: "Read calendar with AI" }));

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
