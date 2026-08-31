import { createHash, randomUUID } from "node:crypto";
import { CalendarSubmissionSchema, getAcademicYearDateWindow } from "@commondays/shared";
import type {
  AdminEditableActivityPeriod,
  AdminEditableEvent,
  AdminReport,
  AdminReportAction,
  AdminReportDetail,
  AdminReportSourceUrlResponse,
  AdminReportStatus,
  CalendarAvailability,
  CalendarComparison,
  CalendarReport,
  CalendarSubmission,
  CalendarSubmissionRequest,
  School,
  SchoolCreateRequest,
  SimilarSchool,
} from "@commondays/shared";
import { and, asc, count, desc, eq, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/client.js";
import { createDatabase } from "../db/client.js";
import {
  academicCalendars,
  calendarActivityPeriods,
  calendarCorrections,
  calendarExtractionJobs,
  calendarEvents,
  calendarReports,
  calendarUploads,
  schoolSimilarityAlertMatches,
  schoolSimilarityAlerts,
  schools as schoolTable,
} from "../db/schema.js";
import { deriveInternalCalendarGaps } from "../extraction/calendar-extraction-service.js";
import type {
  CalendarExtractionClaim,
  CalendarExtractionInput,
  PublishableCalendarActivityPeriod,
  PublishableCalendarEvent,
} from "../extraction/types.js";
import {
  createDurableCalendarSubmission,
  type CalendarSubmissionPersistence,
  type CalendarUploadFile,
  type ReservedCalendarSubmission,
} from "../services/calendar-submission-service.js";
import {
  deriveSchoolPresentation,
  normalizeSchoolName,
  SCHOOL_SIMILARITY_THRESHOLD,
} from "../schools/school-similarity.js";
import { createCalendarStorage, type CalendarStorage } from "../storage/calendar-storage.js";

export type { CalendarUploadFile } from "../services/calendar-submission-service.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const similarityScoreScale = 10_000;
const schoolSearchResultLimit = 25;
const schoolSimilarityAlertAttemptLimit = 8;

export type DataSource = CalendarComparison["source"];

export interface ComparisonQuery {
  academicYear: string;
  schoolIds: string[];
}

export type SubmittedReport = CalendarReport & {
  id: string;
  status: "submitted";
};

export interface SchoolSearchResult {
  schools: School[];
  similarSchools: SimilarSchool[];
}

export interface CreatedSchoolResult {
  school: School;
  similarSchools: SimilarSchool[];
  alertId: string | null;
}

export interface SchoolSimilarityAlertSchool {
  id: string;
  name: string;
  shortName: string;
  location: string;
}

export interface SchoolSimilarityAlert {
  id: string;
  status: "queued" | "sent";
  nextAttemptAt: string;
  createdSchool: SchoolSimilarityAlertSchool;
  similarSchools: Array<SchoolSimilarityAlertSchool & { similarity: number }>;
}

export interface CalendarRepository {
  readonly source: DataSource;
  searchSchools(query: string): Promise<SchoolSearchResult>;
  createSchool(request: SchoolCreateRequest): Promise<CreatedSchoolResult>;
  getSchoolSimilarityAlert(id: string): Promise<SchoolSimilarityAlert | null>;
  listQueuedSchoolSimilarityAlerts(limit?: number): Promise<string[]>;
  markSchoolSimilarityAlertSent(id: string, providerMessageId: string): Promise<void>;
  recordSchoolSimilarityAlertFailure(id: string, error: string): Promise<void>;
  getAvailability(schoolId: string, academicYear: string): Promise<CalendarAvailability>;
  getComparison(query: ComparisonQuery): Promise<CalendarComparison>;
  createCalendarSubmission(
    request: CalendarSubmissionRequest,
    files: CalendarUploadFile[],
  ): Promise<CalendarSubmission>;
  getCalendarSubmission(id: string): Promise<CalendarSubmission>;
  claimCalendarExtraction(calendarId: string): Promise<CalendarExtractionClaim | null>;
  getCalendarExtractionInput(claim: CalendarExtractionClaim): Promise<CalendarExtractionInput>;
  publishCalendarExtraction(
    claim: CalendarExtractionClaim,
    model: string,
    periods: PublishableCalendarActivityPeriod[],
    events: PublishableCalendarEvent[],
    resultHash: string,
  ): Promise<void>;
  failCalendarExtraction(calendarId: string, errorMessage: string): Promise<void>;
  listQueuedCalendarExtractions(limit?: number): Promise<string[]>;
  createReport(report: CalendarReport): Promise<SubmittedReport>;
  isAdminUser(userId: string): Promise<boolean>;
  listAdminReports(status?: AdminReportStatus): Promise<AdminReport[]>;
  getAdminReport(id: string): Promise<AdminReportDetail>;
  createAdminReportSourceUrl(
    reportId: string,
    uploadId: string,
  ): Promise<AdminReportSourceUrlResponse>;
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

export class AdminCorrectionConflictError extends Error {
  constructor(message = "The published calendar changed while this report was open. Reload before correcting it.") {
    super(message);
    this.name = "AdminCorrectionConflictError";
  }
}

export class AdminCorrectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCorrectionValidationError";
  }
}

export class AdminReviewerAuthorizationError extends Error {
  constructor() {
    super("This account is no longer authorized to review calendar reports.");
    this.name = "AdminReviewerAuthorizationError";
  }
}

export class AdminReportSourceNotFoundError extends Error {
  constructor() {
    super("That report source file could not be found.");
    this.name = "AdminReportSourceNotFoundError";
  }
}

export class AdminReportSourceUnavailableError extends Error {
  constructor() {
    super("That private source file is temporarily unavailable.");
    this.name = "AdminReportSourceUnavailableError";
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

function normalizeSubmittedText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function mapSimilarSchool(
  school: typeof schoolTable.$inferSelect,
  yearsBySchool: Map<string, string[]>,
  similarity: number,
): SimilarSchool {
  return {
    ...mapSchool(school, yearsBySchool),
    similarity,
  };
}

function toSimilarityScore(similarity: number) {
  return Math.max(0, Math.min(similarityScoreScale, Math.round(similarity * similarityScoreScale)));
}

function fromSimilarityScore(score: number) {
  return score / similarityScoreScale;
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

type ApplyCorrectionAction = Extract<AdminReportAction, { action: "apply_correction" }>;
type CorrectionEvidence = NonNullable<
  Extract<ApplyCorrectionAction["correction"], { operation: "add_event" }>["evidence"]
>;

type CorrectableEventRow = Pick<
  typeof calendarEvents.$inferSelect,
  | "id"
  | "lineageId"
  | "name"
  | "kind"
  | "startDate"
  | "endDate"
  | "sourceUploadId"
  | "sourcePage"
  | "rawText"
  | "isDerived"
>;

type CorrectablePeriodRow = Pick<
  typeof calendarActivityPeriods.$inferSelect,
  | "id"
  | "lineageId"
  | "name"
  | "startDate"
  | "endDate"
  | "startSourceUploadId"
  | "startSourcePage"
  | "startRawText"
  | "endSourceUploadId"
  | "endSourcePage"
  | "endRawText"
>;

type SourceUploadRow = Pick<
  typeof calendarUploads.$inferSelect,
  "id" | "fileType" | "position" | "storageBucket" | "storagePath" | "originalFilename" | "mimeType" | "byteSize"
>;

function mapAdminEvent(event: CorrectableEventRow): AdminEditableEvent {
  return {
    id: event.id,
    lineageId: event.lineageId,
    name: event.name,
    kind: event.kind,
    startDate: event.startDate,
    endDate: event.endDate,
    sourceUploadId: event.sourceUploadId,
    sourcePage: event.sourcePage,
    rawText: event.rawText,
    isDerived: event.isDerived,
  };
}

function mapAdminPeriod(period: CorrectablePeriodRow): AdminEditableActivityPeriod {
  return {
    id: period.id,
    lineageId: period.lineageId,
    name: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    startSourceUploadId: period.startSourceUploadId,
    startSourcePage: period.startSourcePage,
    startRawText: period.startRawText,
    endSourceUploadId: period.endSourceUploadId,
    endSourcePage: period.endSourcePage,
    endRawText: period.endRawText,
  };
}

function assertCorrectionDateRange(academicYear: string, startDate: string, endDate: string) {
  const window = getAcademicYearDateWindow(academicYear);
  if (endDate < startDate) {
    throw new AdminCorrectionValidationError("The correction end date is before its start date.");
  }
  if (startDate < window.startDate || endDate > window.endDate) {
    throw new AdminCorrectionValidationError(
      `Correction dates must stay between ${window.startDate} and ${window.endDate}.`,
    );
  }
}

function assertNoNaturalKeyDuplicates(
  rows: Array<{ name: string; startDate: string; endDate: string }>,
  label: string,
) {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.name.toLocaleLowerCase("en-US")}\u0000${row.startDate}\u0000${row.endDate}`;
    if (keys.has(key)) {
      throw new AdminCorrectionValidationError(`The corrected calendar contains duplicate ${label}.`);
    }
    keys.add(key);
  }
}

const partialDayEvidencePatterns = [
  /\b(?:noon|midnight|morning|afternoon|evening|half[- ]day)\b/i,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i,
  /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/i,
];

function assertWholeDayCorrection(event: Pick<CorrectableEventRow, "name" | "rawText">) {
  const evidence = `${event.name} ${event.rawText ?? ""}`;
  if (partialDayEvidencePatterns.some((pattern) => pattern.test(evidence))) {
    throw new AdminCorrectionValidationError(
      "Common Days cannot publish a partial-day event as a full day without classes.",
    );
  }
}

function correctionAuditSnapshot(row: CorrectableEventRow | CorrectablePeriodRow) {
  const { id: _physicalVersionRowId, ...snapshot } = row;
  return snapshot as Record<string, unknown>;
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
        eventKind: calendarEvents.kind,
        reason: calendarReports.reason,
        details: calendarReports.details,
        status: calendarReports.status,
        createdAt: calendarReports.createdAt,
        resolutionNotes: calendarReports.resolutionNotes,
        resolutionCalendarId: calendarReports.resolutionCalendarId,
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

  async searchSchools(query: string): Promise<SchoolSearchResult> {
    const trimmedQuery = normalizeSubmittedText(query);
    const normalizedQuery = normalizeSchoolName(trimmedQuery);
    if (trimmedQuery && !normalizedQuery) return { schools: [], similarSchools: [] };
    const rows = trimmedQuery
      ? await this.connection.db
          .select()
          .from(schoolTable)
          .where(
            or(
              ilike(schoolTable.normalizedName, `%${normalizedQuery}%`),
              ilike(schoolTable.shortName, `%${trimmedQuery}%`),
              ilike(schoolTable.location, `%${trimmedQuery}%`),
            ),
          )
          .orderBy(asc(schoolTable.name))
          .limit(schoolSearchResultLimit)
      : await this.connection.db
          .select()
          .from(schoolTable)
          .orderBy(asc(schoolTable.name))
          .limit(schoolSearchResultLimit);

    const yearsBySchool = await this.getPublishedYears(rows.map((school) => school.id));
    if (!trimmedQuery || rows.length > 0) {
      return {
        schools: rows.map((school) => mapSchool(school, yearsBySchool)),
        similarSchools: [],
      };
    }

    const similarity = sql<number>`similarity(${schoolTable.normalizedName}, ${normalizedQuery})`;
    const ranked = await this.connection.db
      .select({ school: schoolTable, similarity })
      .from(schoolTable)
      .where(
        and(
          sql`${schoolTable.normalizedName} % ${normalizedQuery}`,
          sql`${similarity} >= ${SCHOOL_SIMILARITY_THRESHOLD}`,
        ),
      )
      .orderBy(desc(similarity), asc(schoolTable.name))
      .limit(5);
    const similarYears = await this.getPublishedYears(ranked.map((candidate) => candidate.school.id));

    return {
      schools: [],
      similarSchools: ranked.map((candidate) =>
        mapSimilarSchool(candidate.school, similarYears, Number(candidate.similarity))
      ),
    };
  }

  async createSchool(request: SchoolCreateRequest): Promise<CreatedSchoolResult> {
    const name = normalizeSubmittedText(request.name);
    const location = normalizeSubmittedText(request.location);
    const normalizedName = normalizeSchoolName(name);
    const presentation = deriveSchoolPresentation(name);

    const created = await this.connection.db.transaction(async (transaction) => {
      // The permissive policy intentionally allows exact duplicates. The global
      // transaction lock only ensures each concurrent creation sees every school
      // committed before it and can atomically write the appropriate alert.
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('commondays:create-school'))`);

      const similarity = sql<number>`similarity(${schoolTable.normalizedName}, ${normalizedName})`;
      const ranked = await transaction
        .select({ school: schoolTable, similarity })
        .from(schoolTable)
        .where(
          and(
            sql`${schoolTable.normalizedName} % ${normalizedName}`,
            sql`${similarity} >= ${SCHOOL_SIMILARITY_THRESHOLD}`,
          ),
        )
        .orderBy(desc(similarity), asc(schoolTable.name))
        .limit(5);

      const [createdSchool] = await transaction
        .insert(schoolTable)
        .values({
          id: randomUUID(),
          name,
          normalizedName,
          shortName: presentation.shortName,
          location,
          initials: presentation.initials,
          color: presentation.color,
        })
        .returning();
      if (!createdSchool) throw new Error("The school could not be created.");

      let alertId: string | null = null;
      if (ranked.length > 0) {
        const [alert] = await transaction
          .insert(schoolSimilarityAlerts)
          .values({ createdSchoolId: createdSchool.id })
          .returning({ id: schoolSimilarityAlerts.id });
        if (!alert) throw new Error("The school similarity alert could not be created.");
        alertId = alert.id;

        await transaction.insert(schoolSimilarityAlertMatches).values(
          ranked.map((similarSchool) => ({
            alertId: alert.id,
            similarSchoolId: similarSchool.school.id,
            similarityScore: toSimilarityScore(Number(similarSchool.similarity)),
          })),
        );
      }

      return {
        school: createdSchool,
        similarSchools: ranked.map((candidate) => ({
          school: candidate.school,
          similarity: Number(candidate.similarity),
        })),
        alertId,
      };
    });

    const yearsBySchool = await this.getPublishedYears(
      created.similarSchools.map((candidate) => candidate.school.id),
    );
    return {
      school: mapSchool(created.school, new Map()),
      similarSchools: created.similarSchools.map((candidate) =>
        mapSimilarSchool(candidate.school, yearsBySchool, candidate.similarity)
      ),
      alertId: created.alertId,
    };
  }

  async getSchoolSimilarityAlert(id: string): Promise<SchoolSimilarityAlert | null> {
    if (!uuidPattern.test(id)) return null;

    const [alert] = await this.connection.db
      .select({
        id: schoolSimilarityAlerts.id,
        status: schoolSimilarityAlerts.status,
        nextAttemptAt: schoolSimilarityAlerts.nextAttemptAt,
        createdSchoolId: schoolTable.id,
        createdSchoolName: schoolTable.name,
        createdSchoolShortName: schoolTable.shortName,
        createdSchoolLocation: schoolTable.location,
      })
      .from(schoolSimilarityAlerts)
      .innerJoin(schoolTable, eq(schoolTable.id, schoolSimilarityAlerts.createdSchoolId))
      .where(eq(schoolSimilarityAlerts.id, id))
      .limit(1);
    if (!alert) return null;

    const matches = await this.connection.db
      .select({
        id: schoolTable.id,
        name: schoolTable.name,
        shortName: schoolTable.shortName,
        location: schoolTable.location,
        similarityScore: schoolSimilarityAlertMatches.similarityScore,
      })
      .from(schoolSimilarityAlertMatches)
      .innerJoin(schoolTable, eq(schoolTable.id, schoolSimilarityAlertMatches.similarSchoolId))
      .where(eq(schoolSimilarityAlertMatches.alertId, id))
      .orderBy(desc(schoolSimilarityAlertMatches.similarityScore), asc(schoolTable.name));

    return {
      id: alert.id,
      status: alert.status,
      nextAttemptAt: alert.nextAttemptAt.toISOString(),
      createdSchool: {
        id: alert.createdSchoolId,
        name: alert.createdSchoolName,
        shortName: alert.createdSchoolShortName,
        location: alert.createdSchoolLocation,
      },
      similarSchools: matches.map(({ similarityScore, ...school }) => ({
        ...school,
        similarity: fromSimilarityScore(similarityScore),
      })),
    };
  }

  async listQueuedSchoolSimilarityAlerts(limit = 25): Promise<string[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const alerts = await this.connection.db
      .select({ id: schoolSimilarityAlerts.id })
      .from(schoolSimilarityAlerts)
      .where(and(
        eq(schoolSimilarityAlerts.status, "queued"),
        lt(schoolSimilarityAlerts.attemptCount, schoolSimilarityAlertAttemptLimit),
        lte(schoolSimilarityAlerts.nextAttemptAt, new Date()),
      ))
      .orderBy(asc(schoolSimilarityAlerts.createdAt))
      .limit(safeLimit);
    return alerts.map((alert) => alert.id);
  }

  async markSchoolSimilarityAlertSent(id: string, providerMessageId: string): Promise<void> {
    const normalizedProviderMessageId = normalizeSubmittedText(providerMessageId).slice(0, 500);
    if (!uuidPattern.test(id) || !normalizedProviderMessageId) return;

    const now = new Date();
    await this.connection.db
      .update(schoolSimilarityAlerts)
      .set({
        status: "sent",
        attemptCount: sql`${schoolSimilarityAlerts.attemptCount} + 1`,
        lastError: null,
        providerMessageId: normalizedProviderMessageId,
        sentAt: now,
        updatedAt: now,
      })
      .where(and(eq(schoolSimilarityAlerts.id, id), eq(schoolSimilarityAlerts.status, "queued")));
  }

  async recordSchoolSimilarityAlertFailure(id: string, error: string): Promise<void> {
    if (!uuidPattern.test(id)) return;
    const safeError = normalizeSubmittedText(error).slice(0, 1_000) || "The similarity alert could not be sent.";

    await this.connection.db
      .update(schoolSimilarityAlerts)
      .set({
        attemptCount: sql`${schoolSimilarityAlerts.attemptCount} + 1`,
        lastError: safeError,
        nextAttemptAt: sql`now() + make_interval(secs => least(86400, 300 * power(2, ${schoolSimilarityAlerts.attemptCount}))::integer)`,
        updatedAt: new Date(),
      })
      .where(and(eq(schoolSimilarityAlerts.id, id), eq(schoolSimilarityAlerts.status, "queued")));
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
      .select({
        id: academicCalendars.id,
        schoolId: academicCalendars.schoolId,
        availabilityDerivationVersion: academicCalendars.availabilityDerivationVersion,
      })
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
    const derivationVersionByCalendar = new Map(
      calendarRows.map((calendar) => [calendar.id, calendar.availabilityDerivationVersion]),
    );
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
      events: eventRows
        .filter((event) => event.kind !== "term_boundary" || (
          event.isDerived && derivationVersionByCalendar.get(event.calendarId) === 1
        ))
        .map((event) => ({
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

        await transaction.insert(calendarExtractionJobs).values({
          calendarId: createdCalendar.id,
          status: "staging",
        });

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
      commitUploadsAndQueue: async (uploads) => {
        if (uploads.length === 0) return;
        await this.connection.db.transaction(async (transaction) => {
          await transaction.insert(calendarUploads).values(uploads);
          const queued = await transaction
            .update(calendarExtractionJobs)
            .set({ status: "queued", updatedAt: new Date() })
            .where(
              and(
                eq(calendarExtractionJobs.calendarId, uploads[0].calendarId),
                eq(calendarExtractionJobs.status, "staging"),
              ),
            )
            .returning({ calendarId: calendarExtractionJobs.calendarId });
          if (queued.length !== 1) throw new Error("The calendar extraction job could not be queued.");
        });
      },
      markFailed: (calendarId) =>
        this.failCalendarExtraction(calendarId, "The calendar source upload did not complete."),
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

  async claimCalendarExtraction(calendarId: string): Promise<CalendarExtractionClaim | null> {
    if (!uuidPattern.test(calendarId)) return null;

    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    return this.connection.db.transaction(async (transaction) => {
      const [claimed] = await transaction
        .update(calendarExtractionJobs)
        .set({
          status: "processing",
          leaseToken,
          leaseExpiresAt,
          attemptCount: sql`${calendarExtractionJobs.attemptCount} + 1`,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(calendarExtractionJobs.calendarId, calendarId),
            or(
              eq(calendarExtractionJobs.status, "queued"),
              and(
                eq(calendarExtractionJobs.status, "processing"),
                lt(calendarExtractionJobs.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .returning({ calendarId: calendarExtractionJobs.calendarId });
      if (!claimed) return null;

      await transaction
        .update(calendarUploads)
        .set({ status: "processing", updatedAt: now })
        .where(eq(calendarUploads.calendarId, calendarId));

      return { calendarId, leaseToken };
    });
  }

  async getCalendarExtractionInput(claim: CalendarExtractionClaim): Promise<CalendarExtractionInput> {
    if (!this.storage || !uuidPattern.test(claim.calendarId) || !uuidPattern.test(claim.leaseToken)) {
      throw new Error("The calendar extraction claim is invalid or Storage is unavailable.");
    }

    const [calendar] = await this.connection.db
      .select({
        calendarId: academicCalendars.id,
        schoolId: academicCalendars.schoolId,
        schoolName: schoolTable.name,
        academicYear: academicCalendars.academicYear,
      })
      .from(calendarExtractionJobs)
      .innerJoin(academicCalendars, eq(academicCalendars.id, calendarExtractionJobs.calendarId))
      .innerJoin(schoolTable, eq(schoolTable.id, academicCalendars.schoolId))
      .where(
        and(
          eq(calendarExtractionJobs.calendarId, claim.calendarId),
          eq(calendarExtractionJobs.status, "processing"),
          eq(calendarExtractionJobs.leaseToken, claim.leaseToken),
          eq(academicCalendars.status, "processing"),
        ),
      )
      .limit(1);
    if (!calendar) throw new Error("The calendar extraction claim is no longer active.");

    const uploads = await this.connection.db
      .select({
        uploadId: calendarUploads.id,
        position: calendarUploads.position,
        storageBucket: calendarUploads.storageBucket,
        storagePath: calendarUploads.storagePath,
        originalFilename: calendarUploads.originalFilename,
        mimeType: calendarUploads.mimeType,
        byteSize: calendarUploads.byteSize,
        sha256: calendarUploads.sha256,
      })
      .from(calendarUploads)
      .where(eq(calendarUploads.calendarId, claim.calendarId))
      .orderBy(asc(calendarUploads.position));
    if (uploads.length === 0) throw new Error("The calendar extraction has no source files.");

    const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    const files = await Promise.all(uploads.map(async (upload) => {
      if (upload.storageBucket !== this.storage!.bucket || !supportedMimeTypes.has(upload.mimeType)) {
        throw new Error("The calendar source metadata is invalid.");
      }
      const content = await this.storage!.download(upload.storagePath);
      const digest = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== upload.byteSize || !upload.sha256 || digest !== upload.sha256) {
        throw new Error("A stored calendar source failed its integrity check.");
      }
      return {
        uploadId: upload.uploadId,
        position: upload.position,
        originalFilename: upload.originalFilename,
        mimeType: upload.mimeType as CalendarExtractionInput["files"][number]["mimeType"],
        content,
      };
    }));

    return { ...calendar, files };
  }

  async publishCalendarExtraction(
    claim: CalendarExtractionClaim,
    model: string,
    periods: PublishableCalendarActivityPeriod[],
    events: PublishableCalendarEvent[],
    resultHash: string,
  ): Promise<void> {
    const normalizedModel = model.trim();
    if (
      !uuidPattern.test(claim.calendarId) ||
      !uuidPattern.test(claim.leaseToken) ||
      !normalizedModel ||
      periods.length === 0 ||
      periods.some((period) =>
        !uuidPattern.test(period.startSourceUploadId) || !uuidPattern.test(period.endSourceUploadId)
      ) ||
      events.some((event) => event.isDerived
        ? event.kind !== "term_boundary" || event.sourceUploadId !== null
        : event.kind === "term_boundary" || !event.sourceUploadId || !uuidPattern.test(event.sourceUploadId)) ||
      !/^[0-9a-f]{64}$/.test(resultHash)
    ) {
      throw new Error("The calendar extraction publication payload is invalid.");
    }

    const now = new Date();
    await this.connection.db.transaction(async (transaction) => {
      const [lockedJob] = await transaction
        .update(calendarExtractionJobs)
        .set({ updatedAt: now })
        .where(
          and(
            eq(calendarExtractionJobs.calendarId, claim.calendarId),
            eq(calendarExtractionJobs.status, "processing"),
            eq(calendarExtractionJobs.leaseToken, claim.leaseToken),
          ),
        )
        .returning({ calendarId: calendarExtractionJobs.calendarId });

      if (!lockedJob) {
        const [existing] = await transaction
          .select({ status: calendarExtractionJobs.status, resultHash: calendarExtractionJobs.resultHash })
          .from(calendarExtractionJobs)
          .where(eq(calendarExtractionJobs.calendarId, claim.calendarId))
          .limit(1);
        if (existing?.status === "completed" && existing.resultHash === resultHash) return;
        throw new Error("The calendar extraction claim was lost before publication.");
      }

      const [calendar] = await transaction
        .select({ id: academicCalendars.id })
        .from(academicCalendars)
        .where(and(eq(academicCalendars.id, claim.calendarId), eq(academicCalendars.status, "processing")))
        .limit(1);
      if (!calendar) throw new Error("The calendar is no longer eligible for publication.");

      const sourceUploadIds = [...new Set([
        ...periods.flatMap((period) => [period.startSourceUploadId, period.endSourceUploadId]),
        ...events.flatMap((event) => event.sourceUploadId ? [event.sourceUploadId] : []),
      ])];
      const ownedUploads = await transaction
        .select({ id: calendarUploads.id })
        .from(calendarUploads)
        .where(
          and(
            eq(calendarUploads.calendarId, claim.calendarId),
            inArray(calendarUploads.id, sourceUploadIds),
          ),
        );
      if (ownedUploads.length !== sourceUploadIds.length) {
        throw new Error("An extraction cites a source from another calendar.");
      }

      await transaction.insert(calendarActivityPeriods).values(
        periods.map((period) => ({
          calendarId: claim.calendarId,
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate,
          startSourceUploadId: period.startSourceUploadId,
          startSourcePage: period.startSourcePage,
          startRawText: period.startRawText,
          endSourceUploadId: period.endSourceUploadId,
          endSourcePage: period.endSourcePage,
          endRawText: period.endRawText,
        })),
      );
      if (events.length > 0) {
        await transaction.insert(calendarEvents).values(events.map((event) => ({
          calendarId: claim.calendarId,
          name: event.name,
          kind: event.kind,
          startDate: event.startDate,
          endDate: event.endDate,
          sourceUploadId: event.sourceUploadId,
          sourcePage: event.sourcePage,
          rawText: event.rawText,
          isDerived: event.isDerived,
        })));
      }
      await transaction
        .update(calendarUploads)
        .set({ status: "processed", updatedAt: now })
        .where(eq(calendarUploads.calendarId, claim.calendarId));
      const published = await transaction
        .update(academicCalendars)
        .set({
          status: "published",
          availabilityDerivationVersion: 1,
          extractionModel: normalizedModel,
          publishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(academicCalendars.id, claim.calendarId), eq(academicCalendars.status, "processing")))
        .returning({ id: academicCalendars.id });
      if (published.length !== 1) throw new Error("The calendar could not be published atomically.");

      const completed = await transaction
        .update(calendarExtractionJobs)
        .set({
          status: "completed",
          resultHash,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(calendarExtractionJobs.calendarId, claim.calendarId),
            eq(calendarExtractionJobs.status, "processing"),
            eq(calendarExtractionJobs.leaseToken, claim.leaseToken),
          ),
        )
        .returning({ calendarId: calendarExtractionJobs.calendarId });
      if (completed.length !== 1) throw new Error("The extraction job could not be completed atomically.");
    });
  }

  async failCalendarExtraction(calendarId: string, errorMessage: string): Promise<void> {
    if (!uuidPattern.test(calendarId)) return;
    const now = new Date();
    const safeMessage = errorMessage.trim().slice(0, 500) || "Calendar extraction failed.";

    await this.connection.db.transaction(async (transaction) => {
      const failed = await transaction
        .update(calendarExtractionJobs)
        .set({
          status: "failed",
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: safeMessage,
          updatedAt: now,
        })
        .where(
          and(
            eq(calendarExtractionJobs.calendarId, calendarId),
            inArray(calendarExtractionJobs.status, ["staging", "queued", "processing"]),
          ),
        )
        .returning({ calendarId: calendarExtractionJobs.calendarId });
      if (failed.length === 0) return;

      await transaction
        .update(academicCalendars)
        .set({ status: "failed", updatedAt: now })
        .where(and(eq(academicCalendars.id, calendarId), eq(academicCalendars.status, "processing")));
      await transaction
        .update(calendarUploads)
        .set({ status: "failed", updatedAt: now })
        .where(eq(calendarUploads.calendarId, calendarId));
    });
  }

  async listQueuedCalendarExtractions(limit = 25): Promise<string[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const now = new Date();
    const staleStagingBefore = new Date(now.getTime() - 15 * 60 * 1000);

    return this.connection.db.transaction(async (transaction) => {
      const staleStaging = await transaction
        .update(calendarExtractionJobs)
        .set({
          status: "failed",
          lastError: "The source upload did not finish before the staging timeout.",
          updatedAt: now,
        })
        .where(
          and(
            eq(calendarExtractionJobs.status, "staging"),
            lt(calendarExtractionJobs.createdAt, staleStagingBefore),
          ),
        )
        .returning({ calendarId: calendarExtractionJobs.calendarId });
      const staleCalendarIds = staleStaging.map((job) => job.calendarId);
      if (staleCalendarIds.length > 0) {
        await transaction
          .update(academicCalendars)
          .set({ status: "failed", updatedAt: now })
          .where(
            and(
              inArray(academicCalendars.id, staleCalendarIds),
              eq(academicCalendars.status, "processing"),
            ),
          );
      }

      const queued = await transaction
        .select({ calendarId: calendarExtractionJobs.calendarId })
        .from(calendarExtractionJobs)
        .where(
          or(
            eq(calendarExtractionJobs.status, "queued"),
            and(
              eq(calendarExtractionJobs.status, "processing"),
              lt(calendarExtractionJobs.leaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(asc(calendarExtractionJobs.createdAt))
        .limit(safeLimit);
      return queued.map((job) => job.calendarId);
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

  async getAdminReport(id: string): Promise<AdminReportDetail> {
    if (!uuidPattern.test(id)) throw new AdminReportNotFoundError();
    const [report] = await this.selectAdminReports({ id });
    if (!report) throw new AdminReportNotFoundError();
    const [reported] = await this.connection.db
      .select({
        id: academicCalendars.id,
        version: academicCalendars.version,
        schoolId: academicCalendars.schoolId,
        academicYear: academicCalendars.academicYear,
        reportedEventLineageId: calendarEvents.lineageId,
      })
      .from(academicCalendars)
      .leftJoin(calendarEvents, eq(calendarEvents.id, report.eventId ?? "00000000-0000-0000-0000-000000000000"))
      .where(eq(academicCalendars.id, report.calendarId))
      .limit(1);
    if (!reported) throw new AdminReportNotFoundError();

    const [current] = await this.connection.db
      .select({
        id: academicCalendars.id,
        version: academicCalendars.version,
        sourceCalendarId: academicCalendars.sourceCalendarId,
      })
      .from(academicCalendars)
      .where(and(
        eq(academicCalendars.schoolId, reported.schoolId),
        eq(academicCalendars.academicYear, reported.academicYear),
        eq(academicCalendars.status, "published"),
      ))
      .limit(1);
    if (!current) throw new AdminCorrectionConflictError("This school year has no current published calendar.");

    const currentEventRows = await this.connection.db
      .select({
        id: calendarEvents.id,
        lineageId: calendarEvents.lineageId,
        name: calendarEvents.name,
        kind: calendarEvents.kind,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        sourceUploadId: calendarEvents.sourceUploadId,
        sourcePage: calendarEvents.sourcePage,
        rawText: calendarEvents.rawText,
        isDerived: calendarEvents.isDerived,
      })
      .from(calendarEvents)
      .where(eq(calendarEvents.calendarId, current.id))
      .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.name));
    const periodRows = await this.connection.db
      .select({
        id: calendarActivityPeriods.id,
        lineageId: calendarActivityPeriods.lineageId,
        name: calendarActivityPeriods.name,
        startDate: calendarActivityPeriods.startDate,
        endDate: calendarActivityPeriods.endDate,
        startSourceUploadId: calendarActivityPeriods.startSourceUploadId,
        startSourcePage: calendarActivityPeriods.startSourcePage,
        startRawText: calendarActivityPeriods.startRawText,
        endSourceUploadId: calendarActivityPeriods.endSourceUploadId,
        endSourcePage: calendarActivityPeriods.endSourcePage,
        endRawText: calendarActivityPeriods.endRawText,
      })
      .from(calendarActivityPeriods)
      .where(eq(calendarActivityPeriods.calendarId, current.id))
      .orderBy(asc(calendarActivityPeriods.startDate), asc(calendarActivityPeriods.name));

    const sourceCalendarId = current.sourceCalendarId ?? current.id;
    const [sourceCalendar] = await this.connection.db
      .select({ schoolId: academicCalendars.schoolId, academicYear: academicCalendars.academicYear })
      .from(academicCalendars)
      .where(eq(academicCalendars.id, sourceCalendarId))
      .limit(1);
    if (
      !sourceCalendar ||
      sourceCalendar.schoolId !== reported.schoolId ||
      sourceCalendar.academicYear !== reported.academicYear
    ) {
      throw new AdminReportSourceUnavailableError();
    }
    const sources = await this.connection.db
      .select({
        id: calendarUploads.id,
        fileType: calendarUploads.fileType,
        position: calendarUploads.position,
        originalFilename: calendarUploads.originalFilename,
        mimeType: calendarUploads.mimeType,
        byteSize: calendarUploads.byteSize,
      })
      .from(calendarUploads)
      .where(eq(calendarUploads.calendarId, sourceCalendarId))
      .orderBy(asc(calendarUploads.position));

    const currentEvent = reported.reportedEventLineageId
      ? currentEventRows.find((event) => event.lineageId === reported.reportedEventLineageId) ?? null
      : null;
    return {
      ...report,
      reportedCalendar: { id: reported.id, version: reported.version },
      currentCalendar: { id: current.id, version: current.version },
      currentEvent: currentEvent ? mapAdminEvent(currentEvent) : null,
      currentEvents: currentEventRows.filter((event) => !event.isDerived).map(mapAdminEvent),
      currentPeriods: periodRows.map(mapAdminPeriod),
      sourceFiles: sources,
    };
  }

  async createAdminReportSourceUrl(
    reportId: string,
    uploadId: string,
  ): Promise<AdminReportSourceUrlResponse> {
    if (!uuidPattern.test(reportId) || !uuidPattern.test(uploadId)) {
      throw new AdminReportSourceNotFoundError();
    }
    if (!this.storage) throw new UploadStorageNotConfiguredError();

    const [source] = await this.connection.db
      .select({
        storageBucket: calendarUploads.storageBucket,
        storagePath: calendarUploads.storagePath,
        sourceCalendarId: calendarUploads.calendarId,
        reportedSchoolId: academicCalendars.schoolId,
        reportedAcademicYear: academicCalendars.academicYear,
      })
      .from(calendarReports)
      .innerJoin(
        academicCalendars,
        eq(academicCalendars.id, calendarReports.calendarId),
      )
      .innerJoin(
        calendarUploads,
        and(
          eq(calendarUploads.id, uploadId),
          sql`${calendarUploads.calendarId} = coalesce(${academicCalendars.sourceCalendarId}, ${academicCalendars.id})`,
        ),
      )
      .where(eq(calendarReports.id, reportId))
      .limit(1);
    if (!source) throw new AdminReportSourceNotFoundError();
    const [sourceCalendar] = await this.connection.db
      .select({ schoolId: academicCalendars.schoolId, academicYear: academicCalendars.academicYear })
      .from(academicCalendars)
      .where(eq(academicCalendars.id, source.sourceCalendarId))
      .limit(1);
    if (
      !sourceCalendar ||
      sourceCalendar.schoolId !== source.reportedSchoolId ||
      sourceCalendar.academicYear !== source.reportedAcademicYear
    ) {
      throw new AdminReportSourceNotFoundError();
    }
    if (source.storageBucket !== this.storage.bucket) throw new AdminReportSourceUnavailableError();

    const expiresInSeconds = 300;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    try {
      return {
        url: await this.storage.createSignedUrl(source.storagePath, expiresInSeconds),
        expiresAt,
      };
    } catch {
      throw new AdminReportSourceUnavailableError();
    }
  }

  private async applyAdminCorrection(
    id: string,
    action: ApplyCorrectionAction,
    reviewerId: string,
  ): Promise<AdminReport> {
    if (!uuidPattern.test(id)) throw new AdminReportNotFoundError();
    if (!uuidPattern.test(reviewerId)) throw new AdminReviewerAuthorizationError();

    return this.connection.db.transaction(async (transaction) => {
      const adminRows = await transaction.execute<{ isAdmin: boolean }>(sql`
        select exists (
          select 1
          from private.app_admin
          where user_id = ${reviewerId}::uuid
        ) as "isAdmin"
      `);
      if (adminRows[0]?.isAdmin !== true) throw new AdminReviewerAuthorizationError();

      // Lock operation ids before report ids in every correction transaction.
      // This makes both same-report retries and cross-report operation-id reuse
      // deterministic instead of leaking a unique-constraint failure.
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${action.operationId}))`);
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      const [completedOperation] = await transaction
        .select({ reportId: calendarCorrections.reportId })
        .from(calendarCorrections)
        .where(eq(calendarCorrections.operationId, action.operationId))
        .limit(1);
      if (completedOperation) {
        if (completedOperation.reportId !== id) {
          throw new AdminCorrectionConflictError("That correction operation was already used for another report.");
        }
        const [completedReport] = await this.selectAdminReports({ id }, transaction);
        if (!completedReport) throw new AdminReportNotFoundError();
        return completedReport;
      }

      const [reportRow] = await transaction
        .select({
          id: calendarReports.id,
          calendarId: calendarReports.calendarId,
          status: calendarReports.status,
        })
        .from(calendarReports)
        .where(eq(calendarReports.id, id))
        .limit(1)
        .for("update");
      if (!reportRow) throw new AdminReportNotFoundError();
      if (reportRow.status !== "reviewing") throw new AdminReportTransitionError();

      const [reportedCalendar] = await transaction
        .select({
          schoolId: academicCalendars.schoolId,
          academicYear: academicCalendars.academicYear,
        })
        .from(academicCalendars)
        .where(eq(academicCalendars.id, reportRow.calendarId))
        .limit(1);
      if (!reportedCalendar) throw new AdminReportNotFoundError();

      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtext(${`${reportedCalendar.schoolId}:${reportedCalendar.academicYear}`})
        )
      `);
      const [currentCalendar] = await transaction
        .select({
          id: academicCalendars.id,
          schoolId: academicCalendars.schoolId,
          academicYear: academicCalendars.academicYear,
          sourceCalendarId: academicCalendars.sourceCalendarId,
          version: academicCalendars.version,
          sourceType: academicCalendars.sourceType,
          officialSourceUrl: academicCalendars.officialSourceUrl,
          submittedBy: academicCalendars.submittedBy,
          availabilityDerivationVersion: academicCalendars.availabilityDerivationVersion,
          extractionModel: academicCalendars.extractionModel,
        })
        .from(academicCalendars)
        .where(and(
          eq(academicCalendars.schoolId, reportedCalendar.schoolId),
          eq(academicCalendars.academicYear, reportedCalendar.academicYear),
          eq(academicCalendars.status, "published"),
        ))
        .limit(1)
        .for("update");
      if (!currentCalendar) {
        throw new AdminCorrectionConflictError("This school year has no current published calendar.");
      }
      if (
        currentCalendar.id !== action.expectedCalendarId ||
        currentCalendar.version !== action.expectedCalendarVersion
      ) {
        throw new AdminCorrectionConflictError();
      }

      const sourceCalendarId = currentCalendar.sourceCalendarId ?? currentCalendar.id;
      const [sourceCalendar] = await transaction
        .select({ schoolId: academicCalendars.schoolId, academicYear: academicCalendars.academicYear })
        .from(academicCalendars)
        .where(eq(academicCalendars.id, sourceCalendarId))
        .limit(1);
      if (
        !sourceCalendar ||
        sourceCalendar.schoolId !== currentCalendar.schoolId ||
        sourceCalendar.academicYear !== currentCalendar.academicYear
      ) {
        throw new AdminCorrectionValidationError("The published calendar has invalid source lineage.");
      }

      const sourceUploads: SourceUploadRow[] = await transaction
        .select({
          id: calendarUploads.id,
          fileType: calendarUploads.fileType,
          position: calendarUploads.position,
          storageBucket: calendarUploads.storageBucket,
          storagePath: calendarUploads.storagePath,
          originalFilename: calendarUploads.originalFilename,
          mimeType: calendarUploads.mimeType,
          byteSize: calendarUploads.byteSize,
        })
        .from(calendarUploads)
        .where(eq(calendarUploads.calendarId, sourceCalendarId))
        .orderBy(asc(calendarUploads.position));
      const sourceUploadById = new Map(sourceUploads.map((upload) => [upload.id, upload]));
      const resolveEvidence = (evidence: CorrectionEvidence) => {
        const upload = sourceUploadById.get(evidence.uploadId);
        if (!upload || !uuidPattern.test(evidence.uploadId)) {
          throw new AdminCorrectionValidationError("Correction evidence must use a source from this school year.");
        }
        if (upload.mimeType === "application/pdf") {
          if (evidence.sourcePage === null || evidence.sourcePage > 1_000) {
            throw new AdminCorrectionValidationError("PDF correction evidence needs a valid page number.");
          }
        } else if (evidence.sourcePage !== null) {
          throw new AdminCorrectionValidationError("Screenshot correction evidence cannot use a PDF page number.");
        }
        return {
          sourceUploadId: upload.id,
          sourcePage: upload.mimeType === "application/pdf" ? evidence.sourcePage : null,
          rawText: normalizeSubmittedText(evidence.rawText),
        };
      };

      let explicitEvents: CorrectableEventRow[] = await transaction
        .select({
          id: calendarEvents.id,
          lineageId: calendarEvents.lineageId,
          name: calendarEvents.name,
          kind: calendarEvents.kind,
          startDate: calendarEvents.startDate,
          endDate: calendarEvents.endDate,
          sourceUploadId: calendarEvents.sourceUploadId,
          sourcePage: calendarEvents.sourcePage,
          rawText: calendarEvents.rawText,
          isDerived: calendarEvents.isDerived,
        })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.calendarId, currentCalendar.id), eq(calendarEvents.isDerived, false)))
        .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.name));
      let periods: CorrectablePeriodRow[] = await transaction
        .select({
          id: calendarActivityPeriods.id,
          lineageId: calendarActivityPeriods.lineageId,
          name: calendarActivityPeriods.name,
          startDate: calendarActivityPeriods.startDate,
          endDate: calendarActivityPeriods.endDate,
          startSourceUploadId: calendarActivityPeriods.startSourceUploadId,
          startSourcePage: calendarActivityPeriods.startSourcePage,
          startRawText: calendarActivityPeriods.startRawText,
          endSourceUploadId: calendarActivityPeriods.endSourceUploadId,
          endSourcePage: calendarActivityPeriods.endSourcePage,
          endRawText: calendarActivityPeriods.endRawText,
        })
        .from(calendarActivityPeriods)
        .where(eq(calendarActivityPeriods.calendarId, currentCalendar.id))
        .orderBy(asc(calendarActivityPeriods.startDate), asc(calendarActivityPeriods.name));

      const correction = action.correction;
      let targetLineageId: string;
      let beforeSnapshot: Record<string, unknown> | null = null;
      let afterSnapshot: Record<string, unknown> | null = null;

      if (correction.operation === "add_event") {
        targetLineageId = randomUUID();
        const evidence = resolveEvidence(correction.evidence);
        const added: CorrectableEventRow = {
          id: randomUUID(),
          lineageId: targetLineageId,
          name: normalizeSubmittedText(correction.name),
          kind: correction.kind,
          startDate: correction.startDate,
          endDate: correction.endDate,
          ...evidence,
          isDerived: false,
        };
        assertWholeDayCorrection(added);
        explicitEvents = [...explicitEvents, added];
        afterSnapshot = correctionAuditSnapshot(added);
      } else if (correction.operation === "update_event" || correction.operation === "delete_event") {
        if (!uuidPattern.test(correction.targetLineageId)) {
          throw new AdminCorrectionValidationError("The event being corrected is invalid.");
        }
        targetLineageId = correction.targetLineageId;
        const index = explicitEvents.findIndex((event) => event.lineageId === targetLineageId);
        if (index < 0) {
          throw new AdminCorrectionValidationError(
            "That event is not an editable event in the current calendar. Correct an activity period instead for derived gaps.",
          );
        }
        const existing = explicitEvents[index]!;
        beforeSnapshot = correctionAuditSnapshot(existing);
        if (correction.operation === "delete_event") {
          explicitEvents = explicitEvents.filter((_, eventIndex) => eventIndex !== index);
        } else {
          const normalizedName = normalizeSubmittedText(correction.name);
          const changed = normalizedName !== existing.name ||
            correction.kind !== existing.kind ||
            correction.startDate !== existing.startDate ||
            correction.endDate !== existing.endDate;
          if (changed && !correction.evidence) {
            throw new AdminCorrectionValidationError(
              "A changed event needs source evidence from this calendar.",
            );
          }
          const evidence = correction.evidence ? resolveEvidence(correction.evidence) : {
            sourceUploadId: existing.sourceUploadId,
            sourcePage: existing.sourcePage,
            rawText: existing.rawText,
          };
          const updated: CorrectableEventRow = {
            ...existing,
            name: normalizedName,
            kind: correction.kind,
            startDate: correction.startDate,
            endDate: correction.endDate,
            ...evidence,
          };
          assertWholeDayCorrection(updated);
          explicitEvents = explicitEvents.map((event, eventIndex) => eventIndex === index ? updated : event);
          afterSnapshot = correctionAuditSnapshot(updated);
        }
      } else if (correction.operation === "add_period") {
        targetLineageId = randomUUID();
        const startEvidence = resolveEvidence(correction.startEvidence);
        const endEvidence = resolveEvidence(correction.endEvidence);
        const added: CorrectablePeriodRow = {
          id: randomUUID(),
          lineageId: targetLineageId,
          name: normalizeSubmittedText(correction.name),
          startDate: correction.startDate,
          endDate: correction.endDate,
          startSourceUploadId: startEvidence.sourceUploadId,
          startSourcePage: startEvidence.sourcePage,
          startRawText: startEvidence.rawText,
          endSourceUploadId: endEvidence.sourceUploadId,
          endSourcePage: endEvidence.sourcePage,
          endRawText: endEvidence.rawText,
        };
        periods = [...periods, added];
        afterSnapshot = correctionAuditSnapshot(added);
      } else {
        if (!uuidPattern.test(correction.targetLineageId)) {
          throw new AdminCorrectionValidationError("The activity period being corrected is invalid.");
        }
        targetLineageId = correction.targetLineageId;
        const index = periods.findIndex((period) => period.lineageId === targetLineageId);
        if (index < 0) {
          throw new AdminCorrectionValidationError("That activity period is not in the current calendar.");
        }
        const existing = periods[index]!;
        beforeSnapshot = correctionAuditSnapshot(existing);
        if (correction.operation === "delete_period") {
          periods = periods.filter((_, periodIndex) => periodIndex !== index);
        } else {
          const normalizedName = normalizeSubmittedText(correction.name);
          const nameChanged = normalizedName !== existing.name;
          if (!correction.startEvidence && (nameChanged || correction.startDate !== existing.startDate)) {
            throw new AdminCorrectionValidationError(
              "A changed activity-period start needs source evidence from this calendar.",
            );
          }
          if (!correction.endEvidence && (nameChanged || correction.endDate !== existing.endDate)) {
            throw new AdminCorrectionValidationError(
              "A changed activity-period end needs source evidence from this calendar.",
            );
          }
          const startEvidence = correction.startEvidence
            ? resolveEvidence(correction.startEvidence)
            : {
                sourceUploadId: existing.startSourceUploadId,
                sourcePage: existing.startSourcePage,
                rawText: existing.startRawText,
              };
          const endEvidence = correction.endEvidence
            ? resolveEvidence(correction.endEvidence)
            : {
                sourceUploadId: existing.endSourceUploadId,
                sourcePage: existing.endSourcePage,
                rawText: existing.endRawText,
              };
          const updated: CorrectablePeriodRow = {
            ...existing,
            name: normalizedName,
            startDate: correction.startDate,
            endDate: correction.endDate,
            startSourceUploadId: startEvidence.sourceUploadId,
            startSourcePage: startEvidence.sourcePage,
            startRawText: startEvidence.rawText,
            endSourceUploadId: endEvidence.sourceUploadId,
            endSourcePage: endEvidence.sourcePage,
            endRawText: endEvidence.rawText,
          };
          periods = periods.map((period, periodIndex) => periodIndex === index ? updated : period);
          afterSnapshot = correctionAuditSnapshot(updated);
        }
      }

      if (periods.length === 0) {
        throw new AdminCorrectionValidationError("A published calendar must keep at least one activity period.");
      }
      for (const event of explicitEvents) {
        assertCorrectionDateRange(currentCalendar.academicYear, event.startDate, event.endDate);
      }
      for (const period of periods) {
        assertCorrectionDateRange(currentCalendar.academicYear, period.startDate, period.endDate);
      }
      assertNoNaturalKeyDuplicates(explicitEvents, "events");
      assertNoNaturalKeyDuplicates(periods, "activity periods");

      const derivedEvents = deriveInternalCalendarGaps(periods.map((period) => ({
        name: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        startSourceUploadId: period.startSourceUploadId ?? "",
        startSourcePage: period.startSourcePage,
        startRawText: period.startRawText,
        endSourceUploadId: period.endSourceUploadId ?? "",
        endSourcePage: period.endSourcePage,
        endRawText: period.endRawText,
      })));
      assertNoNaturalKeyDuplicates([...explicitEvents, ...derivedEvents], "events");

      const [versionRow] = await transaction
        .select({ value: sql<number>`coalesce(max(${academicCalendars.version}), 0)` })
        .from(academicCalendars)
        .where(and(
          eq(academicCalendars.schoolId, currentCalendar.schoolId),
          eq(academicCalendars.academicYear, currentCalendar.academicYear),
        ));
      const nextVersion = Number(versionRow?.value ?? 0) + 1;
      const nextCalendarId = randomUUID();
      const now = new Date();
      await transaction.insert(academicCalendars).values({
        id: nextCalendarId,
        schoolId: currentCalendar.schoolId,
        academicYear: currentCalendar.academicYear,
        sourceCalendarId,
        version: nextVersion,
        status: "superseded",
        sourceType: currentCalendar.sourceType,
        officialSourceUrl: currentCalendar.officialSourceUrl,
        submittedBy: currentCalendar.submittedBy,
        availabilityDerivationVersion: 1,
        extractionModel: currentCalendar.extractionModel,
        publishedAt: now,
        updatedAt: now,
      });

      await transaction.insert(calendarActivityPeriods).values(periods.map((period) => ({
        id: randomUUID(),
        lineageId: period.lineageId,
        calendarId: nextCalendarId,
        name: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        startSourceUploadId: period.startSourceUploadId,
        startSourcePage: period.startSourcePage,
        startRawText: period.startRawText,
        endSourceUploadId: period.endSourceUploadId,
        endSourcePage: period.endSourcePage,
        endRawText: period.endRawText,
        updatedAt: now,
      })));
      if (explicitEvents.length > 0) {
        await transaction.insert(calendarEvents).values(explicitEvents.map((event) => ({
          id: randomUUID(),
          lineageId: event.lineageId,
          calendarId: nextCalendarId,
          name: event.name,
          kind: event.kind,
          startDate: event.startDate,
          endDate: event.endDate,
          sourceUploadId: event.sourceUploadId,
          sourcePage: event.sourcePage,
          rawText: event.rawText,
          isDerived: false,
          updatedAt: now,
        })));
      }
      if (derivedEvents.length > 0) {
        await transaction.insert(calendarEvents).values(derivedEvents.map((event) => ({
          id: randomUUID(),
          calendarId: nextCalendarId,
          ...event,
          updatedAt: now,
        })));
      }

      const superseded = await transaction
        .update(academicCalendars)
        .set({ status: "superseded", updatedAt: now })
        .where(and(eq(academicCalendars.id, currentCalendar.id), eq(academicCalendars.status, "published")))
        .returning({ id: academicCalendars.id });
      if (superseded.length !== 1) throw new AdminCorrectionConflictError();
      const published = await transaction
        .update(academicCalendars)
        .set({ status: "published", publishedAt: now, updatedAt: now })
        .where(and(eq(academicCalendars.id, nextCalendarId), eq(academicCalendars.status, "superseded")))
        .returning({ id: academicCalendars.id });
      if (published.length !== 1) throw new AdminCorrectionConflictError();

      const resolved = await transaction
        .update(calendarReports)
        .set({
          status: "resolved",
          reviewedBy: reviewerId,
          resolutionNotes: action.resolutionNotes,
          resolutionCalendarId: nextCalendarId,
          resolvedAt: now,
        })
        .where(and(eq(calendarReports.id, id), eq(calendarReports.status, "reviewing")))
        .returning({ id: calendarReports.id });
      if (resolved.length !== 1) throw new AdminReportTransitionError();

      await transaction.insert(calendarCorrections).values({
        operationId: action.operationId,
        reportId: id,
        fromCalendarId: currentCalendar.id,
        toCalendarId: nextCalendarId,
        operation: correction.operation,
        targetLineageId,
        beforeSnapshot,
        afterSnapshot,
        reviewedBy: reviewerId,
      });

      const [report] = await this.selectAdminReports({ id }, transaction);
      if (!report) throw new AdminReportNotFoundError();
      return report;
    });
  }

  async updateAdminReport(
    id: string,
    action: AdminReportAction,
    reviewerId: string,
  ): Promise<AdminReport> {
    if (!uuidPattern.test(id)) throw new AdminReportNotFoundError();
    if (!uuidPattern.test(reviewerId)) throw new AdminReportTransitionError();
    if (action.action === "apply_correction") {
      return this.applyAdminCorrection(id, action, reviewerId);
    }

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
