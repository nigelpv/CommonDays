import { Inngest, NonRetriableError, cron, eventType } from "inngest";
import { serve } from "inngest/hono";
import { z } from "zod";
import {
  CalendarExtractionValidationError,
  prepareCalendarExtraction,
} from "../extraction/calendar-extraction-service.js";
import type { CalendarExtractor } from "../extraction/types.js";
import type {
  SchoolSimilarityAlertMailer,
} from "../email/school-similarity-mailer.js";
import type { CalendarRepository } from "../repositories/calendar-repository.js";

const calendarSubmissionCreated = eventType("commondays/calendar.submitted", {
  schema: z.object({ calendarId: z.string().uuid() }).strict(),
});

const schoolSimilarityAlertRequested = eventType("commondays/school.similarity-alert.requested", {
  schema: z.object({ alertId: z.string().uuid() }).strict(),
});

// Primary jobs are event-driven and immediate. These are only disaster-recovery
// sweeps, so daily schedules preserve Railway's free serverless sleep window.
export const CALENDAR_RECOVERY_CRON = "17 8 * * *";
export const SCHOOL_ALERT_RECOVERY_CRON = "43 8 * * *";

export interface CalendarExtractionQueue {
  enqueue(calendarId: string): Promise<void>;
}

export interface SchoolSimilarityAlertQueue {
  enqueue(alertId: string): Promise<void>;
}

export interface CalendarExtractionRuntime {
  queue: CalendarExtractionQueue | null;
  schoolSimilarityAlertQueue: SchoolSimilarityAlertQueue | null;
  handler: ReturnType<typeof serve>;
}

interface InngestEnvironment {
  INNGEST_EVENT_KEY?: string;
  INNGEST_SIGNING_KEY?: string;
  INNGEST_DEV?: string;
  INNGEST_BASE_URL?: string;
}

interface CreateCalendarExtractionRuntimeOptions {
  repository: CalendarRepository;
  extractor?: CalendarExtractor | null;
  schoolSimilarityAlertMailer?: SchoolSimilarityAlertMailer | null;
  environment?: InngestEnvironment;
  client?: Inngest;
}

function configuredValue(value: string | undefined) {
  return value?.trim() || undefined;
}

function developmentMode(value: string | undefined) {
  const normalized = configuredValue(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized?.startsWith("http://") === true ||
    normalized?.startsWith("https://") === true;
}

export function calendarExtractionQueueIsConfigured(
  environment: InngestEnvironment = process.env,
) {
  if (developmentMode(environment.INNGEST_DEV)) return true;
  return Boolean(
    configuredValue(environment.INNGEST_EVENT_KEY) &&
      configuredValue(environment.INNGEST_SIGNING_KEY),
  );
}

function createClient(environment: InngestEnvironment) {
  const isDev = developmentMode(environment.INNGEST_DEV);
  const explicitDevUrl = configuredValue(environment.INNGEST_DEV);
  const developmentBaseUrl = explicitDevUrl?.startsWith("http://") || explicitDevUrl?.startsWith("https://")
    ? explicitDevUrl
    : undefined;
  return new Inngest({
    id: "common-days-api",
    eventKey: configuredValue(environment.INNGEST_EVENT_KEY),
    signingKey: configuredValue(environment.INNGEST_SIGNING_KEY),
    baseUrl: configuredValue(environment.INNGEST_BASE_URL) ?? developmentBaseUrl,
    isDev,
  });
}

function failureMessage(error: unknown, fallback = "Calendar extraction failed.") {
  if (!(error instanceof Error)) return fallback;
  return error.message.trim().slice(0, 500) || fallback;
}

export function createCalendarExtractionRuntime({
  repository,
  extractor = null,
  schoolSimilarityAlertMailer = null,
  environment = process.env,
  client: providedClient,
}: CreateCalendarExtractionRuntimeOptions): CalendarExtractionRuntime | null {
  if (!calendarExtractionQueueIsConfigured(environment)) return null;
  if (!extractor && !schoolSimilarityAlertMailer) return null;
  const client = providedClient ?? createClient(environment);

  const extractCalendar = extractor
    ? client.createFunction(
        {
          id: "extract-and-publish-calendar",
          name: "Extract and publish an academic calendar",
          triggers: [calendarSubmissionCreated],
          retries: 4,
          // Files can total 50 MB. A single global worker keeps the free
          // 512 MB backend from processing several document sets at once.
          concurrency: { limit: 1 },
          onFailure: async ({ event, error }) => {
            const originalEvent = event.data.event;
            const calendarId = originalEvent.data?.calendarId;
            if (typeof calendarId === "string") {
              await repository.failCalendarExtraction(calendarId, failureMessage(error));
            }
          },
        },
        async ({ event, step }) => {
          const claim = await step.run("claim-calendar-extraction", () =>
            repository.claimCalendarExtraction(event.data.calendarId),
          );
          if (!claim) return { status: "ignored" as const };

          const prepared = await step.run("extract-and-validate-calendar", async () => {
            const input = await repository.getCalendarExtractionInput(claim);
            const extraction = await extractor.extract(input);
            try {
              return prepareCalendarExtraction(input, extraction);
            } catch (error) {
              if (error instanceof CalendarExtractionValidationError) {
                throw new NonRetriableError(error.message, { cause: error });
              }
              throw error;
            }
          });

          await step.run("publish-calendar", () =>
            repository.publishCalendarExtraction(
              claim,
              extractor.model,
              prepared.periods,
              prepared.events,
              prepared.resultHash,
            ),
          );

          return { status: "published" as const, calendarId: claim.calendarId };
        },
      )
    : null;

  const recoverQueuedCalendars = extractor
    ? client.createFunction(
        {
          id: "recover-queued-calendar-extractions",
          name: "Recover queued academic calendar extractions",
          triggers: [cron(CALENDAR_RECOVERY_CRON)],
          retries: 2,
        },
        async ({ step }) => {
          const calendarIds = await step.run("find-queued-calendars", () =>
            repository.listQueuedCalendarExtractions(25),
          );
          if (calendarIds.length === 0) return { enqueued: 0 };

          await step.sendEvent(
            "requeue-calendar-extractions",
            calendarIds.map((calendarId) => ({
              name: calendarSubmissionCreated.name,
              data: { calendarId },
            })),
          );
          return { enqueued: calendarIds.length };
        },
      )
    : null;

  const emailSchoolSimilarityAlert = schoolSimilarityAlertMailer
    ? client.createFunction(
        {
          id: "email-school-similarity-alert",
          name: "Email a possible duplicate-school alert",
          triggers: [schoolSimilarityAlertRequested],
          retries: 4,
          concurrency: { limit: 1, key: "event.data.alertId" },
          onFailure: async ({ event, error }) => {
            const originalEvent = event.data.event;
            const alertId = originalEvent.data?.alertId;
            if (typeof alertId === "string") {
              await repository.recordSchoolSimilarityAlertFailure(
                alertId,
                failureMessage(error, "School similarity alert email failed."),
              );
            }
          },
        },
        async ({ event, step }) => {
          const alert = await step.run("load-school-similarity-alert", () =>
            repository.getSchoolSimilarityAlert(event.data.alertId),
          );
          if (!alert || alert.status === "sent") return { status: "ignored" as const };
          if (Date.parse(alert.nextAttemptAt) > Date.now()) {
            return { status: "deferred" as const, alertId: alert.id };
          }

          const delivery = await step.run("send-school-similarity-alert", () =>
            schoolSimilarityAlertMailer.send(alert),
          );
          await step.run("mark-school-similarity-alert-sent", () =>
            repository.markSchoolSimilarityAlertSent(alert.id, delivery.providerMessageId),
          );
          return { status: "sent" as const, alertId: alert.id };
        },
      )
    : null;

  const recoverQueuedSchoolSimilarityAlerts = schoolSimilarityAlertMailer
    ? client.createFunction(
        {
          id: "recover-queued-school-similarity-alerts",
          name: "Recover queued possible duplicate-school alerts",
          triggers: [cron(SCHOOL_ALERT_RECOVERY_CRON)],
          retries: 2,
        },
        async ({ step }) => {
          const alertIds = await step.run("find-queued-school-similarity-alerts", () =>
            repository.listQueuedSchoolSimilarityAlerts(25),
          );
          if (alertIds.length === 0) return { enqueued: 0 };

          await step.sendEvent(
            "requeue-school-similarity-alerts",
            alertIds.map((alertId) => ({
              name: schoolSimilarityAlertRequested.name,
              data: { alertId },
            })),
          );
          return { enqueued: alertIds.length };
        },
      )
    : null;

  const registeredFunctions = [
    ...(extractCalendar && recoverQueuedCalendars
      ? [extractCalendar, recoverQueuedCalendars]
      : []),
    ...(emailSchoolSimilarityAlert && recoverQueuedSchoolSimilarityAlerts
      ? [emailSchoolSimilarityAlert, recoverQueuedSchoolSimilarityAlerts]
      : []),
  ];

  return {
    queue: extractor
      ? {
          async enqueue(calendarId) {
            await client.send({
              name: calendarSubmissionCreated.name,
              data: { calendarId },
            });
          },
        }
      : null,
    schoolSimilarityAlertQueue: schoolSimilarityAlertMailer
      ? {
          async enqueue(alertId) {
            await client.send({
              name: schoolSimilarityAlertRequested.name,
              data: { alertId },
            });
          },
        }
      : null,
    handler: serve({ client, functions: registeredFunctions }),
  };
}
