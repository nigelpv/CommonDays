CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TYPE "public"."school_similarity_alert_status" AS ENUM('queued', 'sent');--> statement-breakpoint
CREATE TABLE "school_similarity_alert_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"similar_school_id" text NOT NULL,
	"similarity_score" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_similarity_alert_matches_score_check" CHECK ("school_similarity_alert_matches"."similarity_score" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "school_similarity_alert_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "school_similarity_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_school_id" text NOT NULL,
	"status" "school_similarity_alert_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "school_similarity_alerts_attempt_count_check" CHECK ("school_similarity_alerts"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "school_similarity_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "normalized_name" text;--> statement-breakpoint
UPDATE "schools"
SET "normalized_name" = trim(
	regexp_replace(
		regexp_replace(lower(replace("name", '&', ' and ')), '[^a-z0-9]+', ' ', 'g'),
		'\s+',
		' ',
		'g'
	)
);--> statement-breakpoint
ALTER TABLE "schools" ALTER COLUMN "normalized_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "school_similarity_alert_matches" ADD CONSTRAINT "school_similarity_alert_matches_alert_id_school_similarity_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."school_similarity_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_similarity_alert_matches" ADD CONSTRAINT "school_similarity_alert_matches_similar_school_id_schools_id_fk" FOREIGN KEY ("similar_school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_similarity_alerts" ADD CONSTRAINT "school_similarity_alerts_created_school_id_schools_id_fk" FOREIGN KEY ("created_school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "school_similarity_alert_matches_alert_school_idx" ON "school_similarity_alert_matches" USING btree ("alert_id","similar_school_id");--> statement-breakpoint
CREATE INDEX "school_similarity_alert_matches_alert_idx" ON "school_similarity_alert_matches" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "school_similarity_alerts_created_school_idx" ON "school_similarity_alerts" USING btree ("created_school_id");--> statement-breakpoint
CREATE INDEX "school_similarity_alerts_status_created_idx" ON "school_similarity_alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "schools_normalized_name_trgm_idx" ON "schools" USING gin ("normalized_name" gin_trgm_ops);
