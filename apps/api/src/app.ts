import { AcademicYearSchema, CalendarReportSchema } from "@commondays/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CalendarNotFoundError,
  createCalendarRepository,
  ReportEventMismatchError,
  type CalendarRepository,
} from "./repositories/calendar-repository.js";

export function createApp(repository: CalendarRepository = createCalendarRepository()) {
  const app = new Hono();

  app.use("/api/*", cors({ origin: ["http://localhost:5173"] }));

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "common-days-api", dataSource: repository.source }),
  );

  app.get("/api/v1/schools", async (context) => {
    const query = context.req.query("q")?.trim() ?? "";
    return context.json({ schools: await repository.searchSchools(query) });
  });

  app.get("/api/v1/calendars", async (context) => {
    const yearResult = AcademicYearSchema.safeParse(context.req.query("year") ?? "2026-27");
    if (!yearResult.success) return context.json({ error: "Invalid academic year." }, 400);

    const schoolIds = [
      ...new Set(
        (context.req.query("schools") ?? "uiuc,berkeley,nyu")
          .split(",")
          .map((schoolId) => schoolId.trim())
          .filter(Boolean),
      ),
    ];
    if (schoolIds.length === 0) return context.json({ error: "Select at least one school." }, 400);

    return context.json(await repository.getComparison({ academicYear: yearResult.data, schoolIds }));
  });

  app.post("/api/v1/reports", async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return context.json({ error: "Invalid JSON body." }, 400);
    }

    const result = CalendarReportSchema.safeParse(payload);
    if (!result.success) return context.json({ error: "Invalid report", issues: result.error.flatten() }, 400);

    try {
      const report = await repository.createReport(result.data);
      return context.json({ report, message: "Correction report submitted for review." }, 201);
    } catch (error) {
      if (error instanceof CalendarNotFoundError) return context.json({ error: error.message }, 404);
      if (error instanceof ReportEventMismatchError) return context.json({ error: error.message }, 422);
      throw error;
    }
  });

  app.onError((error, context) => {
    console.error("Common Days API request failed", error);
    return context.json({ error: "The data service is temporarily unavailable." }, 503);
  });

  return app;
}
