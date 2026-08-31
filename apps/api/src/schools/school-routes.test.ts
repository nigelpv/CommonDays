import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createTestCalendarRepository } from "../testing/calendar-repository.fixture.js";

function createSchoolRequest(name: string, location: string) {
  return new Request("http://localhost/api/v1/schools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, location }),
  });
}

describe("school search and creation routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns direct library matches without a did-you-mean list", async () => {
    const app = createApp(createTestCalendarRepository());
    const response = await app.request("/api/v1/schools?q=Illinois");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schools.map((school: { id: string }) => school.id)).toEqual(["uiuc"]);
    expect(body.similarSchools).toEqual([]);
  });

  it("returns similar schools only when no direct result exists", async () => {
    const app = createApp(createTestCalendarRepository());
    const response = await app.request(
      "/api/v1/schools?q=University%20of%20Illinois%20Urbana%20Champaigne",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schools).toEqual([]);
    expect(body.similarSchools[0]).toMatchObject({
      id: "uiuc",
      name: "University of Illinois Urbana-Champaign",
    });
    expect(body.similarSchools[0].similarity).toBeGreaterThanOrEqual(0.7);
  });

  it("rejects an oversized search query", async () => {
    const app = createApp(createTestCalendarRepository());
    const response = await app.request(`/api/v1/schools?q=${"a".repeat(161)}`);

    expect(response.status).toBe(400);
  });

  it("allows an exact normalized duplicate and queues its durable alert", async () => {
    const repository = createTestCalendarRepository();
    const enqueue = vi.fn(async () => undefined);
    const app = createApp(repository, {
      schoolSimilarityAlertQueue: { enqueue },
    });

    const response = await app.request(createSchoolRequest(
      "  University of Illinois   Urbana-Champaign  ",
      "Champaign, Illinois",
    ));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.school).toMatchObject({
      name: "University of Illinois Urbana-Champaign",
      location: "Champaign, Illinois",
      availableYears: [],
    });
    expect(body.school.id).not.toBe("uiuc");
    expect(body.similarSchools).toEqual([
      expect.objectContaining({ id: "uiuc", similarity: 1 }),
    ]);
    expect(body.alertQueued).toBe(true);

    const [alertId] = await repository.listQueuedSchoolSimilarityAlerts();
    expect(alertId).toBeDefined();
    expect(enqueue).toHaveBeenCalledWith(alertId);
    expect(await repository.getSchoolSimilarityAlert(alertId!)).toMatchObject({
      status: "queued",
      createdSchool: { id: body.school.id },
      similarSchools: [{ id: "uiuc", similarity: 1 }],
    });
  });

  it("creates an unrelated school without an alert", async () => {
    const repository = createTestCalendarRepository();
    const enqueue = vi.fn(async () => undefined);
    const app = createApp(repository, {
      schoolSimilarityAlertQueue: { enqueue },
    });

    const response = await app.request(createSchoolRequest(
      "Tokyo Institute of Technology",
      "Tokyo, Japan",
    ));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.similarSchools).toEqual([]);
    expect(body.alertQueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await repository.listQueuedSchoolSimilarityAlerts()).toEqual([]);
  });

  it("keeps creation successful when alert enqueueing is temporarily unavailable", async () => {
    const repository = createTestCalendarRepository();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApp(repository, {
      schoolSimilarityAlertQueue: {
        enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable")),
      },
    });

    const response = await app.request(createSchoolRequest(
      "University of California Berkeley",
      "Berkeley, California",
    ));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.alertQueued).toBe(true);
    expect(await repository.listQueuedSchoolSimilarityAlerts()).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      "School similarity alert enqueue failed",
      expect.any(Error),
    );
  });

  it("does not wait for a slow alert queue before returning the created school", async () => {
    const repository = createTestCalendarRepository();
    const enqueue = vi.fn(() => new Promise<void>(() => undefined));
    const app = createApp(repository, {
      schoolSimilarityAlertQueue: { enqueue },
    });

    const outcome = await Promise.race([
      app.request(createSchoolRequest(
        "University of Illinois Urbana Champaign",
        "Champaign, Illinois",
      )),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(outcome).not.toBe("timed-out");
    expect((outcome as Response).status).toBe(201);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rate-limits repeated public school creation without changing similarity rules", async () => {
    const repository = createTestCalendarRepository();
    const app = createApp(repository, {
      schoolCreationRateLimit: { maxCreations: 1, windowMs: 60_000 },
    });

    const first = await app.request(createSchoolRequest(
      "University of Illinois Urbana Champaign",
      "Champaign, Illinois",
    ));
    const second = await app.request(createSchoolRequest(
      "University of Illinois Urbana Champaign",
      "Champaign, Illinois",
    ));

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("rejects missing creation details without writing a school", async () => {
    const repository = createTestCalendarRepository();
    const app = createApp(repository);
    const response = await app.request("/api/v1/schools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "University of Somewhere" }),
    });

    expect(response.status).toBe(400);
    expect(await repository.listQueuedSchoolSimilarityAlerts()).toEqual([]);
  });

  it("rejects control characters and oversized JSON before creating a school", async () => {
    const repository = createTestCalendarRepository();
    const app = createApp(repository);
    const controlCharacterResponse = await app.request(createSchoolRequest(
      "University of Somewhere\nElse",
      "Somewhere, California",
    ));
    const oversizedResponse = await app.request("/api/v1/schools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "University of Somewhere",
        location: `Somewhere ${"x".repeat(9_000)}`,
      }),
    });

    expect(controlCharacterResponse.status).toBe(400);
    expect(oversizedResponse.status).toBe(413);
    expect(await repository.listQueuedSchoolSimilarityAlerts()).toEqual([]);
  });
});
