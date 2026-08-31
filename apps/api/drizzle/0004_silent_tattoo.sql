CREATE TABLE "calendar_activity_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_source_upload_id" uuid,
	"start_source_page" smallint,
	"start_raw_text" text NOT NULL,
	"end_source_upload_id" uuid,
	"end_source_page" smallint,
	"end_raw_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_activity_periods_date_order_check" CHECK ("calendar_activity_periods"."end_date" >= "calendar_activity_periods"."start_date"),
	CONSTRAINT "calendar_activity_periods_start_source_page_check" CHECK ("calendar_activity_periods"."start_source_page" is null or "calendar_activity_periods"."start_source_page" > 0),
	CONSTRAINT "calendar_activity_periods_end_source_page_check" CHECK ("calendar_activity_periods"."end_source_page" is null or "calendar_activity_periods"."end_source_page" > 0)
);
--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD COLUMN "availability_derivation_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "is_derived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ADD CONSTRAINT "calendar_activity_periods_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ADD CONSTRAINT "calendar_activity_periods_start_source_upload_id_calendar_uploads_id_fk" FOREIGN KEY ("start_source_upload_id") REFERENCES "public"."calendar_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_activity_periods" ADD CONSTRAINT "calendar_activity_periods_end_source_upload_id_calendar_uploads_id_fk" FOREIGN KEY ("end_source_upload_id") REFERENCES "public"."calendar_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_activity_periods_natural_key_idx" ON "calendar_activity_periods" USING btree ("calendar_id","name","start_date","end_date");--> statement-breakpoint
CREATE INDEX "calendar_activity_periods_date_lookup_idx" ON "calendar_activity_periods" USING btree ("calendar_id","start_date","end_date");--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD CONSTRAINT "academic_calendars_availability_derivation_version_check" CHECK ("academic_calendars"."availability_derivation_version" in (0, 1));