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
let comparisonEventsOverride: Array<{
  id: string;
  schoolId: string;
  name: string;
  startDate: string;
  endDate: string;
  kind: "break" | "holiday" | "no_classes" | "term_boundary";
}> = [];
let michiganAvailability: "missing" | "processing" = "missing";
let submissionStatuses: Array<"processing" | "ready" | "failed"> = ["ready"];
let submissionStatusFailure: "network" | "http" | null = null;
let submissionStatusResponse: (() => Response | Promise<Response>) | null = null;
let librarySchools = [...schools];
let schoolSearchResponse: ((query: string) => Response | Promise<Response>) | null = null;

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

function submissionStatusRequests() {
  return vi.mocked(fetch).mock.calls.filter(([input]) =>
    new URL(String(input), "http://localhost").pathname === `/api/v1/calendar-submissions/${submissionId}`,
  );
}

function submissionBody(status: "processing" | "ready" | "failed") {
  return {
    submission: {
      id: submissionId,
      schoolId: "michigan",
      academicYear: "2026-27",
      status,
      sourceType: "pdf",
      fileCount: 1,
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  };
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
    comparisonEventsOverride = [];
    michiganAvailability = "missing";
    submissionStatuses = ["ready"];
    submissionStatusFailure = null;
    submissionStatusResponse = null;
    librarySchools = [...schools];
    schoolSearchResponse = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown;

      if (url.pathname.endsWith("/availability")) {
        const schoolId = url.pathname.split("/")[4];
        const school = librarySchools.find((candidate) => candidate.id === schoolId);
        body = schoolId === "michigan" && michiganAvailability === "processing"
          ? { schoolId, academicYear: "2026-27", status: "processing", submissionId }
          : { schoolId, academicYear: "2026-27", status: school?.availableYears.includes("2026-27") ? "available" : "missing" };
      } else if (url.pathname.endsWith("/submissions") && init?.method === "POST") {
        body = submissionBody("processing");
      } else if (url.pathname === `/api/v1/calendar-submissions/${submissionId}`) {
        if (submissionStatusResponse) return submissionStatusResponse();
        if (submissionStatusFailure === "network") {
          submissionStatusFailure = null;
          throw new TypeError("network unavailable");
        }
        if (submissionStatusFailure === "http") {
          submissionStatusFailure = null;
          return new Response(JSON.stringify({ error: "Status temporarily unavailable." }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        body = submissionBody(submissionStatuses.shift() ?? "ready");
      } else if (url.pathname === "/api/v1/calendars") {
        const requestedIds = (url.searchParams.get("schools") ?? "").split(",").filter(Boolean);
        const responseIds = comparisonSchoolIdsOverride ?? requestedIds;
        body = {
          academicYear: "2026-27",
          schools: librarySchools.filter((school) => responseIds.includes(school.id)),
          events: comparisonEventsOverride.filter((event) => responseIds.includes(event.schoolId)),
          source: "supabase",
        };
      } else if (url.pathname === "/api/v1/schools" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as { name: string; location: string };
        const school = {
          id: "ucla-created",
          name: request.name,
          shortName: "UCLA",
          location: request.location,
          initials: "UC",
          color: "#8b7cf6",
          availableYears: [],
        };
        librarySchools = [...librarySchools, school];
        return new Response(JSON.stringify({ school, similarSchools: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      } else if (url.pathname === "/api/v1/schools") {
        const schoolQuery = url.searchParams.get("q") ?? "";
        if (schoolQuery && schoolSearchResponse) return schoolSearchResponse(schoolQuery);
        const normalizedQuery = schoolQuery.trim().toLowerCase();
        body = {
          schools: normalizedQuery
            ? librarySchools.filter((school) => `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(normalizedQuery))
            : librarySchools,
          similarSchools: [],
        };
      } else {
        body = { schools: librarySchools };
      }

      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

  it("explains the reusable three-step calendar flow before the application", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });

    const explainer = screen.getByRole("region", { name: "Upload once. Everyone reuses it." });
    const application = screen.getByRole("region", { name: "Common Days calendar application" });
    expect(Boolean(explainer.compareDocumentPosition(application) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    expect(within(explainer).getByText("HOW THE LIBRARY GROWS")).toBeInTheDocument();
    expect(within(explainer).getByRole("heading", { level: 2, name: "Upload once. Everyone reuses it." })).toBeInTheDocument();

    const flow = within(explainer).getByRole("list", { name: "How a school calendar becomes reusable" });
    expect(flow.tagName).toBe("OL");
    const cards = within(flow).getAllByRole("listitem");
    expect(cards).toHaveLength(3);

    expect(within(cards[0]).getByRole("heading", { level: 3, name: "Upload multiple screenshots or one PDF" })).toBeInTheDocument();
    expect(within(cards[0]).getByText("One student submits the academic calendar for 20XX-XY for XYZ school.")).toBeInTheDocument();
    expect(within(cards[1]).getByRole("heading", { level: 3, name: "AI parses the images" })).toBeInTheDocument();
    expect(within(cards[1]).getByText("It reads each screenshot or the PDF, then extracts the breaks, holidays, and no-class dates.")).toBeInTheDocument();
    expect(within(cards[2]).getByRole("heading", { level: 3, name: "That year becomes reusable" })).toBeInTheDocument();
    expect(within(cards[2]).getByText("The next student selects their school and uses it instantly. Found a mistake? Report it so the admin can verify and fix it.")).toBeInTheDocument();
    expect(within(explainer).queryByText(/person verifies|person to check/i)).not.toBeInTheDocument();
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

  it("asks for the full official name and keeps new-school creation available beside an exact match", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));

    expect(screen.getByText(/Type the full official name/i)).toHaveTextContent("University of California, Los Angeles");
    const search = screen.getByPlaceholderText("Type the full official school name");
    await fireEvent.input(search, { target: { value: "University of Illinois Urbana-Champaign" } });

    expect(screen.getByText("SCHOOLS IN THE LIBRARY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /University of Illinois Urbana-Champaign.*READY FOR 2026-27/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add “University of Illinois Urbana-Champaign” as a new school/i })).toBeInTheDocument();
  });

  it("shows a server suggestion without hiding the option to create the typed school", async () => {
    schoolSearchResponse = () => new Response(JSON.stringify({
      schools: [],
      similarSchools: [{ ...schools[0], similarity: 0.93 }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.input(screen.getByPlaceholderText("Type the full official school name"), {
      target: { value: "University of Ilinois Urbana Champaign" },
    });

    expect(await screen.findByText("DID YOU MEAN?", {}, { timeout: 1_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /University of Illinois Urbana-Champaign/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add “University of Ilinois Urbana Champaign” as a new school/i })).toBeInTheDocument();
  });

  it("creates a new school and continues directly into the existing calendar upload flow", async () => {
    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.input(screen.getByPlaceholderText("Type the full official school name"), {
      target: { value: "University of California Los Angeles" },
    });
    await fireEvent.click(screen.getByRole("button", { name: /Add “University of California Los Angeles” as a new school/i }));

    expect(screen.getByRole("heading", { name: "Where is University of California Los Angeles?" })).toBeInTheDocument();
    expect(screen.getByText(/privately alerts the admin without stopping you/i)).toBeInTheDocument();
    await fireEvent.input(screen.getByPlaceholderText("Example: Los Angeles, California"), {
      target: { value: "Los Angeles, California" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create school and check its calendar" }));

    expect(await screen.findByText("Be the first to add UCLA.")).toBeInTheDocument();
    const creationRequest = vi.mocked(fetch).mock.calls.find(([input, init]) =>
      new URL(String(input), "http://localhost").pathname === "/api/v1/schools" && init?.method === "POST",
    );
    expect(creationRequest).toBeDefined();
    expect(JSON.parse(String(creationRequest?.[1]?.body))).toEqual({
      name: "University of California Los Angeles",
      location: "Los Angeles, California",
    });
  });

  it("ignores a slower school-search response after the query changes", async () => {
    let finishOldSearch!: (response: Response) => void;
    schoolSearchResponse = (schoolQuery) => schoolQuery.includes("Illinois")
      ? new Promise<Response>((resolve) => { finishOldSearch = resolve; })
      : new Response(JSON.stringify({ schools: [schools[2]], similarSchools: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    const search = screen.getByPlaceholderText("Type the full official school name");

    vi.useFakeTimers();
    await fireEvent.input(search, { target: { value: "University of Illinois" } });
    await vi.advanceTimersByTimeAsync(250);
    await fireEvent.input(search, { target: { value: "New York University" } });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(0);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /New York University.*READY FOR 2026-27/i })).toBeInTheDocument();
    finishOldSearch(new Response(JSON.stringify({ schools: [schools[0]], similarSchools: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(within(dialog).queryByRole("button", { name: /University of Illinois Urbana-Champaign.*READY/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /New York University.*READY FOR 2026-27/i })).toBeInTheDocument();
  });

  it("renders a derived gap between arbitrary academic activity periods as time off", async () => {
    comparisonEventsOverride = [{
      id: "f752db3c-ec38-48c2-ae5b-134771e731c8",
      schoolId: "uiuc",
      name: "Between academic periods",
      startDate: "2026-12-19",
      endDate: "2027-01-12",
      kind: "term_boundary",
    }];

    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");

    const bestWindow = screen.getByRole("button", { name: /BEST SHARED WINDOW Dec 19 - Jan 12/i });
    expect(within(bestWindow).getByText("25")).toBeInTheDocument();

    for (let month = 0; month < 4; month += 1) {
      await fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    }

    const lastBusyDay = screen.getByRole("button", { name: "Friday, December 18, 2026" });
    const firstFreeDay = screen.getByRole("button", { name: "Saturday, December 19, 2026" });
    expect(within(lastBusyDay).queryByText("ALL FREE")).not.toBeInTheDocument();
    expect(within(firstFreeDay).getByText("ALL FREE")).toBeInTheDocument();

    await fireEvent.click(firstFreeDay);
    expect(screen.getByText("No classes")).toBeInTheDocument();
  });

  it("considers source-backed free windows outside an August-to-September school year", async () => {
    comparisonEventsOverride = [{
      id: "8e3fc335-4be2-4e1e-9bc2-35708f70cb98",
      schoolId: "uiuc",
      name: "Year-round program closure",
      startDate: "2026-05-01",
      endDate: "2026-05-05",
      kind: "break",
    }];

    render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await addReadySchool(/University of Illinois Urbana-Champaign/i, "UIUC");

    const bestWindow = screen.getByRole("button", { name: /BEST SHARED WINDOW May 1 - May 5/i });
    expect(within(bestWindow).getByText("5")).toBeInTheDocument();
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

  it("publishes a missing PDF automatically, then adds the reusable school", async () => {
    submissionStatuses = ["processing", "ready"];
    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await fireEvent.change(input!, { target: { files: [pdf()] } });

    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole("button", { name: "Submit calendar for processing" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("Preparing Michigan's calendar.")).toBeInTheDocument();
    expect(comparisonRequests()).toHaveLength(0);
    expect(screen.queryByText(/admin approval|waiting for review/i)).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(450);
    expect(submissionStatusRequests()).toHaveLength(1);
    expect(comparisonRequests()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600);
    expect(screen.getByText("Michigan 2026-27 is ready.")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(650);
    await vi.advanceTimersByTimeAsync(0);

    expect(within(screen.getByRole("complementary")).getByText("Michigan")).toBeInTheDocument();

    const fetchMock = vi.mocked(fetch);
    const submissionRequest = fetchMock.mock.calls.find(([input, init]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname.endsWith("/submissions") && init?.method === "POST" && init.body instanceof FormData;
    });
    expect(submissionRequest).toBeDefined();
    const submittedFiles = (submissionRequest?.[1]?.body as FormData).getAll("files");
    expect(submittedFiles).toHaveLength(1);
    expect(submittedFiles[0]).toBeInstanceOf(File);
    expect((submittedFiles[0] as File).type).toBe("application/pdf");
    expect(submissionStatusRequests()).toHaveLength(2);
  });

  it("keeps long-running extraction saved without adding an unpublished school", async () => {
    submissionStatuses = Array.from({ length: 12 }, () => "processing" as const);
    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await fireEvent.change(input!, { target: { files: [pdf()] } });

    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole("button", { name: "Submit calendar for processing" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(14_850);

    expect(screen.getByText("STILL PROCESSING")).toBeInTheDocument();
    expect(screen.getByText(/AI is still extracting the calendar/i)).toBeInTheDocument();
    expect(submissionStatusRequests()).toHaveLength(12);
    expect(comparisonRequests()).toHaveLength(0);
    expect(within(screen.getByRole("complementary")).queryByText("Michigan")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves selected files when extraction fails and lets the student retry", async () => {
    submissionStatuses = ["failed"];
    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await fireEvent.change(input!, { target: { files: [pdf()] } });

    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole("button", { name: "Submit calendar for processing" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(450);

    expect(screen.getByRole("alert")).toHaveTextContent("We could not turn that upload into Michigan's calendar");
    expect(comparisonRequests()).toHaveLength(0);

    await fireEvent.click(screen.getByRole("button", { name: "Review files and try again" }));
    expect(screen.getByText("1 PDF selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit calendar for processing" })).toBeEnabled();
  });

  it("shows a truthful check-later state when polling is temporarily unavailable", async () => {
    submissionStatusFailure = "http";
    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await fireEvent.change(input!, { target: { files: [pdf()] } });

    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole("button", { name: "Submit calendar for processing" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(450);

    expect(screen.getByText("CHECK AGAIN SOON")).toBeInTheDocument();
    expect(screen.getByText(/could not refresh its status just now/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
    expect(comparisonRequests()).toHaveLength(0);
  });

  it("does not add a school when the modal closes during an in-flight status check", async () => {
    let finishStatus!: (response: Response) => void;
    submissionStatusResponse = () => new Promise<Response>((resolve) => { finishStatus = resolve; });

    const { container } = render(App);
    await screen.findByRole("heading", { name: "Add your first school." });
    await fireEvent.click(screen.getByRole("button", { name: "Choose a school" }));
    await fireEvent.click(screen.getByRole("button", { name: /University of Michigan/i }));
    await screen.findByText("Be the first to add Michigan.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await fireEvent.change(input!, { target: { files: [pdf()] } });

    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole("button", { name: "Submit calendar for processing" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(450);
    expect(submissionStatusRequests()).toHaveLength(1);

    await fireEvent.click(screen.getByRole("button", { name: "Close" }));
    finishStatus(new Response(JSON.stringify(submissionBody("ready")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(comparisonRequests()).toHaveLength(0);
    expect(within(screen.getByRole("complementary")).queryByText("Michigan")).not.toBeInTheDocument();
  });
});
