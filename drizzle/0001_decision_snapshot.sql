ALTER TABLE "requests" ADD COLUMN "account_monthly_limit" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "account_per_request_limit" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "account_used_before" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "user_monthly_limit" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "user_per_request_limit" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "user_used_before" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_snapshot_check" CHECK ((
        "requests"."account_monthly_limit" IS NULL
        AND "requests"."account_per_request_limit" IS NULL
        AND "requests"."account_used_before" IS NULL
        AND "requests"."user_monthly_limit" IS NULL
        AND "requests"."user_per_request_limit" IS NULL
        AND "requests"."user_used_before" IS NULL
      ) OR (
        "requests"."account_monthly_limit" IS NOT NULL AND "requests"."account_monthly_limit" >= 0
        AND "requests"."account_per_request_limit" IS NOT NULL AND "requests"."account_per_request_limit" > 0
        AND "requests"."account_used_before" IS NOT NULL AND "requests"."account_used_before" >= 0
        AND "requests"."user_monthly_limit" IS NOT NULL AND "requests"."user_monthly_limit" >= 0
        AND "requests"."user_per_request_limit" IS NOT NULL AND "requests"."user_per_request_limit" > 0
        AND "requests"."user_used_before" IS NOT NULL AND "requests"."user_used_before" >= 0
      ));