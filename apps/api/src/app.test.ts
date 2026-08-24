import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("Common Days API", () => {
  it("returns searchable schools", async () => {
    const response = await app.request("/api/v1/schools?q=illinois");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schools).toHaveLength(1);
    expect(body.schools[0].shortName).toBe("UIUC");
  });

  it("returns a calendar comparison", async () => {
    const response = await app.request("/api/v1/calendars?schools=uiuc,nyu&year=2026-27");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schools).toHaveLength(2);
    expect(body.events.every((event: { schoolId: string }) => ["uiuc", "nyu"].includes(event.schoolId))).toBe(true);
  });
});
