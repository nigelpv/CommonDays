import type { CalendarComparison, CalendarReport, School } from "@commondays/shared";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import type { DatabaseConnection } from "../db/client.js";
import { createDatabase } from "../db/client.js";
import { academicCalendars, calendarEvents, calendarReports, schools as schoolTable } from "../db/schema.js";
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

export interface CalendarRepository {
  readonly source: DataSource;
  searchSchools(query: string): Promise<School[]>;
  getComparison(query: ComparisonQuery): Promise<CalendarComparison>;
  createReport(report: CalendarReport): Promise<SubmittedReport>;
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

export function createSeedRepository(): CalendarRepository {
  return {
    source: "development_seed",

    async searchSchools(query) {
      const normalizedQuery = query.trim().toLowerCase();
      return normalizedQuery
        ? seedSchools.filter((school) =>
            `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(normalizedQuery),
          )
        : seedSchools;
    },

    async getComparison({ academicYear, schoolIds }) {
      const selectedSchools = schoolIds
        .map((schoolId) => seedSchools.find((school) => school.id === schoolId))
        .filter((school): school is School => Boolean(school?.availableYears.includes(academicYear)));
      const selectedSchoolIds = new Set(selectedSchools.map((school) => school.id));

      return {
        academicYear,
        schools: selectedSchools,
        events: seedEvents.filter((event) => selectedSchoolIds.has(event.schoolId)),
        source: "development_seed",
      };
    },

    async createReport(report) {
      const school = seedSchools.find(
        (candidate) => candidate.id === report.schoolId && candidate.availableYears.includes(report.academicYear),
      );
      if (!school) throw new CalendarNotFoundError();

      if (report.eventId) {
        const event = seedEvents.find((candidate) => candidate.id === report.eventId);
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
