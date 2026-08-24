import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { events, schools } from "../data.js";
import { createDatabase } from "./client.js";
import { academicCalendars, calendarEvents, schools as schoolTable } from "./schema.js";

const academicYear = "2026-27";
const seedMarker = "development-seed";
const connection = createDatabase();

if (!connection) {
  throw new Error("DATABASE_URL is required to seed the database.");
}

try {
  for (const school of schools) {
    await connection.db
      .insert(schoolTable)
      .values({
        id: school.id,
        name: school.name,
        shortName: school.shortName,
        location: school.location,
        initials: school.initials,
        color: school.color,
      })
      .onConflictDoNothing();

    const [insertedCalendar] = await connection.db
      .insert(academicCalendars)
      .values({
        schoolId: school.id,
        academicYear,
        version: 1,
        status: "published",
        sourceType: "manual",
        extractionModel: seedMarker,
        publishedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: academicCalendars.id });

    const [existingSeedCalendar] = insertedCalendar
      ? [insertedCalendar]
      : await connection.db
          .select({ id: academicCalendars.id })
          .from(academicCalendars)
          .where(
            and(
              eq(academicCalendars.schoolId, school.id),
              eq(academicCalendars.academicYear, academicYear),
              eq(academicCalendars.version, 1),
              eq(academicCalendars.extractionModel, seedMarker),
            ),
          )
          .limit(1);

    if (!existingSeedCalendar) continue;

    for (const event of events.filter((candidate) => candidate.schoolId === school.id)) {
      await connection.db
        .insert(calendarEvents)
        .values({
          calendarId: existingSeedCalendar.id,
          name: event.name,
          kind: event.kind,
          startDate: event.startDate,
          endDate: event.endDate,
        })
        .onConflictDoNothing();
    }
  }

  console.log("Common Days development calendars are ready.");
} finally {
  await connection.close();
}

