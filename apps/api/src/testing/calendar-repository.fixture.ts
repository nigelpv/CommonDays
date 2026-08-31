import { CalendarSubmissionSchema, getAcademicYearDateWindow } from "@commondays/shared";
import type {
  AdminEditableActivityPeriod,
  AdminReport,
  AdminReportDetail,
  CalendarEvent,
  CalendarSubmission,
  School,
} from "@commondays/shared";
import { schoolDirectory } from "../data.js";
import {
  AdminReportNotFoundError,
  AdminCorrectionConflictError,
  AdminCorrectionValidationError,
  AdminReportSourceNotFoundError,
  AdminReportTransitionError,
  CalendarAlreadyAvailableError,
  CalendarNotFoundError,
  CalendarSubmissionNotFoundError,
  ReportEventMismatchError,
  SchoolNotFoundError,
  SubmissionAlreadyInProgressError,
  type CalendarRepository,
  type SchoolSimilarityAlert,
} from "../repositories/calendar-repository.js";
import {
  deriveSchoolPresentation,
  rankSimilarSchools,
} from "../schools/school-similarity.js";
import { deriveInternalCalendarGaps } from "../extraction/calendar-extraction-service.js";

type TestCalendarEvent = CalendarEvent & {
  academicYear: string;
  calendarId: string;
  lineageId: string;
  sourceUploadId: string | null;
  sourcePage: number | null;
  rawText: string | null;
  isDerived: boolean;
};

type TestCalendarVersion = {
  id: string;
  schoolId: string;
  academicYear: string;
  version: number;
  sourceCalendarId: string;
};

const publishedSchoolIds = new Set(["uiuc", "berkeley", "nyu", "purdue"]);

const testEvents: CalendarEvent[] = [
  { id: "uiuc-thanksgiving", schoolId: "uiuc", name: "Thanksgiving break", startDate: "2026-11-21", endDate: "2026-11-29", kind: "break" },
  { id: "uiuc-winter", schoolId: "uiuc", name: "Winter break", startDate: "2026-12-19", endDate: "2027-01-17", kind: "break" },
  { id: "uiuc-spring", schoolId: "uiuc", name: "Spring break", startDate: "2027-03-13", endDate: "2027-03-21", kind: "break" },
  { id: "uiuc-summer", schoolId: "uiuc", name: "Summer break", startDate: "2027-05-15", endDate: "2027-08-22", kind: "break" },
  { id: "berkeley-thanksgiving", schoolId: "berkeley", name: "Thanksgiving break", startDate: "2026-11-25", endDate: "2026-11-29", kind: "break" },
  { id: "berkeley-winter", schoolId: "berkeley", name: "Winter break", startDate: "2026-12-19", endDate: "2027-01-11", kind: "break" },
  { id: "berkeley-spring", schoolId: "berkeley", name: "Spring recess", startDate: "2027-03-22", endDate: "2027-03-26", kind: "break" },
  { id: "berkeley-summer", schoolId: "berkeley", name: "Summer break", startDate: "2027-05-15", endDate: "2027-08-17", kind: "break" },
  { id: "nyu-thanksgiving", schoolId: "nyu", name: "Thanksgiving recess", startDate: "2026-11-26", endDate: "2026-11-29", kind: "break" },
  { id: "nyu-winter", schoolId: "nyu", name: "Winter recess", startDate: "2026-12-23", endDate: "2027-01-24", kind: "break" },
  { id: "nyu-spring", schoolId: "nyu", name: "Spring break", startDate: "2027-03-15", endDate: "2027-03-21", kind: "break" },
  { id: "nyu-summer", schoolId: "nyu", name: "Summer break", startDate: "2027-05-15", endDate: "2027-09-01", kind: "break" },
  { id: "purdue-thanksgiving", schoolId: "purdue", name: "Thanksgiving vacation", startDate: "2026-11-25", endDate: "2026-11-29", kind: "break" },
  { id: "purdue-winter", schoolId: "purdue", name: "Winter recess", startDate: "2026-12-20", endDate: "2027-01-10", kind: "break" },
  { id: "purdue-spring", schoolId: "purdue", name: "Spring vacation", startDate: "2027-03-13", endDate: "2027-03-21", kind: "break" },
  { id: "purdue-summer", schoolId: "purdue", name: "Summer break", startDate: "2027-05-09", endDate: "2027-08-22", kind: "break" },
];

function calendarKey(schoolId: string, academicYear: string) {
  return `${schoolId}:${academicYear}`;
}

const partialDayEvidencePatterns = [
  /\b(?:noon|midnight|morning|afternoon|evening|half[- ]day)\b/i,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i,
  /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/i,
];

function assertWholeDayCorrection(event: Pick<TestCalendarEvent, "name" | "rawText">) {
  const evidence = `${event.name} ${event.rawText ?? ""}`;
  if (partialDayEvidencePatterns.some((pattern) => pattern.test(evidence))) {
    throw new AdminCorrectionValidationError(
      "Common Days cannot publish a partial-day event as a full day without classes.",
    );
  }
}

function extractedTestEvents(schoolId: string, academicYear: string, submissionId: string): TestCalendarEvent[] {
  const startYear = Number(academicYear.slice(0, 4));
  const nextYear = startYear + 1;

  return [
    { id: `${submissionId}-thanksgiving`, academicYear, calendarId: submissionId, schoolId, name: "Thanksgiving break", startDate: `${startYear}-11-25`, endDate: `${startYear}-11-29`, kind: "break" },
    { id: `${submissionId}-winter`, academicYear, calendarId: submissionId, schoolId, name: "Winter break", startDate: `${startYear}-12-20`, endDate: `${nextYear}-01-10`, kind: "break" },
    { id: `${submissionId}-spring`, academicYear, calendarId: submissionId, schoolId, name: "Spring break", startDate: `${nextYear}-03-06`, endDate: `${nextYear}-03-14`, kind: "break" },
    { id: `${submissionId}-summer`, academicYear, calendarId: submissionId, schoolId, name: "Summer break", startDate: `${nextYear}-05-02`, endDate: `${nextYear}-08-22`, kind: "break" },
  ].map((event) => ({
    ...event,
    kind: event.kind as "break",
    lineageId: crypto.randomUUID(),
    sourceUploadId: null,
    sourcePage: null,
    rawText: null,
    isDerived: false,
  }));
}

/** Deterministic in-memory repository used only by API tests. */
export function createTestCalendarRepository(options: { adminUserId?: string } = {}): CalendarRepository {
  let localSchools: School[] = schoolDirectory.map((school) => ({
    ...school,
    availableYears: publishedSchoolIds.has(school.id) ? ["2026-27"] : [],
  }));
  const publishedCalendarIds = new Map<string, string>();
  const calendarVersions = new Map<string, TestCalendarVersion>();
  const sourceFilesByCalendar = new Map<string, AdminReportDetail["sourceFiles"]>();
  const periodsByCalendar = new Map<string, AdminEditableActivityPeriod[]>();
  for (const school of localSchools) {
    for (const academicYear of school.availableYears) {
      const calendarId = `test-${school.id}-${academicYear}`;
      publishedCalendarIds.set(calendarKey(school.id, academicYear), calendarId);
      calendarVersions.set(calendarId, {
        id: calendarId,
        schoolId: school.id,
        academicYear,
        version: 1,
        sourceCalendarId: calendarId,
      });
      const sourceUploadId = `source-${school.id}-${academicYear}`;
      sourceFilesByCalendar.set(calendarId, [{
        id: sourceUploadId,
        fileType: "pdf",
        position: 1,
        originalFilename: `${school.shortName}-${academicYear}.pdf`,
        mimeType: "application/pdf",
        byteSize: 1_024,
      }]);
      periodsByCalendar.set(calendarId, [
        {
          id: `${calendarId}-fall-period`,
          lineageId: crypto.randomUUID(),
          name: "Fall instructional period",
          startDate: `${academicYear.slice(0, 4)}-08-24`,
          endDate: `${academicYear.slice(0, 4)}-12-18`,
          startSourceUploadId: sourceUploadId,
          startSourcePage: 1,
          startRawText: "Fall instruction begins",
          endSourceUploadId: sourceUploadId,
          endSourcePage: 1,
          endRawText: "Fall instruction ends",
        },
        {
          id: `${calendarId}-spring-period`,
          lineageId: crypto.randomUUID(),
          name: "Spring instructional period",
          startDate: `${Number(academicYear.slice(0, 4)) + 1}-01-18`,
          endDate: `${Number(academicYear.slice(0, 4)) + 1}-05-14`,
          startSourceUploadId: sourceUploadId,
          startSourcePage: 2,
          startRawText: "Spring instruction begins",
          endSourceUploadId: sourceUploadId,
          endSourcePage: 2,
          endRawText: "Spring instruction ends",
        },
      ]);
    }
  }
  let localEvents: TestCalendarEvent[] = testEvents.map((event) => ({
    ...event,
    academicYear: "2026-27",
    calendarId: publishedCalendarIds.get(calendarKey(event.schoolId, "2026-27"))!,
    lineageId: crypto.randomUUID(),
    sourceUploadId: `source-${event.schoolId}-2026-27`,
    sourcePage: 1,
    rawText: event.name,
    isDerived: false,
  }));
  const submissions = new Map<string, {
    submission: CalendarSubmission;
    readyAt: number;
    files: Array<{ name: string; mimeType: string; content: Uint8Array }>;
    leaseToken: string | null;
  }>();
  const reports = new Map<string, AdminReport>();
  const correctionOperationReportIds = new Map<string, string>();
  const schoolSimilarityAlerts = new Map<string, SchoolSimilarityAlert>();
  const adminUserId = options.adminUserId ?? null;

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
    publishedCalendarIds.set(
      calendarKey(record.submission.schoolId, record.submission.academicYear),
      record.submission.id,
    );
    calendarVersions.set(record.submission.id, {
      id: record.submission.id,
      schoolId: record.submission.schoolId,
      academicYear: record.submission.academicYear,
      version: 1,
      sourceCalendarId: record.submission.id,
    });
    const sourceUploadId = `${record.submission.id}-source-1`;
    sourceFilesByCalendar.set(record.submission.id, [{
      id: sourceUploadId,
      fileType: record.submission.sourceType === "pdf" ? "pdf" : "image",
      position: 1,
      originalFilename: "calendar-source",
      mimeType: record.submission.sourceType === "pdf" ? "application/pdf" : "image/png",
      byteSize: 1,
    }]);
    periodsByCalendar.set(record.submission.id, [{
      id: `${record.submission.id}-period`,
      lineageId: crypto.randomUUID(),
      name: "Academic activity period",
      startDate: `${record.submission.academicYear.slice(0, 4)}-08-01`,
      endDate: `${Number(record.submission.academicYear.slice(0, 4)) + 1}-05-31`,
      startSourceUploadId: sourceUploadId,
      startSourcePage: record.submission.sourceType === "pdf" ? 1 : null,
      startRawText: "Academic activity begins",
      endSourceUploadId: sourceUploadId,
      endSourcePage: record.submission.sourceType === "pdf" ? 1 : null,
      endRawText: "Academic activity ends",
    }]);
    localEvents = [
      ...localEvents,
      ...extractedTestEvents(record.submission.schoolId, record.submission.academicYear, record.submission.id),
    ];
  }

  return {
    source: "supabase",

    async searchSchools(query) {
      const normalizedQuery = query.trim().toLowerCase();
      const schools = (normalizedQuery
        ? localSchools.filter((school) =>
            `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(normalizedQuery),
          )
        : localSchools).slice(0, 25);
      if (!normalizedQuery || schools.length > 0) {
        return { schools: schools.map((school) => ({ ...school })), similarSchools: [] };
      }

      const similarSchools = rankSimilarSchools(query, localSchools).flatMap((candidate) => {
        const school = localSchools.find((item) => item.id === candidate.id);
        return school ? [{ ...school, similarity: candidate.similarity }] : [];
      });
      return { schools: [], similarSchools };
    },

    async createSchool(request) {
      const name = request.name.trim().replace(/\s+/g, " ");
      const location = request.location.trim().replace(/\s+/g, " ");
      const ranked = rankSimilarSchools(name, localSchools);
      const presentation = deriveSchoolPresentation(name);
      const school: School = {
        id: crypto.randomUUID(),
        name,
        location,
        ...presentation,
        availableYears: [],
      };
      const similarSchools = ranked.flatMap((candidate) => {
        const match = localSchools.find((item) => item.id === candidate.id);
        return match ? [{ ...match, similarity: candidate.similarity }] : [];
      });
      localSchools = [...localSchools, school];

      let alertId: string | null = null;
      if (similarSchools.length > 0) {
        alertId = crypto.randomUUID();
        schoolSimilarityAlerts.set(alertId, {
          id: alertId,
          status: "queued",
          nextAttemptAt: new Date().toISOString(),
          createdSchool: {
            id: school.id,
            name: school.name,
            shortName: school.shortName,
            location: school.location,
          },
          similarSchools: similarSchools.map((match) => ({
            id: match.id,
            name: match.name,
            shortName: match.shortName,
            location: match.location,
            similarity: match.similarity,
          })),
        });
      }

      return { school: { ...school }, similarSchools, alertId };
    },

    async getSchoolSimilarityAlert(id) {
      const alert = schoolSimilarityAlerts.get(id);
      return alert
        ? {
            ...alert,
            createdSchool: { ...alert.createdSchool },
            similarSchools: alert.similarSchools.map((school) => ({ ...school })),
          }
        : null;
    },

    async listQueuedSchoolSimilarityAlerts(limit = 25) {
      return [...schoolSimilarityAlerts.values()]
        .filter((alert) => alert.status === "queued" && Date.parse(alert.nextAttemptAt) <= Date.now())
        .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
        .map((alert) => alert.id);
    },

    async markSchoolSimilarityAlertSent(id) {
      const alert = schoolSimilarityAlerts.get(id);
      if (alert?.status === "queued") schoolSimilarityAlerts.set(id, { ...alert, status: "sent" });
    },

    async recordSchoolSimilarityAlertFailure(id) {
      const alert = schoolSimilarityAlerts.get(id);
      if (alert?.status === "queued") {
        schoolSimilarityAlerts.set(id, {
          ...alert,
          nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
      }
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
        events: localEvents
          .filter((event) =>
            selectedSchoolIds.has(event.schoolId) &&
            event.academicYear === academicYear &&
            event.calendarId === publishedCalendarIds.get(calendarKey(event.schoolId, academicYear)),
          )
          .map(({ academicYear: _academicYear, calendarId: _calendarId, ...event }) => event),
        source: "supabase",
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
      submissions.set(submission.id, {
        submission,
        readyAt: Date.now() + 1_200,
        files: files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          content: Uint8Array.from(file.content),
        })),
        leaseToken: null,
      });
      return { ...submission };
    },

    async getCalendarSubmission(id) {
      const record = submissions.get(id);
      if (!record) throw new CalendarSubmissionNotFoundError();
      publishIfReady(record);
      return { ...record.submission };
    },

    async claimCalendarExtraction(calendarId) {
      const record = submissions.get(calendarId);
      if (!record || record.submission.status !== "processing" || record.leaseToken) return null;
      record.leaseToken = crypto.randomUUID();
      return { calendarId, leaseToken: record.leaseToken };
    },

    async getCalendarExtractionInput(claim) {
      const record = submissions.get(claim.calendarId);
      if (!record || record.leaseToken !== claim.leaseToken || record.submission.status !== "processing") {
        throw new Error("The test extraction claim is inactive.");
      }
      const school = getSchool(record.submission.schoolId);
      return {
        calendarId: record.submission.id,
        schoolId: school.id,
        schoolName: school.name,
        academicYear: record.submission.academicYear,
        files: record.files.map((file, index) => ({
          uploadId: crypto.randomUUID(),
          position: index + 1,
          originalFilename: file.name,
          mimeType: file.mimeType as "application/pdf" | "image/jpeg" | "image/png" | "image/webp",
          content: Uint8Array.from(file.content),
        })),
      };
    },

    async publishCalendarExtraction(claim, _model, periods, events) {
      const record = submissions.get(claim.calendarId);
      if (!record || record.leaseToken !== claim.leaseToken || record.submission.status !== "processing") {
        throw new Error("The test extraction claim is inactive.");
      }
      if (periods.length === 0) throw new Error("The test extraction has no academic activity periods.");
      record.submission = { ...record.submission, status: "ready" };
      record.leaseToken = null;
      localSchools = localSchools.map((school) =>
        school.id === record.submission.schoolId && !school.availableYears.includes(record.submission.academicYear)
          ? { ...school, availableYears: [...school.availableYears, record.submission.academicYear] }
          : school,
      );
      publishedCalendarIds.set(
        calendarKey(record.submission.schoolId, record.submission.academicYear),
        record.submission.id,
      );
      calendarVersions.set(record.submission.id, {
        id: record.submission.id,
        schoolId: record.submission.schoolId,
        academicYear: record.submission.academicYear,
        version: 1,
        sourceCalendarId: record.submission.id,
      });
      const sourceUploadId = `${record.submission.id}-source-1`;
      sourceFilesByCalendar.set(record.submission.id, [{
        id: sourceUploadId,
        fileType: record.submission.sourceType === "pdf" ? "pdf" : "image",
        position: 1,
        originalFilename: record.files[0]?.name ?? "calendar-source",
        mimeType: record.files[0]?.mimeType ?? "application/pdf",
        byteSize: record.files[0]?.content.byteLength ?? 1,
      }]);
      periodsByCalendar.set(record.submission.id, periods.map((period) => ({
        id: crypto.randomUUID(),
        lineageId: crypto.randomUUID(),
        name: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        startSourceUploadId: sourceUploadId,
        startSourcePage: period.startSourcePage,
        startRawText: period.startRawText,
        endSourceUploadId: sourceUploadId,
        endSourcePage: period.endSourcePage,
        endRawText: period.endRawText,
      })));
      localEvents = [
        ...localEvents,
        ...events.map((event) => ({
          id: crypto.randomUUID(),
          lineageId: crypto.randomUUID(),
          academicYear: record.submission.academicYear,
          calendarId: record.submission.id,
          schoolId: record.submission.schoolId,
          name: event.name,
          startDate: event.startDate,
          endDate: event.endDate,
          kind: event.kind,
          sourceUploadId: event.sourceUploadId ? sourceUploadId : null,
          sourcePage: event.sourcePage,
          rawText: event.rawText,
          isDerived: event.isDerived,
        })),
      ];
    },

    async failCalendarExtraction(calendarId) {
      const record = submissions.get(calendarId);
      if (!record || record.submission.status !== "processing") return;
      record.submission = { ...record.submission, status: "failed" };
      record.leaseToken = null;
    },

    async listQueuedCalendarExtractions(limit = 25) {
      return [...submissions.values()]
        .filter((record) => record.submission.status === "processing" && !record.leaseToken)
        .slice(0, limit)
        .map((record) => record.submission.id);
    },

    async createReport(report) {
      const school = localSchools.find(
        (candidate) => candidate.id === report.schoolId && candidate.availableYears.includes(report.academicYear),
      );
      if (!school) throw new CalendarNotFoundError();

      const calendarId = publishedCalendarIds.get(calendarKey(report.schoolId, report.academicYear));
      if (!calendarId) throw new CalendarNotFoundError();

      if (report.eventId) {
        const event = localEvents.find((candidate) => candidate.id === report.eventId);
        if (
          !event ||
          event.schoolId !== report.schoolId ||
          event.academicYear !== report.academicYear ||
          event.calendarId !== calendarId
        ) {
          throw new ReportEventMismatchError();
        }
      }

      const id = crypto.randomUUID();
      const event = report.eventId
        ? localEvents.find((candidate) => candidate.id === report.eventId) ?? null
        : null;
      reports.set(id, {
        id,
        calendarId,
        schoolId: report.schoolId,
        schoolName: school.name,
        schoolShortName: school.shortName,
        academicYear: report.academicYear,
        eventId: event?.id ?? null,
        eventName: event?.name ?? null,
        eventStartDate: event?.startDate ?? null,
        eventEndDate: event?.endDate ?? null,
        eventKind: event?.kind ?? null,
        reason: report.reason,
        details: report.details,
        status: "submitted",
        createdAt: new Date().toISOString(),
        resolutionNotes: null,
        resolutionCalendarId: null,
        resolvedAt: null,
      });

      return { id, status: "submitted", ...report };
    },

    async isAdminUser(userId) {
      return adminUserId !== null && userId === adminUserId;
    },

    async listAdminReports(status) {
      return [...reports.values()]
        .filter((report) => !status || report.status === status)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((report) => ({ ...report }));
    },

    async getAdminReport(id) {
      const report = reports.get(id);
      if (!report) throw new AdminReportNotFoundError();
      const reportedCalendar = calendarVersions.get(report.calendarId);
      if (!reportedCalendar) throw new AdminReportNotFoundError();
      const currentCalendarId = publishedCalendarIds.get(
        calendarKey(report.schoolId, report.academicYear),
      );
      const currentCalendar = currentCalendarId ? calendarVersions.get(currentCalendarId) : null;
      if (!currentCalendar) throw new AdminCorrectionConflictError();

      const reportedEvent = report.eventId
        ? localEvents.find((event) => event.id === report.eventId && event.calendarId === report.calendarId) ?? null
        : null;
      const currentEventRows = localEvents.filter((event) => event.calendarId === currentCalendar.id);
      const mapEvent = (event: TestCalendarEvent) => ({
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
      });
      const currentEvent = reportedEvent
        ? currentEventRows.find((event) => event.lineageId === reportedEvent.lineageId) ?? null
        : null;
      const detail: AdminReportDetail = {
        ...report,
        reportedCalendar: { id: reportedCalendar.id, version: reportedCalendar.version },
        currentCalendar: { id: currentCalendar.id, version: currentCalendar.version },
        currentEvent: currentEvent ? mapEvent(currentEvent) : null,
        currentEvents: currentEventRows.filter((event) => !event.isDerived).map(mapEvent),
        currentPeriods: (periodsByCalendar.get(currentCalendar.id) ?? []).map((period) => ({ ...period })),
        sourceFiles: (sourceFilesByCalendar.get(currentCalendar.sourceCalendarId) ?? []).map((file) => ({ ...file })),
      };
      return detail;
    },

    async createAdminReportSourceUrl(reportId, uploadId) {
      const report = reports.get(reportId);
      const reportedCalendar = report ? calendarVersions.get(report.calendarId) : null;
      const source = reportedCalendar
        ? (sourceFilesByCalendar.get(reportedCalendar.sourceCalendarId) ?? []).find((file) => file.id === uploadId)
        : null;
      if (!report || !reportedCalendar || !source) throw new AdminReportSourceNotFoundError();
      return {
        url: `https://storage.test/private/${encodeURIComponent(source.id)}?token=test-only`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    },

    async updateAdminReport(id, action) {
      const report = reports.get(id);
      if (!report) throw new AdminReportNotFoundError();
      if (action.action === "apply_correction") {
        const completedReportId = correctionOperationReportIds.get(action.operationId);
        if (completedReportId) {
          if (completedReportId !== id) throw new AdminCorrectionConflictError();
          return { ...reports.get(id)! };
        }
        if (report.status !== "reviewing") throw new AdminReportTransitionError();
        const key = calendarKey(report.schoolId, report.academicYear);
        const currentCalendarId = publishedCalendarIds.get(key);
        const currentCalendar = currentCalendarId ? calendarVersions.get(currentCalendarId) : null;
        if (
          !currentCalendar ||
          currentCalendar.id !== action.expectedCalendarId ||
          currentCalendar.version !== action.expectedCalendarVersion
        ) {
          throw new AdminCorrectionConflictError();
        }

        let nextEvents = localEvents
          .filter((event) => event.calendarId === currentCalendar.id && !event.isDerived)
          .map((event) => ({ ...event }));
        let nextPeriods = (periodsByCalendar.get(currentCalendar.id) ?? []).map((period) => ({ ...period }));
        const correction = action.correction;
        const sourceFiles = sourceFilesByCalendar.get(currentCalendar.sourceCalendarId) ?? [];
        const resolveEvidence = (evidence: { uploadId: string; sourcePage: number | null; rawText: string }) => {
          const source = sourceFiles.find((file) => file.id === evidence.uploadId);
          if (!source) throw new AdminCorrectionValidationError("Correction evidence must use this calendar's source.");
          if (source.mimeType === "application/pdf" && evidence.sourcePage === null) {
            throw new AdminCorrectionValidationError("PDF correction evidence needs a page number.");
          }
          if (source.mimeType !== "application/pdf" && evidence.sourcePage !== null) {
            throw new AdminCorrectionValidationError("Screenshot correction evidence cannot use a page number.");
          }
          return {
            sourceUploadId: source.id,
            sourcePage: evidence.sourcePage,
            rawText: evidence.rawText.trim(),
          };
        };

        if (correction.operation === "add_event") {
          const evidence = resolveEvidence(correction.evidence);
          const added: TestCalendarEvent = {
            id: crypto.randomUUID(),
            lineageId: crypto.randomUUID(),
            calendarId: currentCalendar.id,
            academicYear: report.academicYear,
            schoolId: report.schoolId,
            name: correction.name.trim(),
            kind: correction.kind,
            startDate: correction.startDate,
            endDate: correction.endDate,
            ...evidence,
            isDerived: false,
          };
          assertWholeDayCorrection(added);
          nextEvents.push(added);
        } else if (correction.operation === "update_event" || correction.operation === "delete_event") {
          const eventIndex = nextEvents.findIndex((event) => event.lineageId === correction.targetLineageId);
          if (eventIndex < 0) {
            throw new AdminCorrectionValidationError("That event is not editable in the current calendar.");
          }
          if (correction.operation === "delete_event") {
            nextEvents.splice(eventIndex, 1);
          } else {
            const existing = nextEvents[eventIndex]!;
            const normalizedName = correction.name.trim();
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
            const updated: TestCalendarEvent = {
              ...existing,
              name: normalizedName,
              kind: correction.kind,
              startDate: correction.startDate,
              endDate: correction.endDate,
              ...evidence,
            };
            assertWholeDayCorrection(updated);
            nextEvents[eventIndex] = updated;
          }
        } else if (correction.operation === "add_period") {
          const startEvidence = resolveEvidence(correction.startEvidence);
          const endEvidence = resolveEvidence(correction.endEvidence);
          nextPeriods.push({
            id: crypto.randomUUID(),
            lineageId: crypto.randomUUID(),
            name: correction.name.trim(),
            startDate: correction.startDate,
            endDate: correction.endDate,
            startSourceUploadId: startEvidence.sourceUploadId,
            startSourcePage: startEvidence.sourcePage,
            startRawText: startEvidence.rawText,
            endSourceUploadId: endEvidence.sourceUploadId,
            endSourcePage: endEvidence.sourcePage,
            endRawText: endEvidence.rawText,
          });
        } else {
          const periodIndex = nextPeriods.findIndex((period) => period.lineageId === correction.targetLineageId);
          if (periodIndex < 0) {
            throw new AdminCorrectionValidationError("That activity period is not in the current calendar.");
          }
          if (correction.operation === "delete_period") {
            nextPeriods.splice(periodIndex, 1);
          } else {
            const existing = nextPeriods[periodIndex]!;
            const normalizedName = correction.name.trim();
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
            nextPeriods[periodIndex] = {
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
          }
        }
        if (nextPeriods.length === 0) {
          throw new AdminCorrectionValidationError("A calendar must keep at least one activity period.");
        }
        const academicYearWindow = getAcademicYearDateWindow(report.academicYear);
        if ([...nextEvents, ...nextPeriods].some((item) =>
          item.endDate < item.startDate ||
          item.startDate < academicYearWindow.startDate ||
          item.endDate > academicYearWindow.endDate
        )) {
          throw new AdminCorrectionValidationError("Correction dates must stay inside the academic year.");
        }

        const nextCalendarId = crypto.randomUUID();
        calendarVersions.set(nextCalendarId, {
          id: nextCalendarId,
          schoolId: currentCalendar.schoolId,
          academicYear: currentCalendar.academicYear,
          version: currentCalendar.version + 1,
          sourceCalendarId: currentCalendar.sourceCalendarId,
        });
        periodsByCalendar.set(nextCalendarId, nextPeriods.map((period) => ({
          ...period,
          id: crypto.randomUUID(),
        })));
        nextEvents = nextEvents.map((event) => ({
          ...event,
          id: crypto.randomUUID(),
          calendarId: nextCalendarId,
        }));
        const derived = deriveInternalCalendarGaps(nextPeriods.map((period) => ({
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate,
          startSourceUploadId: period.startSourceUploadId ?? "",
          startSourcePage: period.startSourcePage,
          startRawText: period.startRawText,
          endSourceUploadId: period.endSourceUploadId ?? "",
          endSourcePage: period.endSourcePage,
          endRawText: period.endRawText,
        }))).map((event): TestCalendarEvent => ({
          id: crypto.randomUUID(),
          lineageId: crypto.randomUUID(),
          calendarId: nextCalendarId,
          academicYear: report.academicYear,
          schoolId: report.schoolId,
          name: event.name,
          kind: event.kind,
          startDate: event.startDate,
          endDate: event.endDate,
          sourceUploadId: null,
          sourcePage: null,
          rawText: null,
          isDerived: true,
        }));
        localEvents = [...localEvents, ...nextEvents, ...derived];
        publishedCalendarIds.set(key, nextCalendarId);
        correctionOperationReportIds.set(action.operationId, id);

        const updated: AdminReport = {
          ...report,
          status: "resolved",
          resolutionNotes: action.resolutionNotes,
          resolutionCalendarId: nextCalendarId,
          resolvedAt: new Date().toISOString(),
        };
        reports.set(id, updated);
        return { ...updated };
      }
      if (
        (action.action === "start_review" && report.status !== "submitted") ||
        (action.action === "reject" && report.status !== "submitted" && report.status !== "reviewing")
      ) {
        throw new AdminReportTransitionError();
      }

      const updated: AdminReport = action.action === "start_review"
        ? { ...report, status: "reviewing" }
        : {
            ...report,
            status: "rejected",
            resolutionNotes: action.resolutionNotes,
            resolutionCalendarId: null,
            resolvedAt: new Date().toISOString(),
          };
      reports.set(id, updated);
      return { ...updated };
    },
  };
}
