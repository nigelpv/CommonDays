import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const calendarStatus = pgEnum("calendar_status", [
  "processing",
  "published",
  "needs_review",
  "failed",
  "superseded",
]);

export const calendarSourceType = pgEnum("calendar_source_type", [
  "screenshots",
  "pdf",
  "ical",
  "manual",
  "official_url",
]);

export const calendarEventKind = pgEnum("calendar_event_kind", [
  "break",
  "holiday",
  "no_classes",
  "term_boundary",
]);

export const uploadFileType = pgEnum("upload_file_type", ["image", "pdf"]);
export const uploadStatus = pgEnum("upload_status", ["uploaded", "processing", "processed", "failed"]);
export const reportReason = pgEnum("report_reason", ["wrong_date", "missing_date", "wrong_name", "other"]);
export const reportStatus = pgEnum("report_status", ["submitted", "reviewing", "resolved", "rejected"]);

export const schools = pgTable(
  "schools",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    shortName: varchar("short_name", { length: 64 }).notNull(),
    location: text("location").notNull(),
    initials: varchar("initials", { length: 3 }).notNull(),
    color: varchar("color", { length: 7 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("schools_name_idx").on(table.name),
    check("schools_color_hex_check", sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
).enableRLS();

export const academicCalendars = pgTable(
  "academic_calendars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    academicYear: varchar("academic_year", { length: 7 }).notNull(),
    version: integer("version").default(1).notNull(),
    status: calendarStatus("status").default("processing").notNull(),
    sourceType: calendarSourceType("source_type").notNull(),
    officialSourceUrl: text("official_source_url"),
    submittedBy: uuid("submitted_by"),
    extractionModel: text("extraction_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("academic_calendars_school_year_version_idx").on(
      table.schoolId,
      table.academicYear,
      table.version,
    ),
    uniqueIndex("academic_calendars_one_published_idx")
      .on(table.schoolId, table.academicYear)
      .where(sql`${table.status} = 'published'`),
    index("academic_calendars_lookup_idx").on(table.schoolId, table.academicYear, table.status),
    check("academic_calendars_year_check", sql`${table.academicYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("academic_calendars_version_check", sql`${table.version} > 0`),
  ],
).enableRLS();

export const calendarUploads = pgTable(
  "calendar_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => academicCalendars.id, { onDelete: "cascade" }),
    fileType: uploadFileType("file_type").notNull(),
    position: smallint("position").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storagePath: text("storage_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: varchar("sha256", { length: 64 }),
    status: uploadStatus("status").default("uploaded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_uploads_storage_path_idx").on(table.storagePath),
    uniqueIndex("calendar_uploads_calendar_position_idx").on(table.calendarId, table.position),
    check("calendar_uploads_position_check", sql`${table.position} between 1 and 10`),
    check("calendar_uploads_byte_size_check", sql`${table.byteSize} > 0`),
  ],
).enableRLS();

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => academicCalendars.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: calendarEventKind("kind").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    sourceUploadId: uuid("source_upload_id").references(() => calendarUploads.id, { onDelete: "set null" }),
    sourcePage: smallint("source_page"),
    rawText: text("raw_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_events_natural_key_idx").on(table.calendarId, table.name, table.startDate, table.endDate),
    index("calendar_events_date_lookup_idx").on(table.calendarId, table.startDate, table.endDate),
    check("calendar_events_date_order_check", sql`${table.endDate} >= ${table.startDate}`),
  ],
).enableRLS();

export const calendarReports = pgTable(
  "calendar_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => academicCalendars.id, { onDelete: "restrict" }),
    eventId: uuid("event_id").references(() => calendarEvents.id, { onDelete: "set null" }),
    reason: reportReason("reason").notNull(),
    details: text("details").notNull(),
    suggestedName: text("suggested_name"),
    suggestedStartDate: date("suggested_start_date", { mode: "string" }),
    suggestedEndDate: date("suggested_end_date", { mode: "string" }),
    status: reportStatus("status").default("submitted").notNull(),
    submittedBy: uuid("submitted_by"),
    reviewedBy: uuid("reviewed_by"),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("calendar_reports_status_created_idx").on(table.status, table.createdAt),
    index("calendar_reports_calendar_idx").on(table.calendarId),
  ],
).enableRLS();
