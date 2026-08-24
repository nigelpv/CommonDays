import { CalendarSubmissionSchema } from "@commondays/shared";
import type {
  CalendarAvailability,
  CalendarComparison,
  CalendarReport,
  CalendarSubmission,
  CalendarSubmissionRequest,
  School,
} from "@commondays/shared";
import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { DatabaseConnection } from "../db/client.js";
import { createDatabase } from "../db/client.js";
import {
  academicCalendars,
  calendarEvents,
  calendarReports,
  calendarUploads,
  schools as schoolTable,
} from "../db/schema.js";
import { events as seedEvents, schools as seedSchools } from "../data.js";

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

export interface CalendarUploadFile {
  name: string;
  mimeType: string;
  size: number;
  content: Uint8Array;
}

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

function mockEventsFor(schoolId: string, academicYear: string, submissionId: string) {
  const startYear = Number(academicYear.slice(0, 4));
  const nextYear = startYear + 1;

  return [
    {
      id: `${submissionId}-thanksgiving`,
      schoolId,
      name: "Thanksgiving break",
      startDate: `${startYear}-11-25`,
      endDate: `${startYear}-11-29`,
      kind: "break" as const,
    },
    {
      id: `${submissionId}-winter`,
      schoolId,
      name: "Winter break",
      startDate: `${startYear}-12-20`,
      endDate: `${nextYear}-01-10`,
      kind: "break" as const,
    },
    {
      id: `${submissionId}-spring`,
      schoolId,
      name: "Spring break",
      startDate: `${nextYear}-03-06`,
      endDate: `${nextYear}-03-14`,
      kind: "break" as const,
    },
    {
      id: `${submissionId}-summer`,
      schoolId,
      name: "Summer break",
      startDate: `${nextYear}-05-02`,
      endDate: `${nextYear}-08-22`,
      kind: "break" as const,
    },
  ];
}

export function createSeedRepository(): CalendarRepository {
  let localSchools = seedSchools.map((school) => ({ ...school, availableYears: [...school.availableYears] }));
  let localEvents = seedEvents.map((event) => ({ ...event }));
  const submissions = new Map<string, { submission: CalendarSubmission; readyAt: number }>();

  function getSchool(schoolId: string) {
    const school = localSchools.find((candidate) => candidate.id === schoolId);
    if (!school) throw new SchoolNotFoundError();
    return school;
  }

  function publishIfReady(record: { submission: CalendarSubmission; readyAt: number }) {
    if (record.submission.status !== "processing" || Date.now() < record.readyAt) return;

    record.submission = { ...record.submission, status: "ready" };
    localSchools = localSchools.map((school) =>
      school.id === record.submission.schoolId && !school.availableYears.includes(record.submission.academicYear)
        ? { ...school, availableYears: [...school.availableYears, record.submission.academicYear] }
        : school,
    );
    localEvents = [
      ...localEvents,
      ...mockEventsFor(record.submission.schoolId, record.submission.academicYear, record.submission.id),
    ];
  }

  return {
    source: "development_seed",

    async searchSchools(query) {
      const normalizedQuery = query.trim().toLowerCase();
      return normalizedQuery
        ? localSchools.filter((school) =>
            `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(normalizedQuery),
          )
        : localSchools;
    },

    async getAvailability(schoolId, academicYear) {
      const school = getSchool(schoolId);
      if (school.availableYears.includes(academicYear)) return { schoolId, academicYear, status: "available" };

      const activeSubmission = [...submissions.values()].find(
        (record) =>
          record.submission.schoolId === schoolId &&
          record.submission.academicYear === academicYear &&
          record.submission.status === "processing",
      );
      if (activeSubmission) {
        publishIfReady(activeSubmission);
        return activeSubmission.submission.status === "ready"
          ? { schoolId, academicYear, status: "available" }
          : { schoolId, academicYear, status: "processing", submissionId: activeSubmission.submission.id };
      }

      return { schoolId, academicYear, status: "missing" };
    },

    async getComparison({ academicYear, schoolIds }) {
      const selectedSchools = schoolIds
        .map((schoolId) => localSchools.find((school) => school.id === schoolId))
        .filter((school): school is School => Boolean(school?.availableYears.includes(academicYear)));
      const selectedSchoolIds = new Set(selectedSchools.map((school) => school.id));

      return {
        academicYear,
        schools: selectedSchools,
        events: localEvents.filter((event) => selectedSchoolIds.has(event.schoolId)),
        source: "development_seed",
      };
    },

    async createCalendarSubmission(request, files) {
      const school = getSchool(request.schoolId);
      if (school.availableYears.includes(request.academicYear)) throw new CalendarAlreadyAvailableError();

      const activeSubmission = [...submissions.values()].find(
        (record) =>
          record.submission.schoolId === request.schoolId &&
          record.submission.academicYear === request.academicYear &&
          record.submission.status === "processing",
      );
      if (activeSubmission) throw new SubmissionAlreadyInProgressError(activeSubmission.submission.id);

      const submission = CalendarSubmissionSchema.parse({
        id: crypto.randomUUID(),
        schoolId: request.schoolId,
        academicYear: request.academicYear,
        status: "processing",
        sourceType: files[0]?.mimeType === "application/pdf" ? "pdf" : "screenshots",
        fileCount: files.length,
        createdAt: new Date().toISOString(),
      });
      submissions.set(submission.id, { submission, readyAt: Date.now() + 1_200 });
      return { ...submission };
    },

    async getCalendarSubmission(id) {
      const record = submissions.get(id);
      if (!record) throw new CalendarSubmissionNotFoundError();
      publishIfReady(record);
      return { ...record.submission };
    },

    async createReport(report) {
      const school = localSchools.find(
        (candidate) => candidate.id === report.schoolId && candidate.availableYears.includes(report.academicYear),
      );
      if (!school) throw new CalendarNotFoundError();

      if (report.eventId) {
        const event = localEvents.find((candidate) => candidate.id === report.eventId);
        if (!event || event.schoolId !== report.schoolId) throw new ReportEventMismatchError();
      }

      return { id: crypto.randomUUID(), status: "submitted", ...report };
    },
  };
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

class PostgresCalendarRepository implements CalendarRepository {
  readonly source = "supabase" as const;

  constructor(private readonly connection: DatabaseConnection) {}

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

  async createCalendarSubmission(): Promise<CalendarSubmission> {
    throw new UploadStorageNotConfiguredError();
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
}

export function createCalendarRepository(options: { databaseUrl?: string } = {}): CalendarRepository {
  const connection = createDatabase(options.databaseUrl ?? process.env.DATABASE_URL);
  return connection ? new PostgresCalendarRepository(connection) : createSeedRepository();
}
