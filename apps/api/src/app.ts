import { Hono } from "hono";
import { cors } from "hono/cors";
import { CalendarReportSchema } from "@commondays/shared";
import { events, schools } from "./data.js";

export const app = new Hono();

app.use("/api/*", cors({ origin: ["http://localhost:5173"] }));

app.get("/health", (context) => context.json({ status: "ok", service: "common-days-api" }));

app.get("/api/v1/schools", (context) => {
  const query = context.req.query("q")?.trim().toLowerCase() ?? "";
  const matches = query
    ? schools.filter((school) => `${school.name} ${school.shortName} ${school.location}`.toLowerCase().includes(query))
    : schools;

  return context.json({ schools: matches });
});

app.get("/api/v1/calendars", (context) => {
  const academicYear = context.req.query("year") ?? "2026-27";
  const selectedIds = (context.req.query("schools") ?? "uiuc,berkeley,nyu").split(",").filter(Boolean);
  const selectedSchools = schools.filter((school) => selectedIds.includes(school.id) && school.availableYears.includes(academicYear));
  const selectedEvents = events.filter((event) => selectedIds.includes(event.schoolId));

  return context.json({ academicYear, schools: selectedSchools, events: selectedEvents, source: "development_seed" });
});

app.post("/api/v1/reports", async (context) => {
  const result = CalendarReportSchema.safeParse(await context.req.json());
  if (!result.success) return context.json({ error: "Invalid report", issues: result.error.flatten() }, 400);

  return context.json({
    report: { id: crypto.randomUUID(), status: "submitted", ...result.data },
    message: "Correction report submitted for review.",
  }, 201);
});
