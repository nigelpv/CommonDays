import { describe, expect, it, vi } from "vitest";
import { Inngest } from "inngest";
import type { CalendarRepository } from "../repositories/calendar-repository.js";
import {
  CALENDAR_RECOVERY_CRON,
  SCHOOL_ALERT_RECOVERY_CRON,
  calendarExtractionQueueIsConfigured,
  createCalendarExtractionRuntime,
} from "./calendar-extraction.js";

describe("calendar extraction Inngest configuration", () => {
  it("uses daily recovery sweeps so free serverless hosting can sleep", () => {
    expect(CALENDAR_RECOVERY_CRON).toBe("17 8 * * *");
    expect(SCHOOL_ALERT_RECOVERY_CRON).toBe("43 8 * * *");
  });

  it("fails closed without both cloud keys", () => {
    expect(calendarExtractionQueueIsConfigured({})).toBe(false);
    expect(calendarExtractionQueueIsConfigured({ INNGEST_EVENT_KEY: "event-key" })).toBe(false);
    expect(calendarExtractionQueueIsConfigured({ INNGEST_SIGNING_KEY: "signing-key" })).toBe(false);
  });

  it("accepts complete cloud configuration or explicit local development mode", () => {
    expect(
      calendarExtractionQueueIsConfigured({
        INNGEST_EVENT_KEY: "event-key",
        INNGEST_SIGNING_KEY: "signing-key",
      }),
    ).toBe(true);
    expect(calendarExtractionQueueIsConfigured({ INNGEST_DEV: "true" })).toBe(true);
    expect(calendarExtractionQueueIsConfigured({ INNGEST_DEV: "http://localhost:8288" })).toBe(true);
  });

  it("does not construct a runtime when durable processing is not configured", () => {
    const repository = {} as never;
    const extractor = { model: "test", extract: vi.fn() };

    expect(createCalendarExtractionRuntime({ repository, extractor, environment: {} })).toBeNull();
  });

  it("exposes the similarity-alert queue only when email delivery is configured", async () => {
    const client = new Inngest({ id: "common-days-test", isDev: true });
    const send = vi.spyOn(client, "send").mockResolvedValue({ ids: ["event-id"] });
    const repository = {} as CalendarRepository;
    const extractor = { model: "test", extract: vi.fn() };

    const withoutMailer = createCalendarExtractionRuntime({
      repository,
      extractor,
      environment: { INNGEST_DEV: "true" },
      client,
    });
    expect(withoutMailer?.schoolSimilarityAlertQueue).toBeNull();

    const withMailer = createCalendarExtractionRuntime({
      repository,
      extractor: null,
      schoolSimilarityAlertMailer: { send: vi.fn() },
      environment: { INNGEST_DEV: "true" },
      client,
    });
    expect(withMailer?.queue).toBeNull();
    await withMailer?.schoolSimilarityAlertQueue?.enqueue("bc36f274-e94e-4381-b35e-2e62b33166cb");

    expect(send).toHaveBeenCalledWith({
      name: "commondays/school.similarity-alert.requested",
      data: { alertId: "bc36f274-e94e-4381-b35e-2e62b33166cb" },
    });
  });

  it("does not serve an empty worker when neither extraction nor email is configured", () => {
    expect(createCalendarExtractionRuntime({
      repository: {} as CalendarRepository,
      extractor: null,
      schoolSimilarityAlertMailer: null,
      environment: { INNGEST_DEV: "true" },
    })).toBeNull();
  });
});
