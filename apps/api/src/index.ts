import "dotenv/config";
import { serve } from "@hono/node-server";

const { createApp } = await import("./app.js");
const { createResendSchoolSimilarityMailerFromEnv } = await import(
  "./email/school-similarity-mailer.js"
);
const { createGeminiCalendarExtractorFromEnv } = await import("./extraction/calendar-extractor.js");
const { createCalendarExtractionRuntime } = await import("./inngest/calendar-extraction.js");
const { createCalendarRepository } = await import("./repositories/calendar-repository.js");

const repository = createCalendarRepository();
const extractor = createGeminiCalendarExtractorFromEnv();
const schoolSimilarityAlertMailer = createResendSchoolSimilarityMailerFromEnv();
const extractionRuntime = createCalendarExtractionRuntime({
  repository,
  extractor,
  schoolSimilarityAlertMailer,
});
const app = createApp(repository, {
  calendarExtractionQueue: extractionRuntime?.queue,
  schoolSimilarityAlertQueue: extractionRuntime?.schoolSimilarityAlertQueue,
  inngestHandler: extractionRuntime?.handler,
});

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Common Days API listening on http://localhost:${info.port}`);
});
