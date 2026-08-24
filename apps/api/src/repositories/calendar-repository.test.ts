import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "../db/client.js";
import {
  CalendarRepositoryNotConfiguredError,
  PostgresCalendarRepository,
  createCalendarRepository,
} from "./calendar-repository.js";

describe("calendar repository configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed without a database unless seed data is explicitly enabled", () => {
    expect(() => createCalendarRepository({
      databaseUrl: "",
      allowDevelopmentSeed: false,
    })).toThrow(CalendarRepositoryNotConfiguredError);

    expect(createCalendarRepository({
      databaseUrl: "",
      allowDevelopmentSeed: true,
    }).source).toBe("development_seed");
  });

  it("supports an explicitly enabled development-seed environment", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("USE_DEVELOPMENT_SEED", "true");

    expect(createCalendarRepository({ databaseUrl: "" }).source).toBe("development_seed");
  });

  it("never falls back to seed data in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("USE_DEVELOPMENT_SEED", "true");

    expect(() => createCalendarRepository({ databaseUrl: "" })).toThrow(
      CalendarRepositoryNotConfiguredError,
    );
  });

  it("returns the report snapshot read inside the atomic transition transaction", async () => {
    const reportId = "10000000-0000-4000-8000-000000000001";
    const reviewerId = "10000000-0000-4000-8000-000000000002";
    const transitionedRow = {
      id: reportId,
      calendarId: "10000000-0000-4000-8000-000000000003",
      schoolId: "uiuc",
      schoolName: "University of Illinois Urbana-Champaign",
      schoolShortName: "UIUC",
      academicYear: "2026-27",
      eventId: null,
      eventName: null,
      eventStartDate: null,
      eventEndDate: null,
      reason: "other" as const,
      details: "The official calendar needs review.",
      status: "reviewing" as const,
      createdAt: new Date("2026-08-24T12:00:00.000Z"),
      resolutionNotes: null,
      resolvedAt: null,
    };

    const updateQuery = {
      set: vi.fn(),
      where: vi.fn(),
      returning: vi.fn().mockResolvedValue([{ id: reportId }]),
    };
    updateQuery.set.mockReturnValue(updateQuery);
    updateQuery.where.mockReturnValue(updateQuery);

    const selectQuery = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      leftJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn().mockResolvedValue([transitionedRow]),
    };
    selectQuery.from.mockReturnValue(selectQuery);
    selectQuery.innerJoin.mockReturnValue(selectQuery);
    selectQuery.leftJoin.mockReturnValue(selectQuery);
    selectQuery.where.mockReturnValue(selectQuery);

    const transaction = {
      update: vi.fn().mockReturnValue(updateQuery),
      select: vi.fn().mockReturnValue(selectQuery),
    };
    const outsideSelect = vi.fn(() => {
      throw new Error("report snapshot escaped its transition transaction");
    });
    const connection = {
      db: {
        transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
        select: outsideSelect,
      },
      close: vi.fn(),
    } as unknown as DatabaseConnection;

    const repository = new PostgresCalendarRepository(connection, null);
    const report = await repository.updateAdminReport(
      reportId,
      { action: "start_review" },
      reviewerId,
    );

    expect(connection.db.transaction).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledOnce();
    expect(transaction.select).toHaveBeenCalledOnce();
    expect(outsideSelect).not.toHaveBeenCalled();
    expect(report).toMatchObject({ id: reportId, status: "reviewing" });
    expect(report.createdAt).toBe("2026-08-24T12:00:00.000Z");
  });
});
