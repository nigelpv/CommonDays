import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";

const schools = [
  { id: "uiuc", name: "University of Illinois Urbana-Champaign", shortName: "UIUC", location: "Champaign, Illinois", initials: "IL", color: "#6574f7", availableYears: ["2026-27"] },
];

describe("Common Days app", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("calendars")
        ? { academicYear: "2026-27", schools, events: [], source: "development_seed" }
        : { schools }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  it("renders the core calendar comparison", async () => {
    render(App);
    expect(await screen.findByText("When is everyone free?")).toBeInTheDocument();
    expect(screen.getAllByText("UIUC").length).toBeGreaterThan(0);
    expect(screen.getByText("December 2026")).toBeInTheDocument();
  });
});
