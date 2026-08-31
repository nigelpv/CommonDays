import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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
export const calendarExtractionJobStatus = pgEnum("calendar_extraction_job_status", [
  "staging",
  "queued",
  "processing",
  "completed",
  "failed",
]);
export const reportReason = pgEnum("report_reason", ["wrong_date", "missing_date", "wrong_name", "other"]);
export const reportStatus = pgEnum("report_status", ["submitted", "reviewing", "resolved", "rejected"]);
export const calendarCorrectionOperation = pgEnum("calendar_correction_operation", [
  "add_event",
  "update_event",
  "delete_event",
  "add_period",
  "update_period",
  "delete_period",
]);
export const schoolSimilarityAlertStatus = pgEnum("school_similarity_alert_status", ["queued", "sent"]);

export const schools = pgTable(
  "schools",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    shortName: varchar("short_name", { length: 64 }).notNull(),
    location: text("location").notNull(),
    initials: varchar("initials", { length: 3 }).notNull(),
    color: varchar("color", { length: 7 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("schools_name_idx").on(table.name),
    index("schools_normalized_name_trgm_idx").using(
      "gin",
      table.normalizedName.op("gin_trgm_ops"),
    ),
    check("schools_color_hex_check", sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
).enableRLS();

export const schoolSimilarityAlerts = pgTable(
  "school_similarity_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdSchoolId: text("created_school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    status: schoolSimilarityAlertStatus("status").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("school_similarity_alerts_created_school_idx").on(table.createdSchoolId),
    index("school_similarity_alerts_recovery_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    check("school_similarity_alerts_attempt_count_check", sql`${table.attemptCount} >= 0`),
  ],
).enableRLS();

export const schoolSimilarityAlertMatches = pgTable(
  "school_similarity_alert_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => schoolSimilarityAlerts.id, { onDelete: "cascade" }),
    similarSchoolId: text("similar_school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    similarityScore: smallint("similarity_score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("school_similarity_alert_matches_alert_school_idx").on(
      table.alertId,
      table.similarSchoolId,
    ),
    index("school_similarity_alert_matches_alert_idx").on(table.alertId),
    check(
      "school_similarity_alert_matches_score_check",
      sql`${table.similarityScore} between 0 and 10000`,
    ),
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
    sourceCalendarId: uuid("source_calendar_id"),
    version: integer("version").default(1).notNull(),
    status: calendarStatus("status").default("processing").notNull(),
    sourceType: calendarSourceType("source_type").notNull(),
    officialSourceUrl: text("official_source_url"),
    submittedBy: uuid("submitted_by"),
    availabilityDerivationVersion: smallint("availability_derivation_version").default(0).notNull(),
    extractionModel: text("extraction_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceCalendarId],
      foreignColumns: [table.id],
      name: "academic_calendars_source_calendar_id_fk",
    }).onDelete("restrict"),
    uniqueIndex("academic_calendars_school_year_version_idx").on(
      table.schoolId,
      table.academicYear,
      table.version,
    ),
    uniqueIndex("academic_calendars_one_published_idx")
      .on(table.schoolId, table.academicYear)
      .where(sql`${table.status} = 'published'`),
    uniqueIndex("academic_calendars_one_active_submission_idx")
      .on(table.schoolId, table.academicYear)
      .where(sql`${table.status} in ('processing', 'needs_review')`),
    index("academic_calendars_lookup_idx").on(table.schoolId, table.academicYear, table.status),
    index("academic_calendars_source_calendar_idx").on(table.sourceCalendarId),
    check("academic_calendars_year_check", sql`${table.academicYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("academic_calendars_version_check", sql`${table.version} > 0`),
    check(
      "academic_calendars_availability_derivation_version_check",
      sql`${table.availabilityDerivationVersion} in (0, 1)`,
    ),
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

export const calendarActivityPeriods = pgTable(
  "calendar_activity_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    lineageId: uuid("lineage_id").defaultRandom().notNull(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => academicCalendars.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    startSourceUploadId: uuid("start_source_upload_id").references(() => calendarUploads.id, {
      onDelete: "set null",
    }),
    startSourcePage: smallint("start_source_page"),
    startRawText: text("start_raw_text").notNull(),
    endSourceUploadId: uuid("end_source_upload_id").references(() => calendarUploads.id, {
      onDelete: "set null",
    }),
    endSourcePage: smallint("end_source_page"),
    endRawText: text("end_raw_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_activity_periods_natural_key_idx").on(
      table.calendarId,
      table.name,
      table.startDate,
      table.endDate,
    ),
    uniqueIndex("calendar_activity_periods_calendar_lineage_idx").on(
      table.calendarId,
      table.lineageId,
    ),
    index("calendar_activity_periods_date_lookup_idx").on(
      table.calendarId,
      table.startDate,
      table.endDate,
    ),
    check("calendar_activity_periods_date_order_check", sql`${table.endDate} >= ${table.startDate}`),
    check(
      "calendar_activity_periods_start_source_page_check",
      sql`${table.startSourcePage} is null or ${table.startSourcePage} > 0`,
    ),
    check(
      "calendar_activity_periods_end_source_page_check",
      sql`${table.endSourcePage} is null or ${table.endSourcePage} > 0`,
    ),
  ],
).enableRLS();

export const calendarExtractionJobs = pgTable(
  "calendar_extraction_jobs",
  {
    calendarId: uuid("calendar_id")
      .primaryKey()
      .references(() => academicCalendars.id, { onDelete: "cascade" }),
    status: calendarExtractionJobStatus("status").default("staging").notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    resultHash: varchar("result_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("calendar_extraction_jobs_recovery_idx").on(table.status, table.leaseExpiresAt, table.createdAt),
    check("calendar_extraction_jobs_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "calendar_extraction_jobs_lease_check",
      sql`${table.status} <> 'processing' or (${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
    check(
      "calendar_extraction_jobs_hash_check",
      sql`${table.resultHash} is null or ${table.resultHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
).enableRLS();

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    lineageId: uuid("lineage_id").defaultRandom().notNull(),
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
    isDerived: boolean("is_derived").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_events_natural_key_idx").on(table.calendarId, table.name, table.startDate, table.endDate),
    uniqueIndex("calendar_events_calendar_lineage_idx").on(table.calendarId, table.lineageId),
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
    resolutionCalendarId: uuid("resolution_calendar_id").references(() => academicCalendars.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("calendar_reports_status_created_idx").on(table.status, table.createdAt),
    index("calendar_reports_calendar_idx").on(table.calendarId),
  ],
).enableRLS();

export const calendarCorrections = pgTable(
  "calendar_corrections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationId: uuid("operation_id").notNull(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => calendarReports.id, { onDelete: "restrict" }),
    fromCalendarId: uuid("from_calendar_id")
      .notNull()
      .references(() => academicCalendars.id, { onDelete: "restrict" }),
    toCalendarId: uuid("to_calendar_id")
      .notNull()
      .references(() => academicCalendars.id, { onDelete: "restrict" }),
    operation: calendarCorrectionOperation("operation").notNull(),
    targetLineageId: uuid("target_lineage_id"),
    beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown>>(),
    afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>(),
    reviewedBy: uuid("reviewed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calendar_corrections_operation_id_idx").on(table.operationId),
    uniqueIndex("calendar_corrections_report_id_idx").on(table.reportId),
    uniqueIndex("calendar_corrections_to_calendar_id_idx").on(table.toCalendarId),
    index("calendar_corrections_from_calendar_id_idx").on(table.fromCalendarId),
    check(
      "calendar_corrections_distinct_versions_check",
      sql`${table.fromCalendarId} <> ${table.toCalendarId}`,
    ),
  ],
).enableRLS();
