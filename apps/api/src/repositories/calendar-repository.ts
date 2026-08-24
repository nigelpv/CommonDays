import { CalendarSubmissionSchema } from "@commondays/shared";
import type {
  AdminReport,
  AdminReportAction,
  AdminReportStatus,
  CalendarAvailability,
  CalendarComparison,
  CalendarReport,
  CalendarSubmission,
  CalendarSubmissionRequest,
  School,
} from "@commondays/shared";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/client.js";
import { createDatabase } from "../db/client.js";
import {
  academicCalendars,
  calendarEvents,
  calendarReports,
  calendarUploads,
  schools as schoolTable,
} from "../db/schema.js";
import {
  createDurableCalendarSubmission,
  type CalendarSubmissionPersistence,
  type CalendarUploadFile,
  type ReservedCalendarSubmission,
} from "../services/calendar-submission-service.js";
import { createCalendarStorage, type CalendarStorage } from "../storage/calendar-storage.js";

export type { CalendarUploadFile } from "../services/calendar-submission-service.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DataSource = CalendarComparison["source"];

export interface ComparisonQuery {
  academicYear: string;
  schoolIds: string[];
}

export type SubmittedReport = CalendarReport & {
  id: string;
  status: "submitted";
};

export interface CalendarRepository {
  readonly source: DataSource;
  searchSchools(query: string): Promise<School[]>;
  getAvailability(schoolId: string, academicYear: string): Promise<CalendarAvailability>;
  getComparison(query: ComparisonQuery): Promise<CalendarComparison>;
  createCalendarSubmission(
    request: CalendarSubmissionRequest,
    files: CalendarUploadFile[],
  ): Promise<CalendarSubmission>;
  getCalendarSubmission(id: string): Promise<CalendarSubmission>;
  createReport(report: CalendarReport): Promise<SubmittedReport>;
  isAdminUser(userId: string): Promise<boolean>;
  listAdminReports(status?: AdminReportStatus): Promise<AdminReport[]>;
  getAdminReport(id: string): Promise<AdminReport>;
  updateAdminReport(id: string, action: AdminReportAction, reviewerId: string): Promise<AdminReport>;
}

export class SchoolNotFoundError extends Error {
  constructor() {
    super("That school is not in the Common Days library yet.");
    this.name = "SchoolNotFoundError";
  }
}

export class CalendarAlreadyAvailableError extends Error {
  constructor() {
    super("That calendar is already available and can be reused.");
    this.name = "CalendarAlreadyAvailableError";
  }
}

export class CalendarSubmissionNotFoundError extends Error {
  constructor() {
    super("That calendar submission could not be found.");
    this.name = "CalendarSubmissionNotFoundError";
  }
}

export class UploadStorageNotConfiguredError extends Error {
  constructor() {
    super("Cloud file storage is not connected yet.");
    this.name = "UploadStorageNotConfiguredError";
  }
}

export class SubmissionAlreadyInProgressError extends Error {
  constructor(readonly submissionId: string) {
    super("Someone already submitted that calendar and it is being processed.");
    this.name = "SubmissionAlreadyInProgressError";
  }
}

export class CalendarNotFoundError extends Error {
  constructor() {
    super("No published calendar exists for that school and academic year.");
    this.name = "CalendarNotFoundError";
  }
}

export class ReportEventMismatchError extends Error {
  constructor() {
    super("The reported event does not belong to that calendar.");
    this.name = "ReportEventMismatchError";
  }
}

export class AdminReportNotFoundError extends Error {
  constructor() {
    super("That correction report could not be found.");
    this.name = "AdminReportNotFoundError";
  }
}

export class AdminReportTransitionError extends Error {
  constructor() {
    super("That report has already moved to another review state.");
    this.name = "AdminReportTransitionError";
  }
}

export class CalendarRepositoryNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is required.");
    this.name = "CalendarRepositoryNotConfiguredError";
  }
}

function mapSchool(
  school: typeof schoolTable.$inferSelect,
  yearsBySchool: Map<string, string[]>,
): School {
  return {
    id: school.id,
    name: school.name,
    shortName: school.shortName,
    location: school.location,
    initials: school.initials,
    color: school.color,
    availableYears: yearsBySchool.get(school.id) ?? [],
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export class PostgresCalendarRepository implements CalendarRepository {
  readonly source = "supabase" as const;

  constructor(
    private readonly connection: DatabaseConnection,
    private readonly storage: CalendarStorage | null,
  ) {}

  private async getPublishedYears(schoolIds: string[]) {
    const yearsBySchool = new Map<string, string[]>();
    if (schoolIds.length === 0) return yearsBySchool;

    const yearRows = await this.connection.db
      .select({ schoolId: academicCalendars.schoolId, academicYear: academicCalendars.academicYear })
      .from(academicCalendars)
      .where(and(inArray(academicCalendars.schoolId, schoolIds), eq(academicCalendars.status, "published")))
      .orderBy(asc(academicCalendars.academicYear));

    for (const row of yearRows) {
      const years = yearsBySchool.get(row.schoolId) ?? [];
      if (!years.includes(row.academicYear)) years.push(row.academicYear);
      yearsBySchool.set(row.schoolId, years);
    }

    return yearsBySchool;
  }

  private async selectAdminReports(
    options: { id?: string; status?: AdminReportStatus } = {},
    executor: Pick<DatabaseConnection["db"], "select"> = this.connection.db,
  ) {
    const conditions = [
      options.id ? eq(calendarReports.id, options.id) : undefined,
      options.status ? eq(calendarReports.status, options.status) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));

    const rows = await executor
      .select({
        id: calendarReports.id,
        calendarId: calendarReports.calendarId,
        schoolId: academicCalendars.schoolId,
        schoolName: schoolTable.name,
        schoolShortName: schoolTable.shortName,
        academicYear: academicCalendars.academicYear,
        eventId: calendarReports.eventId,
        eventName: calendarEvents.name,
        eventStartDate: calendarEvents.startDate,
        eventEndDate: calendarEvents.endDate,
        reason: calendarReports.reason,
        details: calendarReports.details,
        status: calendarReports.status,
        createdAt: calendarReports.createdAt,
        resolutionNotes: calendarReports.resolutionNotes,
        resolvedAt: calendarReports.resolvedAt,
      })
      .from(calendarReports)
      .innerJoin(academicCalendars, eq(calendarReports.calendarId, academicCalendars.id))
      .innerJoin(schoolTable, eq(academicCalendars.schoolId, schoolTable.id))
      .leftJoin(calendarEvents, eq(calendarReports.eventId, calendarEvents.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(calendarReports.createdAt));

    return rows.map((report): AdminReport => ({
      ...report,
      createdAt: report.createdAt.toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
    }));
  }

  async searchSchools(query: string): Promise<School[]> {
    const normalizedQuery = query.trim();
    const rows = normalizedQuery
      ? await this.connection.db
          .select()
          .from(schoolTable)
          .where(
            or(
              ilike(schoolTable.name, `%${normalizedQuery}%`),
              ilike(schoolTable.shortName, `%${normalizedQuery}%`),
              ilike(schoolTable.location, `%${normalizedQuery}%`),
            ),
          )
          .orderBy(asc(schoolTable.name))
      : await this.connection.db.select().from(schoolTable).orderBy(asc(schoolTable.name));

    const yearsBySchool = await this.getPublishedYears(rows.map((school) => school.id));
    return rows.map((school) => mapSchool(school, yearsBySchool));
  }

  async getAvailability(schoolId: string, academicYear: string): Promise<CalendarAvailability> {
    const [school] = await this.connection.db
      .select({ id: schoolTable.id })
      .from(schoolTable)
      .where(eq(schoolTable.id, schoolId))
      .limit(1);
    if (!school) throw new SchoolNotFoundError();

    const calendarRows = await this.connection.db
      .select({ id: academicCalendars.id, status: academicCalendars.status })
      .from(academicCalendars)
      .where(and(eq(academicCalendars.schoolId, schoolId), eq(academicCalendars.academicYear, academicYear)))
      .orderBy(desc(academicCalendars.version));

    if (calendarRows.some((calendar) => calendar.status === "published")) {
      return { schoolId, academicYear, status: "available" };
    }
    const activeCalendar = calendarRows.find(
      (calendar) => calendar.status === "processing" || calendar.status === "needs_review",
    );
    if (activeCalendar) {
      return { schoolId, academicYear, status: "processing", submissionId: activeCalendar.id };
    }
    return { schoolId, academicYear, status: "missing" };
  }

  async getComparison({ academicYear, schoolIds }: ComparisonQuery): Promise<CalendarComparison> {
    if (schoolIds.length === 0) {
      return { academicYear, schools: [], events: [], source: "supabase" };
    }

    const schoolRows = await this.connection.db
      .select()
      .from(schoolTable)
      .where(inArray(schoolTable.id, schoolIds));
    const schoolById = new Map(schoolRows.map((school) => [school.id, school]));

    const calendarRows = await this.connection.db
      .select({ id: academicCalendars.id, schoolId: academicCalendars.schoolId })
      .from(academicCalendars)
      .where(
        and(
          inArray(academicCalendars.schoolId, schoolIds),
          eq(academicCalendars.academicYear, academicYear),
          eq(academicCalendars.status, "published"),
        ),
      );
    const calendarBySchool = new Map(calendarRows.map((calendar) => [calendar.schoolId, calendar.id]));
    const schoolByCalendar = new Map(calendarRows.map((calendar) => [calendar.id, calendar.schoolId]));
    const availableSchoolIds = schoolIds.filter(
      (schoolId) => schoolById.has(schoolId) && calendarBySchool.has(schoolId),
    );
    const yearsBySchool = await this.getPublishedYears(availableSchoolIds);
    const calendarIds = [...schoolByCalendar.keys()];

    const eventRows = calendarIds.length
      ? await this.connection.db
          .select()
          .from(calendarEvents)
          .where(inArray(calendarEvents.calendarId, calendarIds))
          .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.name))
      : [];

    return {
      academicYear,
      schools: availableSchoolIds.map((schoolId) => mapSchool(schoolById.get(schoolId)!, yearsBySchool)),
      events: eventRows.map((event) => ({
        id: event.id,
        schoolId: schoolByCalendar.get(event.calendarId)!,
        name: event.name,
        startDate: event.startDate,
        endDate: event.endDate,
        kind: event.kind,
      })),
      source: "supabase",
    };
  }

  private async reserveCalendarSubmission(
    request: CalendarSubmissionRequest,
    sourceType: ReservedCalendarSubmission["sourceType"],
  ): Promise<ReservedCalendarSubmission> {
    try {
      return await this.connection.db.transaction(async (transaction) => {
        const [school] = await transaction
          .select({ id: schoolTable.id })
          .from(schoolTable)
          .where(eq(schoolTable.id, request.schoolId))
          .limit(1);
        if (!school) throw new SchoolNotFoundError();

        const existingCalendars = await transaction
          .select({
            id: academicCalendars.id,
            status: academicCalendars.status,
            version: academicCalendars.version,
          })
          .from(academicCalendars)
          .where(
            and(
              eq(academicCalendars.schoolId, request.schoolId),
              eq(academicCalendars.academicYear, request.academicYear),
            ),
          )
          .orderBy(desc(academicCalendars.version));

        if (existingCalendars.some((calendar) => calendar.status === "published")) {
          throw new CalendarAlreadyAvailableError();
        }

        const activeCalendar = existingCalendars.find(
          (calendar) => calendar.status === "processing" || calendar.status === "needs_review",
        );
        if (activeCalendar) throw new SubmissionAlreadyInProgressError(activeCalendar.id);

        const nextVersion = Math.max(0, ...existingCalendars.map((calendar) => calendar.version)) + 1;
        const [createdCalendar] = await transaction
          .insert(academicCalendars)
          .values({
            schoolId: request.schoolId,
            academicYear: request.academicYear,
            version: nextVersion,
            status: "processing",
            sourceType,
          })
          .returning({
            id: academicCalendars.id,
            schoolId: academicCalendars.schoolId,
            academicYear: academicCalendars.academicYear,
            sourceType: academicCalendars.sourceType,
            createdAt: academicCalendars.createdAt,
          });

        if (!createdCalendar || (createdCalendar.sourceType !== "screenshots" && createdCalendar.sourceType !== "pdf")) {
          throw new Error("The calendar submission could not be reserved.");
        }

        return {
          ...createdCalendar,
          sourceType: createdCalendar.sourceType,
        };
      });
    } catch (error) {
      if (
        error instanceof SchoolNotFoundError ||
        error instanceof CalendarAlreadyAvailableError ||
        error instanceof SubmissionAlreadyInProgressError ||
        !isUniqueViolation(error)
      ) {
        throw error;
      }

      const availability = await this.getAvailability(request.schoolId, request.academicYear);
      if (availability.status === "available") throw new CalendarAlreadyAvailableError();
      if (availability.status === "processing") {
        throw new SubmissionAlreadyInProgressError(availability.submissionId);
      }
      throw error;
    }
  }

  async createCalendarSubmission(
    request: CalendarSubmissionRequest,
    files: CalendarUploadFile[],
  ): Promise<CalendarSubmission> {
    if (!this.storage) throw new UploadStorageNotConfiguredError();

    const persistence: CalendarSubmissionPersistence = {
      reserve: (submissionRequest, sourceType) =>
        this.reserveCalendarSubmission(submissionRequest, sourceType),
      insertUploads: async (uploads) => {
        if (uploads.length === 0) return;
        await this.connection.db.insert(calendarUploads).values(uploads);
      },
      markFailed: async (calendarId) => {
        await this.connection.db
          .update(academicCalendars)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(academicCalendars.id, calendarId));
      },
    };

    return createDurableCalendarSubmission({
      request,
      files,
      storage: this.storage,
      persistence,
    });
  }

  async getCalendarSubmission(id: string): Promise<CalendarSubmission> {
    if (!uuidPattern.test(id)) throw new CalendarSubmissionNotFoundError();

    const [calendar] = await this.connection.db
      .select({
        id: academicCalendars.id,
        schoolId: academicCalendars.schoolId,
        academicYear: academicCalendars.academicYear,
        status: academicCalendars.status,
        sourceType: academicCalendars.sourceType,
        createdAt: academicCalendars.createdAt,
      })
      .from(academicCalendars)
      .where(eq(academicCalendars.id, id))
      .limit(1);
    if (!calendar || (calendar.sourceType !== "screenshots" && calendar.sourceType !== "pdf")) {
      throw new CalendarSubmissionNotFoundError();
    }

    const [fileCountRow] = await this.connection.db
      .select({ value: count() })
      .from(calendarUploads)
      .where(eq(calendarUploads.calendarId, calendar.id));

    return CalendarSubmissionSchema.parse({
      id: calendar.id,
      schoolId: calendar.schoolId,
      academicYear: calendar.academicYear,
      status:
        calendar.status === "published"
          ? "ready"
          : calendar.status === "processing" || calendar.status === "needs_review"
            ? "processing"
            : "failed",
      sourceType: calendar.sourceType,
      fileCount: fileCountRow.value,
      createdAt: calendar.createdAt.toISOString(),
    });
  }

  async createReport(report: CalendarReport): Promise<SubmittedReport> {
    const [calendar] = await this.connection.db
      .select({ id: academicCalendars.id })
      .from(academicCalendars)
      .where(
        and(
          eq(academicCalendars.schoolId, report.schoolId),
          eq(academicCalendars.academicYear, report.academicYear),
          eq(academicCalendars.status, "published"),
        ),
      )
      .limit(1);
    if (!calendar) throw new CalendarNotFoundError();

    if (report.eventId) {
      if (!uuidPattern.test(report.eventId)) throw new ReportEventMismatchError();

      const [event] = await this.connection.db
        .select({ id: calendarEvents.id })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.id, report.eventId), eq(calendarEvents.calendarId, calendar.id)))
        .limit(1);
      if (!event) throw new ReportEventMismatchError();
    }

    const [createdReport] = await this.connection.db
      .insert(calendarReports)
      .values({
        calendarId: calendar.id,
        eventId: report.eventId,
        reason: report.reason,
        details: report.details,
      })
      .returning({ id: calendarReports.id, status: calendarReports.status });

    return { id: createdReport.id, status: "submitted", ...report };
  }

  async isAdminUser(userId: string): Promise<boolean> {
    if (!uuidPattern.test(userId)) return false;

    const rows = await this.connection.db.execute<{ isAdmin: boolean }>(sql`
      select exists (
        select 1
        from private.app_admin
        where user_id = ${userId}::uuid
      ) as "isAdmin"
    `);
    return rows[0]?.isAdmin === true;
  }

  async listAdminReports(status?: AdminReportStatus): Promise<AdminReport[]> {
    return this.selectAdminReports({ status });
  }

  async getAdminReport(id: string): Promise<AdminReport> {
    if (!uuidPattern.test(id)) throw new AdminReportNotFoundError();
    const [report] = await this.selectAdminReports({ id });
    if (!report) throw new AdminReportNotFoundError();
    return report;
  }

  async updateAdminReport(
    id: string,
    action: AdminReportAction,
    reviewerId: string,
  ): Promise<AdminReport> {
    if (!uuidPattern.test(id)) throw new AdminReportNotFoundError();
    if (!uuidPattern.test(reviewerId)) throw new AdminReportTransitionError();

    const allowedStatuses: AdminReportStatus[] = action.action === "start_review"
      ? ["submitted"]
      : ["submitted", "reviewing"];
    const values = action.action === "start_review"
      ? {
          status: "reviewing" as const,
          reviewedBy: reviewerId,
        }
      : {
          status: "rejected" as const,
          reviewedBy: reviewerId,
          resolutionNotes: action.resolutionNotes,
          resolvedAt: new Date(),
        };

    return this.connection.db.transaction(async (transaction) => {
      const updated = await transaction
        .update(calendarReports)
        .set(values)
        .where(and(eq(calendarReports.id, id), inArray(calendarReports.status, allowedStatuses)))
        .returning({ id: calendarReports.id });

      if (updated.length === 0) {
        const [existing] = await transaction
          .select({ id: calendarReports.id })
          .from(calendarReports)
          .where(eq(calendarReports.id, id))
          .limit(1);
        if (!existing) throw new AdminReportNotFoundError();
        throw new AdminReportTransitionError();
      }

      const [report] = await this.selectAdminReports({ id }, transaction);
      if (!report) throw new AdminReportNotFoundError();
      return report;
    });
  }
}

export function createCalendarRepository(
  options: {
    databaseUrl?: string;
    storage?: CalendarStorage | null;
  } = {},
): CalendarRepository {
  const connection = createDatabase(options.databaseUrl ?? process.env.DATABASE_URL);
  if (!connection) throw new CalendarRepositoryNotConfiguredError();

  const storage = "storage" in options ? options.storage ?? null : createCalendarStorage();
  return new PostgresCalendarRepository(connection, storage);
}
