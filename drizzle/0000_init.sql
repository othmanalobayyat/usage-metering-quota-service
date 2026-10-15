CREATE TYPE "public"."plan_type" AS ENUM('ACCOUNT', 'USER');--> statement-breakpoint
CREATE TYPE "public"."reason_code" AS ENUM('PER_REQUEST_LIMIT_EXCEEDED', 'MONTHLY_LIMIT_EXCEEDED');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('ACCEPTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."rule_owner" AS ENUM('ACCOUNT', 'USER');--> statement-breakpoint
CREATE TABLE "account_usage" (
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_usage_account_id_month_pk" PRIMARY KEY("account_id","month"),
	CONSTRAINT "account_usage_month_check" CHECK (EXTRACT(DAY FROM "account_usage"."month") = 1),
	CONSTRAINT "account_usage_units_used_check" CHECK ("account_usage"."units_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" char(64) NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "accounts_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"type" "plan_type" NOT NULL,
	"monthly_limit" integer NOT NULL,
	"per_request_limit" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plans_account_id_name_unique" UNIQUE NULLS NOT DISTINCT("account_id","name"),
	CONSTRAINT "plans_monthly_limit_check" CHECK ("plans"."monthly_limit" >= 0),
	CONSTRAINT "plans_per_request_limit_check" CHECK ("plans"."per_request_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"units" integer NOT NULL,
	"month" date NOT NULL,
	"status" "request_status" NOT NULL,
	"reason_code" "reason_code",
	"rejected_by" "rule_owner",
	"limit_value" integer,
	"account_plan_id" uuid NOT NULL,
	"user_plan_id" uuid NOT NULL,
	"remaining_account" integer NOT NULL,
	"remaining_user" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "requests_account_id_request_id_unique" UNIQUE("account_id","request_id"),
	CONSTRAINT "requests_units_check" CHECK ("requests"."units" > 0),
	CONSTRAINT "requests_month_check" CHECK (EXTRACT(DAY FROM "requests"."month") = 1),
	CONSTRAINT "requests_remaining_account_check" CHECK ("requests"."remaining_account" >= 0),
	CONSTRAINT "requests_remaining_user_check" CHECK ("requests"."remaining_user" >= 0),
	CONSTRAINT "requests_status_decision_check" CHECK ((
        "requests"."status" = 'ACCEPTED'
        AND "requests"."reason_code" IS NULL
        AND "requests"."rejected_by" IS NULL
        AND "requests"."limit_value" IS NULL
      ) OR (
        "requests"."status" = 'REJECTED'
        AND "requests"."reason_code" IS NOT NULL
        AND "requests"."rejected_by" IS NOT NULL
        AND "requests"."limit_value" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "user_usage" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_usage_user_id_month_pk" PRIMARY KEY("user_id","month"),
	CONSTRAINT "user_usage_month_check" CHECK (EXTRACT(DAY FROM "user_usage"."month") = 1),
	CONSTRAINT "user_usage_units_used_check" CHECK ("user_usage"."units_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"name" text,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_account_id_external_user_id_unique" UNIQUE("account_id","external_user_id"),
	CONSTRAINT "users_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_plan_id_plans_id_fk" FOREIGN KEY ("account_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_plan_id_plans_id_fk" FOREIGN KEY ("user_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_id_user_id_users_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_account_id_user_id_users_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_account_id_created_at_id_idx" ON "requests" USING btree ("account_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "requests_account_id_month_created_at_id_idx" ON "requests" USING btree ("account_id","month","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "requests_account_id_user_id_created_at_id_idx" ON "requests" USING btree ("account_id","user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "users_account_id_created_at_id_idx" ON "users" USING btree ("account_id","created_at","id");