CREATE TYPE "public"."calendar_event_kind" AS ENUM('break', 'holiday', 'no_classes', 'term_boundary');--> statement-breakpoint
CREATE TYPE "public"."calendar_source_type" AS ENUM('screenshots', 'pdf', 'ical', 'manual', 'official_url');--> statement-breakpoint
CREATE TYPE "public"."calendar_status" AS ENUM('processing', 'published', 'needs_review', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('wrong_date', 'missing_date', 'wrong_name', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('submitted', 'reviewing', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."upload_file_type" AS ENUM('image', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploaded', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "academic_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"academic_year" varchar(7) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "calendar_status" DEFAULT 'processing' NOT NULL,
	"source_type" "calendar_source_type" NOT NULL,
	"official_source_url" text,
	"submitted_by" uuid,
	"extraction_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "academic_calendars_year_check" CHECK ("academic_calendars"."academic_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "academic_calendars_version_check" CHECK ("academic_calendars"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "calendar_event_kind" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"source_upload_id" uuid,
	"source_page" smallint,
	"raw_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_date_order_check" CHECK ("calendar_events"."end_date" >= "calendar_events"."start_date")
);
--> statement-breakpoint
CREATE TABLE "calendar_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"event_id" uuid,
	"reason" "report_reason" NOT NULL,
	"details" text NOT NULL,
	"suggested_name" text,
	"suggested_start_date" date,
	"suggested_end_date" date,
	"status" "report_status" DEFAULT 'submitted' NOT NULL,
	"submitted_by" uuid,
	"reviewed_by" uuid,
	"resolution_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendar_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"file_type" "upload_file_type" NOT NULL,
	"position" smallint NOT NULL,
	"storage_bucket" text NOT NULL,
	"storage_path" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64),
	"status" "upload_status" DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_uploads_position_check" CHECK ("calendar_uploads"."position" between 1 and 10),
	CONSTRAINT "calendar_uploads_byte_size_check" CHECK ("calendar_uploads"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" varchar(64) NOT NULL,
	"location" text NOT NULL,
	"initials" varchar(3) NOT NULL,
	"color" varchar(7) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_color_hex_check" CHECK ("schools"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD CONSTRAINT "academic_calendars_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_source_upload_id_calendar_uploads_id_fk" FOREIGN KEY ("source_upload_id") REFERENCES "public"."calendar_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reports" ADD CONSTRAINT "calendar_reports_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reports" ADD CONSTRAINT "calendar_reports_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_uploads" ADD CONSTRAINT "calendar_uploads_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_calendars_school_year_version_idx" ON "academic_calendars" USING btree ("school_id","academic_year","version");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_calendars_one_published_idx" ON "academic_calendars" USING btree ("school_id","academic_year") WHERE "academic_calendars"."status" = 'published';--> statement-breakpoint
CREATE INDEX "academic_calendars_lookup_idx" ON "academic_calendars" USING btree ("school_id","academic_year","status");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_natural_key_idx" ON "calendar_events" USING btree ("calendar_id","name","start_date","end_date");--> statement-breakpoint
CREATE INDEX "calendar_events_date_lookup_idx" ON "calendar_events" USING btree ("calendar_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "calendar_reports_status_created_idx" ON "calendar_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "calendar_reports_calendar_idx" ON "calendar_reports" USING btree ("calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_uploads_storage_path_idx" ON "calendar_uploads" USING btree ("storage_path");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_uploads_calendar_position_idx" ON "calendar_uploads" USING btree ("calendar_id","position");--> statement-breakpoint
CREATE INDEX "schools_name_idx" ON "schools" USING btree ("name");