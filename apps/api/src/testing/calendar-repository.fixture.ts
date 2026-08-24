import { CalendarSubmissionSchema } from "@commondays/shared";
import type { AdminReport, CalendarEvent, CalendarSubmission, School } from "@commondays/shared";
import { schoolDirectory } from "../data.js";
import {
  AdminReportNotFoundError,
  AdminReportTransitionError,
  CalendarAlreadyAvailableError,
  CalendarNotFoundError,
  CalendarSubmissionNotFoundError,
  ReportEventMismatchError,
  SchoolNotFoundError,
  SubmissionAlreadyInProgressError,
  type CalendarRepository,
} from "../repositories/calendar-repository.js";

type TestCalendarEvent = CalendarEvent & {
  academicYear: string;
  calendarId: string;
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

function extractedTestEvents(schoolId: string, academicYear: string, submissionId: string): TestCalendarEvent[] {
  const startYear = Number(academicYear.slice(0, 4));
  const nextYear = startYear + 1;

  return [
    { id: `${submissionId}-thanksgiving`, academicYear, calendarId: submissionId, schoolId, name: "Thanksgiving break", startDate: `${startYear}-11-25`, endDate: `${startYear}-11-29`, kind: "break" },
    { id: `${submissionId}-winter`, academicYear, calendarId: submissionId, schoolId, name: "Winter break", startDate: `${startYear}-12-20`, endDate: `${nextYear}-01-10`, kind: "break" },
    { id: `${submissionId}-spring`, academicYear, calendarId: submissionId, schoolId, name: "Spring break", startDate: `${nextYear}-03-06`, endDate: `${nextYear}-03-14`, kind: "break" },
    { id: `${submissionId}-summer`, academicYear, calendarId: submissionId, schoolId, name: "Summer break", startDate: `${nextYear}-05-02`, endDate: `${nextYear}-08-22`, kind: "break" },
  ];
}

/** Deterministic in-memory repository used only by API tests. */
export function createTestCalendarRepository(options: { adminUserId?: string } = {}): CalendarRepository {
  let localSchools: School[] = schoolDirectory.map((school) => ({
    ...school,
    availableYears: publishedSchoolIds.has(school.id) ? ["2026-27"] : [],
  }));
  const publishedCalendarIds = new Map<string, string>();
  for (const school of localSchools) {
    for (const academicYear of school.availableYears) {
      publishedCalendarIds.set(calendarKey(school.id, academicYear), `test-${school.id}-${academicYear}`);
    }
  }
  let localEvents: TestCalendarEvent[] = testEvents.map((event) => ({
    ...event,
    academicYear: "2026-27",
    calendarId: publishedCalendarIds.get(calendarKey(event.schoolId, "2026-27"))!,
  }));
  const submissions = new Map<string, { submission: CalendarSubmission; readyAt: number }>();
  const reports = new Map<string, AdminReport>();
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
    localEvents = [
      ...localEvents,
      ...extractedTestEvents(record.submission.schoolId, record.submission.academicYear, record.submission.id),
    ];
  }

  return {
    source: "supabase",

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
        reason: report.reason,
        details: report.details,
        status: "submitted",
        createdAt: new Date().toISOString(),
        resolutionNotes: null,
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
      return { ...report };
    },

    async updateAdminReport(id, action) {
      const report = reports.get(id);
      if (!report) throw new AdminReportNotFoundError();
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
            resolvedAt: new Date().toISOString(),
          };
      reports.set(id, updated);
      return { ...updated };
    },
  };
}
