import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createSeedRepository } from "./repositories/calendar-repository.js";

const app = createApp(createSeedRepository());

describe("Common Days API", () => {
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
    expect(body.source).toBe("development_seed");
  });

  it("rejects an invalid academic year", async () => {
    const response = await app.request("/api/v1/calendars?schools=uiuc&year=2026/27");
    expect(response.status).toBe(400);
  });

  it("rejects a comparison without schools", async () => {
    const response = await app.request("/api/v1/calendars?schools=&year=2026-27");
    expect(response.status).toBe(400);
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

    expect(body.dataSource).toBe("development_seed");
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });
});
