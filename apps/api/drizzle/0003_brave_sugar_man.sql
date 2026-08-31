CREATE TYPE "public"."calendar_extraction_job_status" AS ENUM('staging', 'queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "calendar_extraction_jobs" (
	"calendar_id" uuid PRIMARY KEY NOT NULL,
	"status" "calendar_extraction_job_status" DEFAULT 'staging' NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"result_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "calendar_extraction_jobs_attempt_count_check" CHECK ("calendar_extraction_jobs"."attempt_count" >= 0),
	CONSTRAINT "calendar_extraction_jobs_lease_check" CHECK ("calendar_extraction_jobs"."status" <> 'processing' or ("calendar_extraction_jobs"."lease_token" is not null and "calendar_extraction_jobs"."lease_expires_at" is not null)),
	CONSTRAINT "calendar_extraction_jobs_hash_check" CHECK ("calendar_extraction_jobs"."result_hash" is null or "calendar_extraction_jobs"."result_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "calendar_extraction_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_extraction_jobs" ADD CONSTRAINT "calendar_extraction_jobs_calendar_id_academic_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."academic_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_extraction_jobs_recovery_idx" ON "calendar_extraction_jobs" USING btree ("status","lease_expires_at","created_at");