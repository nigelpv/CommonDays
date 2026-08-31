DROP INDEX "school_similarity_alerts_status_created_idx";--> statement-breakpoint
ALTER TABLE "school_similarity_alerts" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "school_similarity_alerts_recovery_idx" ON "school_similarity_alerts" USING btree ("status","next_attempt_at","created_at");