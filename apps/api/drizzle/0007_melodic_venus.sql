CREATE TYPE "public"."calendar_correction_operation" AS ENUM('add_event', 'update_event', 'delete_event', 'add_period', 'update_period', 'delete_period');--> statement-breakpoint
CREATE TABLE "calendar_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"from_calendar_id" uuid NOT NULL,
	"to_calendar_id" uuid NOT NULL,
	"operation" "calendar_correction_operation" NOT NULL,
	"target_lineage_id" uuid,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"reviewed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_corrections_distinct_versions_check" CHECK ("calendar_corrections"."from_calendar_id" <> "calendar_corrections"."to_calendar_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD COLUMN "source_calendar_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ADD COLUMN "lineage_id" uuid;--> statement-breakpoint
UPDATE "calendar_activity_periods" SET "lineage_id" = "id" WHERE "lineage_id" IS NULL;--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ALTER COLUMN "lineage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "lineage_id" uuid;--> statement-breakpoint
UPDATE "calendar_events" SET "lineage_id" = "id" WHERE "lineage_id" IS NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "lineage_id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "lineage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_reports" ADD COLUMN "resolution_calendar_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_corrections" ADD CONSTRAINT "calendar_corrections_report_id_calendar_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."calendar_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_corrections" ADD CONSTRAINT "calendar_corrections_from_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("from_calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_corrections" ADD CONSTRAINT "calendar_corrections_to_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("to_calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_corrections_operation_id_idx" ON "calendar_corrections" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_corrections_report_id_idx" ON "calendar_corrections" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_corrections_to_calendar_id_idx" ON "calendar_corrections" USING btree ("to_calendar_id");--> statement-breakpoint
CREATE INDEX "calendar_corrections_from_calendar_id_idx" ON "calendar_corrections" USING btree ("from_calendar_id");--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD CONSTRAINT "academic_calendars_source_calendar_id_fk" FOREIGN KEY ("source_calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reports" ADD CONSTRAINT "calendar_reports_resolution_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("resolution_calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "academic_calendars_source_calendar_idx" ON "academic_calendars" USING btree ("source_calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_activity_periods_calendar_lineage_idx" ON "calendar_activity_periods" USING btree ("calendar_id","lineage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_calendar_lineage_idx" ON "calendar_events" USING btree ("calendar_id","lineage_id");
