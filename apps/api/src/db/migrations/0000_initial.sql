-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Liaison kernel schema — single canonical migration (RLS-by-default, hardened)
-- Squashed from 0000–0002 + enforce-rls-by-default + 2026-04-05 hardening review
-- Generated 2026-04-05

CREATE SCHEMA "kernel";

--> statement-breakpoint
CREATE TYPE "kernel"."app_status" AS ENUM('active', 'disabled', 'error');
--> statement-breakpoint
CREATE TYPE "kernel"."actor_type" AS ENUM('user', 'agent', 'system', 'mcp');
--> statement-breakpoint
CREATE TYPE "kernel"."device_flow_state" AS ENUM('pending', 'approved', 'denied', 'expired');
--> statement-breakpoint
CREATE TYPE "kernel"."user_status" AS ENUM('active', 'suspended', 'deactivated');

--> statement-breakpoint
-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE "kernel"."organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "business_hours" jsonb DEFAULT '{"start":"09:00","end":"18:00","days":[1,2,3,4,5]}'::jsonb NOT NULL,
  "default_locale" text DEFAULT 'en-US' NOT NULL,
  "tier" text DEFAULT 'starter' NOT NULL,
  "settings" jsonb DEFAULT '{"fileSizeLimitMb":50,"storageQuotaGb":10,"auditRetentionDays":90}'::jsonb NOT NULL,
  "update_checks_enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);

--> statement-breakpoint
CREATE TABLE "kernel"."users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "email" text NOT NULL,
  "password_hash" text,
  "totp_secret" text,
  "totp_enabled" boolean DEFAULT false NOT NULL,
  "totp_last_used_at" timestamp with time zone,
  "recovery_codes" jsonb,
  "name" text NOT NULL,
  "avatar_url" text,
  "timezone" text,
  "locale" text,
  "status" "kernel"."user_status" DEFAULT 'active' NOT NULL,
  "auth_version" integer DEFAULT 1 NOT NULL,
  "permission_version" integer DEFAULT 1 NOT NULL,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "invited_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "status" "kernel"."app_status" DEFAULT 'active' NOT NULL,
  "config" jsonb,
  "schema_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_id" uuid,
  "actor_type" "kernel"."actor_type" NOT NULL,
  "app" text,
  "entity_type" text,
  "entity_id" text,
  "action" text NOT NULL,
  "changes" jsonb,
  "metadata" jsonb,
  "event_id" uuid
);

--> statement-breakpoint
CREATE TABLE "kernel"."contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "handle" text NOT NULL,
  "name" text,
  "email" text,
  "phone" text,
  "company" text,
  "external_ids" jsonb DEFAULT '{}'::jsonb,
  "metadata" jsonb,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Contact segments — a stored jsonb filter predicate evaluated LIVE against
-- kernel.contacts (tag containment + an optional minSpend resolved from the
-- Shopify customers_search amountSpent). Org-scoped; RLS below.
CREATE TABLE "kernel"."contact_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."device_flow_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "device_code" text NOT NULL,
  "user_code" text NOT NULL,
  "client_id" text NOT NULL,
  "state" "kernel"."device_flow_state" DEFAULT 'pending' NOT NULL,
  "user_id" uuid,
  "scopes" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "device_flow_requests_device_code_unique" UNIQUE("device_code")
);

--> statement-breakpoint
CREATE TABLE "kernel"."invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "invited_by" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."oauth_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "issuer_url" text NOT NULL,
  "authorization_endpoint" text,
  "token_endpoint" text,
  "userinfo_endpoint" text,
  "client_id" text NOT NULL,
  "client_secret_encrypted" text NOT NULL,
  "scopes" text,
  "auto_provision" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."oauth_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "external_subject" text NOT NULL,
  "external_email" text,
  "external_profile" jsonb,
  "org_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."password_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "device_info" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_grace" boolean DEFAULT false NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."timeline_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "app" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "actor_id" uuid,
  "actor_type" "kernel"."actor_type" NOT NULL,
  "action" text NOT NULL,
  "summary" text NOT NULL,
  "action_label" text,
  "field_changes" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "event_id" uuid
);

--> statement-breakpoint
CREATE TABLE "kernel"."role_scope_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "role_id" uuid NOT NULL,
  "scope" text NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."role_dimension_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "role_id" uuid NOT NULL,
  "dimension_key" text NOT NULL,
  "dimension_values" jsonb NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."user_roles" (
  "user_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);

--> statement-breakpoint
CREATE TABLE "kernel"."user_scope_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "scope" text NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."user_dimension_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "dimension_key" text NOT NULL,
  "dimension_values" jsonb NOT NULL
);

--> statement-breakpoint
-- Phase 16 Task A1 — audit trail for app-issued scope grants.
-- One row per setUserScopes() call. Bounded cardinality + queryable columns let
-- admins answer "which app granted Marie 'shopify:refunds:create' and when?"
-- without parsing JSON. Keys: app_name (calling app, forced by bridge),
-- target_user_id (the user whose scopes changed), scopes_set (post-call state),
-- scopes_added / scopes_removed (diff vs. pre-call state for the app's namespace).
CREATE TABLE "kernel"."app_scope_grant_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "app_name" text NOT NULL,
  "target_user_id" uuid NOT NULL,
  "scopes_set" text[] NOT NULL,
  "scopes_added" text[] NOT NULL,
  "scopes_removed" text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Phase 16 Task A2 — per-user attention subscriptions.
-- Default-on: a user with no rules for a given `source` receives every attention
-- item the existing recipient-resolver delivers. Once a user has any rule for
-- the source, narrowing kicks in: the kind must match (or the rule uses `*`),
-- and every declared filter axis must hold against the event's axes. Rules
-- *narrow* — they never widen what the producer-side recipient resolver
-- emitted.
CREATE TABLE "kernel"."attention_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "source" text NOT NULL,
  "kinds" text[] NOT NULL,
  "filters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "handle" text NOT NULL,
  "title" text,
  "is_pinned" boolean DEFAULT false NOT NULL,
  "type" text DEFAULT 'thread' NOT NULL,
  "tainted" boolean DEFAULT false NOT NULL,
  -- When true, this thread is hidden from the global thread list
  -- (sidebar, search). Used for task-bound threads, agent_chats, and any
  -- other thread that lives WITHIN an entity by default. Users can
  -- "promote" a hidden thread to the list by flipping this flag to false.
  "hidden_from_list" boolean DEFAULT false NOT NULL,
  "agent_model_id" text,
  "agent_reasoning_levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_from" jsonb,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "threads_type_check" CHECK (type IN ('thread', 'agent_chat', 'approval', 'routine'))
);

--> statement-breakpoint
CREATE TABLE "kernel"."messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "author_type" text DEFAULT 'user' NOT NULL,
  "content" text NOT NULL,
  "mentions" jsonb,
  "metadata" jsonb,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."message_reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "emoji" text NOT NULL,
  "org_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."thread_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "org_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."thread_references" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL,
  "app" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "added_by" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "last_visited_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."user_thread_state" (
  "user_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "is_archived" boolean DEFAULT false NOT NULL,
  "is_muted" boolean DEFAULT false NOT NULL,
  "is_pinned" boolean DEFAULT false NOT NULL,
  "last_read_message_id" uuid,
  "last_read_at" timestamp with time zone,
  CONSTRAINT "user_thread_state_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);

--> statement-breakpoint
CREATE TABLE "kernel"."pending_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "claimed_by" text,
  "processed_at" timestamp with time zone,
  -- I-DB-2 — bigserial (int8): the outbox is on the write path of every
  -- mutation; a 32-bit serial wraps at ~2.1B inserts and every subsequent
  -- pending_events INSERT then fails (an outage, not graceful degradation).
  "seq" bigserial NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "failed_at" timestamp with time zone
);

--> statement-breakpoint
CREATE TABLE "kernel"."credit_balances" (
  "org_id" uuid PRIMARY KEY NOT NULL,
  "included_balance" numeric(16, 8) DEFAULT '0' NOT NULL,
  "purchased_balance" numeric(16, 8) DEFAULT '0' NOT NULL,
  "currency" text DEFAULT 'EUR' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_balances_purchased_nonneg" CHECK ("purchased_balance" >= 0),
  CONSTRAINT "credit_balances_included_nonneg" CHECK ("included_balance" >= 0)
);

--> statement-breakpoint
CREATE TABLE "kernel"."credit_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid,
  "type" text NOT NULL,
  "amount" numeric(16, 8) NOT NULL,
  "balance_after" numeric(16, 8) NOT NULL,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "raw_cost" numeric(16, 8),
  "description" text,
  "external_payment_ref" text,
  "cycle_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."model_pricing" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "model_id" text NOT NULL,
  "display_name" text NOT NULL,
  "input_cost_per_m" numeric(16, 8) NOT NULL,
  "output_cost_per_m" numeric(16, 8) NOT NULL,
  "context_window" integer NOT NULL,
  "auto_eligible" boolean DEFAULT false NOT NULL,
  "tier_minimum" text DEFAULT 'starter' NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."agent_user_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_user_memory_type_check"
    CHECK ("type" IN ('user','feedback','project','reference','_index'))
);

--> statement-breakpoint
CREATE TABLE "kernel"."approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "handle" text NOT NULL,
  "thread_id" uuid NOT NULL,
  "originating_thread_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "tool_params" jsonb NOT NULL,
  "current_payload" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "notify_user_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "approving_started_at" timestamp with time zone,
  "requested_by" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "summary" jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "decided_by" uuid,
  "decided_at" timestamp with time zone,
  "bundle_id" uuid,
  "bundle_position" integer,
  "depends_on_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kernel"."approved_handler_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "status" text NOT NULL CHECK (status IN ('started','succeeded','awaiting_output','failed_no_effect','ambiguous')),
  "external_ref" jsonb,
  "error" jsonb,
  "actor_id" uuid NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamp with time zone,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  CONSTRAINT approved_handler_executions_approval_request_id_tool_name_key
    UNIQUE (approval_request_id, tool_name)
);

--> statement-breakpoint
CREATE TABLE "kernel"."saved_views" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "app" text NOT NULL,
  "view_id" text NOT NULL,
  "manifest_key" text,
  "name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "owner_user_id" uuid,
  "shared_with_org" boolean NOT NULL DEFAULT false,
  "is_default" boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chk_owner_or_default CHECK ((owner_user_id IS NOT NULL) OR (is_default AND shared_with_org))
);

--> statement-breakpoint
CREATE TABLE "kernel"."system_config" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Agent skills (Claude-Code-style markdown skills) — see docs/spec.md "Skills".
-- Per-org, optionally per-user-private (authorUserId NULL = org-shared).
CREATE TABLE "kernel"."skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "author_user_id" uuid,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "required_scopes" text[] NOT NULL DEFAULT '{}'::text[],
  "forked_from" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "auto_attach" jsonb,
  "created_by_user_id" uuid,
  "created_by_actor_type" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "skills_description_len_chk" CHECK (length(description) <= 100),
  CONSTRAINT "skills_body_min_chk" CHECK (length(body) >= 1),
  CONSTRAINT "skills_created_by_actor_type_chk"
    CHECK (created_by_actor_type IN ('user','agent','mcp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_unique_owner_name_idx" ON "kernel"."skills"
  ("org_id", COALESCE("author_user_id", '00000000-0000-0000-0000-000000000000'::uuid), "name");
--> statement-breakpoint
CREATE INDEX "skills_org_author_idx" ON "kernel"."skills" ("org_id", "author_user_id");

--> statement-breakpoint
-- Org/user toggles for built-in app-provided skills (declarative disable list).
-- userId NULL = org-wide disable; non-null = single-user disable.
CREATE TABLE "kernel"."disabled_app_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid,
  "app_name" text NOT NULL,
  "skill_name" text NOT NULL,
  "disabled_by" text NOT NULL DEFAULT 'user',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "disabled_app_skills_disabled_by_chk" CHECK (disabled_by IN ('seed','user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "disabled_app_skills_unique_idx" ON "kernel"."disabled_app_skills"
  ("org_id", COALESCE("user_id", '00000000-0000-0000-0000-000000000000'::uuid), "app_name", "skill_name");
--> statement-breakpoint
CREATE INDEX "disabled_app_skills_org_app_idx" ON "kernel"."disabled_app_skills"
  ("org_id", "app_name", "skill_name");

--> statement-breakpoint
-- First-install marker for an app's Component-A asset seeding. One row per
-- (org_id, app_name); its presence makes default-disabled skill seeding a
-- strict first-install op so a user who enabled a default-off skill keeps it
-- enabled across every later reconcile/boot.
CREATE TABLE "kernel"."app_seeded_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "app_name" text NOT NULL,
  "seeded_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_seeded_assets_unique_idx" ON "kernel"."app_seeded_assets"
  ("org_id", "app_name");

--> statement-breakpoint
-- User-scheduled agent routines (cron-driven prompts).
CREATE TABLE "kernel"."routines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'recurring',
  "cron" text,
  "timezone" text,
  "run_at" timestamp with time zone,
  "event" text,
  "app_name" text,
  "template_key" text,
  "source_kind" text NOT NULL DEFAULT 'user',
  "prompt" text NOT NULL,
  "output_thread_id" uuid,
  "scopes" text[] NOT NULL,
  "visibility" text NOT NULL DEFAULT 'personal',
  "enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'active',
  "last_run_at" timestamp with time zone,
  "last_run_status" text,
  "last_run_error" text,
  "created_by_user_id" uuid,
  "created_by_actor_type" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "routines_status_chk"
    CHECK (status IN ('active','paused_scope_mismatch','paused_no_credits','paused_user','paused_app_disabled','completed')),
  CONSTRAINT "routines_kind_chk"
    CHECK (kind IN ('recurring','scheduled','event')),
  CONSTRAINT "routines_source_kind_chk"
    CHECK (source_kind IN ('user','app')),
  CONSTRAINT "routines_visibility_chk"
    CHECK (visibility IN ('personal','shared')),
  CONSTRAINT "routines_kind_columns_chk"
    CHECK (
      (kind = 'recurring' AND cron IS NOT NULL AND timezone IS NOT NULL AND run_at IS NULL)
      OR (kind = 'scheduled' AND run_at IS NOT NULL AND cron IS NULL AND timezone IS NULL)
      OR (kind = 'event' AND event IS NOT NULL AND cron IS NULL AND timezone IS NULL AND run_at IS NULL)
    ),
  CONSTRAINT "routines_created_by_actor_type_chk"
    CHECK (created_by_actor_type IN ('user','agent','mcp')),
  CONSTRAINT "routines_description_len_chk" CHECK (length(description) <= 200),
  CONSTRAINT "routines_prompt_min_chk" CHECK (length(prompt) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "routines_unique_owner_name_idx" ON "kernel"."routines"
  ("org_id", "owner_user_id", "name");
--> statement-breakpoint
CREATE INDEX "routines_org_owner_idx" ON "kernel"."routines" ("org_id", "owner_user_id");
--> statement-breakpoint
CREATE INDEX "routines_org_visibility_idx" ON "kernel"."routines" ("org_id", "visibility");

--> statement-breakpoint
CREATE TABLE "kernel"."auto_approve_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "conditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "limits" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requires_scope" text,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auto_approve_policies_org_tool_idx"
  ON "kernel"."auto_approve_policies" ("org_id", "tool_name");
--> statement-breakpoint
CREATE INDEX "auto_approve_policies_org_enabled_idx"
  ON "kernel"."auto_approve_policies" ("org_id", "enabled");
--> statement-breakpoint
-- approval_policies: the gate-TIGHTENING complement of auto_approve_policies
-- (BL-268). Each row escalates a tool's approval requirement (non-gated -> gated
-- via require_approval, 1-approver -> N-eyes via min_approvers). TIGHTEN-ONLY:
-- the evaluator takes MAX(built-in gating, policy gating) so a row can never
-- loosen. ORG-scoped (created_by informational).
CREATE TABLE "kernel"."approval_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "conditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "require_approval" boolean NOT NULL DEFAULT true,
  "min_approvers" integer NOT NULL DEFAULT 1,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_org_tool_idx"
  ON "kernel"."approval_policies" ("org_id", "tool_name");
--> statement-breakpoint
CREATE INDEX "approval_policies_org_enabled_idx"
  ON "kernel"."approval_policies" ("org_id", "enabled");

--> statement-breakpoint
-- Routine run history (one row per tick).
CREATE TABLE "kernel"."routine_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "routine_id" uuid NOT NULL,
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "status" text NOT NULL,
  "duration_ms" integer,
  "error" text,
  "turns_added" integer,
  CONSTRAINT "routine_runs_status_chk"
    CHECK (status IN ('succeeded','failed','skipped_no_credits','skipped_overlap','skipped_scope_mismatch','output_thread_recreated'))
);
--> statement-breakpoint
CREATE INDEX "routine_runs_routine_ran_idx" ON "kernel"."routine_runs" ("routine_id", "ran_at" DESC);

--> statement-breakpoint
-- Per-routine cross-tick scratch state (market-intel watchers). Org-scoped;
-- composite (routine_id, key) PK isolates one routine's state from another.
CREATE TABLE "kernel"."routine_state" (
  "routine_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "key" text NOT NULL,
  "value" jsonb,
  "content_hash" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "routine_state_pk" PRIMARY KEY ("routine_id", "key")
);

--> statement-breakpoint
-- ============================================================
-- Foreign keys
-- ============================================================

ALTER TABLE "kernel"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "kernel"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "kernel"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "kernel"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "kernel"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."role_dimension_grants" ADD CONSTRAINT "role_dimension_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "kernel"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."role_scope_grants" ADD CONSTRAINT "role_scope_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "kernel"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."thread_participants" ADD CONSTRAINT "thread_participants_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "kernel"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."thread_participants" ADD CONSTRAINT "thread_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "kernel"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."thread_references" ADD CONSTRAINT "thread_references_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "kernel"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "kernel"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kernel"."user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "kernel"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- FK constraints added by hardening review
ALTER TABLE kernel.oauth_accounts
  ADD CONSTRAINT oauth_accounts_provider_fk
  FOREIGN KEY (provider_id) REFERENCES kernel.oauth_providers(id) ON DELETE CASCADE;
--> statement-breakpoint
-- I-DB-4 — org/user referential integrity + cascade on the OAuth-identity table.
ALTER TABLE kernel.oauth_accounts
  ADD CONSTRAINT oauth_accounts_org_fk
  FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.oauth_accounts
  ADD CONSTRAINT oauth_accounts_user_fk
  FOREIGN KEY (user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.invitations
  ADD CONSTRAINT invitations_role_fk
  FOREIGN KEY (role_id) REFERENCES kernel.roles(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE kernel.user_thread_state
  ADD CONSTRAINT uts_thread_fk
  FOREIGN KEY (thread_id) REFERENCES kernel.threads(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Session, invitation, and org FK constraints (review hardening)
ALTER TABLE kernel.users
  ADD CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id);
--> statement-breakpoint
ALTER TABLE kernel.sessions
  ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.sessions
  ADD CONSTRAINT sessions_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.invitations
  ADD CONSTRAINT invitations_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.invitations
  ADD CONSTRAINT invitations_invited_by_fk FOREIGN KEY (invited_by) REFERENCES kernel.users(id) ON DELETE RESTRICT;
--> statement-breakpoint
-- FK constraints for all org-scoped tables (referential integrity)
ALTER TABLE kernel.roles
  ADD CONSTRAINT roles_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.apps
  ADD CONSTRAINT apps_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.audit_log
  ADD CONSTRAINT audit_log_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.contacts
  ADD CONSTRAINT contacts_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.contact_segments
  ADD CONSTRAINT contact_segments_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.contact_segments
  ADD CONSTRAINT contact_segments_created_by_fk FOREIGN KEY (created_by) REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- NOTE: device_flow_requests.org_id is a SENTINEL until approval binds the real
-- org. Both the login device-flow (device-flow-routes.ts) and the MCP device
-- grant (device-grant-routes.ts) insert org_id = PLACEHOLDER_ORG_ID
-- ('00000000-…') at /initiate time — before any org is known — and the
-- authenticated approve handler rebinds it to the approver's real org. A FK to
-- kernel.organizations(id) would reject the placeholder insert (no such org
-- row), 500-ing every device-flow initiate. The rows are short-lived (15-min
-- TTL, single-consume) so the org-delete cascade is non-essential; the approve
-- handler enforces org binding. Hence: no FK on device_flow_requests.org_id.
--> statement-breakpoint
ALTER TABLE kernel.oauth_providers
  ADD CONSTRAINT oauth_providers_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.password_resets
  ADD CONSTRAINT password_resets_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.timeline_entries
  ADD CONSTRAINT timeline_entries_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.role_scope_grants
  ADD CONSTRAINT role_scope_grants_role_fk FOREIGN KEY (role_id) REFERENCES kernel.roles(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.role_dimension_grants
  ADD CONSTRAINT role_dimension_grants_role_fk FOREIGN KEY (role_id) REFERENCES kernel.roles(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.user_roles
  ADD CONSTRAINT user_roles_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.user_scope_grants
  ADD CONSTRAINT user_scope_grants_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.user_dimension_grants
  ADD CONSTRAINT user_dimension_grants_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.app_scope_grant_audit
  ADD CONSTRAINT app_scope_grant_audit_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.app_scope_grant_audit
  ADD CONSTRAINT app_scope_grant_audit_user_fk FOREIGN KEY (target_user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_scope_grant_audit_user_idx ON kernel.app_scope_grant_audit (org_id, target_user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_scope_grant_audit_app_idx ON kernel.app_scope_grant_audit (org_id, app_name, created_at DESC);
--> statement-breakpoint
-- B9 — app_scope_grant_audit is org-scoped (records who-granted-which-scopes-to-
-- whom) and is swept by the blanket `GRANT … ON ALL TABLES IN SCHEMA kernel TO
-- liaison_rls`. Without RLS + a policy, every tenant request and every sandboxed
-- app handler (modules/permissions/app-grants.ts writes it via an RlsClient)
-- could read/modify/delete every org's permission-grant audit rows. Enable +
-- FORCE RLS, scope SELECT/INSERT to the current org, and REVOKE UPDATE/DELETE so
-- this security audit trail is append-only and tenant-isolated.
ALTER TABLE kernel.app_scope_grant_audit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.app_scope_grant_audit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_scope_grant_audit_select ON kernel.app_scope_grant_audit
  FOR SELECT TO liaison_rls USING (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY app_scope_grant_audit_insert ON kernel.app_scope_grant_audit
  FOR INSERT TO liaison_rls WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON kernel.app_scope_grant_audit FROM liaison_rls;
--> statement-breakpoint
ALTER TABLE kernel.attention_subscriptions
  ADD CONSTRAINT attention_subscriptions_user_fk FOREIGN KEY (user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Phase 16 Task A8a — one rule per (user_id, source). The Settings →
-- Attention preferences page models a single "master" rule per source; a user
-- wanting multiple disjoint rules for the same source would refine `kinds` +
-- `filters` on that one row. Enforced as UNIQUE so POSTing a duplicate
-- surfaces as 409 (the REST route catches `cause.code === '23505'`).
CREATE UNIQUE INDEX IF NOT EXISTS attention_subscriptions_user_source_idx
  ON kernel.attention_subscriptions (user_id, source);
--> statement-breakpoint
ALTER TABLE kernel.attention_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.attention_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attention_subscriptions_user_rls ON kernel.attention_subscriptions FOR ALL TO liaison_rls
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE kernel.threads
  ADD CONSTRAINT threads_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.messages
  ADD CONSTRAINT messages_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.message_reactions
  ADD CONSTRAINT message_reactions_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.thread_participants
  ADD CONSTRAINT thread_participants_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.thread_references
  ADD CONSTRAINT thread_references_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.user_thread_state
  ADD CONSTRAINT user_thread_state_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.pending_events
  ADD CONSTRAINT pending_events_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.credit_balances
  ADD CONSTRAINT credit_balances_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.credit_transactions
  ADD CONSTRAINT credit_transactions_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.credit_transactions
  ADD CONSTRAINT credit_transactions_user_fk FOREIGN KEY (user_id) REFERENCES kernel.users(id);
--> statement-breakpoint
ALTER TABLE kernel.agent_user_memory
  ADD CONSTRAINT agent_user_memory_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.agent_user_memory
  ADD CONSTRAINT agent_user_memory_user_fk FOREIGN KEY (user_id) REFERENCES kernel.users(id);
--> statement-breakpoint
ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_thread_fk FOREIGN KEY (thread_id) REFERENCES kernel.threads(id);
--> statement-breakpoint
ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_requested_by_fk FOREIGN KEY (requested_by) REFERENCES kernel.users(id);
--> statement-breakpoint
ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_decided_by_fk FOREIGN KEY (decided_by) REFERENCES kernel.users(id);
--> statement-breakpoint
ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_originating_thread_fk FOREIGN KEY (originating_thread_id) REFERENCES kernel.threads(id) ON DELETE RESTRICT;

ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_depends_on_fk FOREIGN KEY (depends_on_id) REFERENCES kernel.approval_requests(id);
--> statement-breakpoint
ALTER TABLE kernel.approved_handler_executions
  ADD CONSTRAINT approved_handler_executions_approval_request_fk FOREIGN KEY (approval_request_id) REFERENCES kernel.approval_requests(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE kernel.approved_handler_executions
  ADD CONSTRAINT approved_handler_executions_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.approved_handler_executions
  ADD CONSTRAINT approved_handler_executions_actor_fk FOREIGN KEY (actor_id) REFERENCES kernel.users(id);
--> statement-breakpoint
ALTER TABLE kernel.saved_views
  ADD CONSTRAINT saved_views_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.saved_views
  ADD CONSTRAINT saved_views_owner_user_fk FOREIGN KEY (owner_user_id) REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Skills + routines FKs
ALTER TABLE kernel.skills
  ADD CONSTRAINT skills_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.skills
  ADD CONSTRAINT skills_author_user_fk FOREIGN KEY (author_user_id) REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE kernel.skills
  ADD CONSTRAINT skills_created_by_user_fk FOREIGN KEY (created_by_user_id) REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE kernel.disabled_app_skills
  ADD CONSTRAINT disabled_app_skills_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.disabled_app_skills
  ADD CONSTRAINT disabled_app_skills_user_fk FOREIGN KEY (user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.app_seeded_assets
  ADD CONSTRAINT app_seeded_assets_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_owner_user_fk FOREIGN KEY (owner_user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_output_thread_fk FOREIGN KEY (output_thread_id) REFERENCES kernel.threads(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_created_by_user_fk FOREIGN KEY (created_by_user_id) REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs
  ADD CONSTRAINT routine_runs_routine_fk FOREIGN KEY (routine_id) REFERENCES kernel.routines(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.routine_state
  ADD CONSTRAINT routine_state_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.routine_state
  ADD CONSTRAINT routine_state_routine_fk FOREIGN KEY (routine_id) REFERENCES kernel.routines(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.auto_approve_policies
  ADD CONSTRAINT auto_approve_policies_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.auto_approve_policies
  ADD CONSTRAINT auto_approve_policies_created_by_fk FOREIGN KEY (created_by) REFERENCES kernel.users(id) ON DELETE SET NULL;

ALTER TABLE kernel.approval_policies
  ADD CONSTRAINT approval_policies_org_fk FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;

ALTER TABLE kernel.approval_policies
  ADD CONSTRAINT approval_policies_created_by_fk FOREIGN KEY (created_by) REFERENCES kernel.users(id) ON DELETE SET NULL;

--> statement-breakpoint
-- ============================================================
-- Indexes
-- ============================================================

CREATE UNIQUE INDEX "apps_org_name_idx" ON "kernel"."apps" USING btree ("org_id","name");
--> statement-breakpoint
CREATE INDEX "audit_log_org_timestamp_idx" ON "kernel"."audit_log" USING btree ("org_id","timestamp");
--> statement-breakpoint
CREATE INDEX "audit_log_org_entity_idx" ON "kernel"."audit_log" USING btree ("org_id","entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "audit_log_org_actor_idx" ON "kernel"."audit_log" USING btree ("org_id","actor_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_event_id_idx" ON "kernel"."audit_log" ("event_id") WHERE event_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_org_email_idx" ON "kernel"."contacts" USING btree ("org_id","email");
--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_org_handle_idx" ON "kernel"."contacts" USING btree ("org_id","handle");
--> statement-breakpoint
CREATE INDEX "contacts_tags_gin" ON "kernel"."contacts" USING gin ("tags");
--> statement-breakpoint
CREATE INDEX "contact_segments_org_idx" ON "kernel"."contact_segments" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "kernel"."invitations" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token_hash_idx" ON "kernel"."password_resets" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_idx" ON "kernel"."invitations" ("org_id","email") WHERE accepted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_provider_subject_idx" ON "kernel"."oauth_accounts" USING btree ("provider_id","external_subject");
--> statement-breakpoint
CREATE INDEX "oauth_accounts_org_idx" ON "kernel"."oauth_accounts" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "role_dim_grants_role_idx" ON "kernel"."role_dimension_grants" USING btree ("role_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "role_dim_grants_role_dim_idx" ON "kernel"."role_dimension_grants" ("role_id","dimension_key");
--> statement-breakpoint
CREATE INDEX "role_scope_grants_role_idx" ON "kernel"."role_scope_grants" USING btree ("role_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_name_idx" ON "kernel"."roles" USING btree ("org_id","name");
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "kernel"."sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "timeline_org_entity_idx" ON "kernel"."timeline_entries" USING btree ("org_id","app","entity_type","entity_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_event_id_idx" ON "kernel"."timeline_entries" ("event_id") WHERE event_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "user_dim_grants_user_idx" ON "kernel"."user_dimension_grants" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "user_dim_grants_org_idx" ON "kernel"."user_dimension_grants" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "user_dim_grants_user_org_dim_idx" ON "kernel"."user_dimension_grants" ("user_id","org_id","dimension_key");
--> statement-breakpoint
CREATE INDEX "user_roles_org_idx" ON "kernel"."user_roles" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "user_scope_grants_user_idx" ON "kernel"."user_scope_grants" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "user_scope_grants_org_idx" ON "kernel"."user_scope_grants" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_idx" ON "kernel"."users" USING btree ("org_id","email");
--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_msg_user_emoji_idx" ON "kernel"."message_reactions" USING btree ("message_id","user_id","emoji");
--> statement-breakpoint
CREATE INDEX "message_reactions_org_idx" ON "kernel"."message_reactions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "kernel"."messages" USING btree ("thread_id","created_at");
--> statement-breakpoint
CREATE INDEX "messages_org_idx" ON "kernel"."messages" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_participants_thread_user_idx" ON "kernel"."thread_participants" USING btree ("thread_id","user_id");
--> statement-breakpoint
CREATE INDEX "thread_participants_user_idx" ON "kernel"."thread_participants" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "thread_participants_org_idx" ON "kernel"."thread_participants" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS routine_state_org_idx ON kernel.routine_state (org_id);
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_references_unique_idx" ON "kernel"."thread_references" USING btree ("thread_id","app","entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "thread_references_entity_idx" ON "kernel"."thread_references" USING btree ("app","entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "thread_references_thread_recent_idx" ON "kernel"."thread_references" USING btree ("thread_id","last_visited_at");
--> statement-breakpoint
CREATE INDEX "threads_org_updated_idx" ON "kernel"."threads" USING btree ("org_id","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "threads_org_handle_idx" ON "kernel"."threads" USING btree ("org_id","handle");
--> statement-breakpoint
CREATE INDEX "threads_org_type_updated_idx" ON "kernel"."threads" USING btree ("org_id","type","updated_at");
--> statement-breakpoint
CREATE INDEX "credit_transactions_org_created_idx" ON "kernel"."credit_transactions" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_txn_org_external_pay_uniq" ON "kernel"."credit_transactions" USING btree ("org_id","external_payment_ref") WHERE external_payment_ref IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_txn_org_cycle_uniq" ON "kernel"."credit_transactions" USING btree ("org_id","cycle_id") WHERE cycle_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_provider_model_idx" ON "kernel"."model_pricing" USING btree ("provider","model_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_user_memory_org_user_type_name_idx" ON "kernel"."agent_user_memory" USING btree ("org_id","user_id","type","name");
--> statement-breakpoint
CREATE INDEX "agent_user_memory_user_idx" ON "kernel"."agent_user_memory" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_org_handle_idx" ON "kernel"."approval_requests" USING btree ("org_id","handle");
--> statement-breakpoint
CREATE INDEX "approval_requests_org_status_idx" ON "kernel"."approval_requests" USING btree ("org_id","status");
--> statement-breakpoint
CREATE INDEX "approval_requests_org_status_expires_idx" ON "kernel"."approval_requests" USING btree ("org_id","status","expires_at");
--> statement-breakpoint
CREATE INDEX "approval_requests_notify_users_idx" ON "kernel"."approval_requests" USING gin ("notify_user_ids");
--> statement-breakpoint
CREATE INDEX "approval_requests_bundle_idx" ON "kernel"."approval_requests" USING btree ("bundle_id","bundle_position");
--> statement-breakpoint
-- Bundle position uniqueness: under READ COMMITTED two concurrent inserts into
-- the same bundle would both observe MAX(bundle_position)=N and both insert at
-- position N+1. The partial UNIQUE index turns the second insert into a
-- 23505 unique_violation that insertApprovalRow catches and retries with the
-- now-committed MAX+1. The partial WHERE keeps standalone (bundle_id NULL)
-- approvals unaffected.
CREATE UNIQUE INDEX "approval_requests_bundle_unique_position_idx"
  ON "kernel"."approval_requests" ("bundle_id", "bundle_position")
  WHERE "bundle_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "approval_requests_depends_on_idx" ON "kernel"."approval_requests" USING btree ("depends_on_id");
--> statement-breakpoint
CREATE INDEX "approved_handler_executions_request_idx" ON "kernel"."approved_handler_executions" USING btree ("approval_request_id");
--> statement-breakpoint
CREATE INDEX "approved_handler_executions_status_idx" ON "kernel"."approved_handler_executions" USING btree ("status","started_at");
--> statement-breakpoint
CREATE INDEX "saved_views_sidebar_idx" ON "kernel"."saved_views" USING btree ("org_id","app","view_id","owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_default_manifest_key_idx" ON "kernel"."saved_views" ("org_id","app","view_id","manifest_key") WHERE is_default = true AND manifest_key IS NOT NULL;

--> statement-breakpoint
-- ============================================================
-- Sequences
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS kernel.thread_handle_seq;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS kernel.contact_handle_seq;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS kernel.approval_request_handle_seq;

--> statement-breakpoint
-- ============================================================
-- Additional indexes (session cleanup, contact phone lookup)
-- ============================================================

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON kernel.sessions (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_phone_unique_idx ON kernel.contacts (org_id, phone) WHERE phone IS NOT NULL;
--> statement-breakpoint
-- GIN index on external_ids: lets resolveContact look up contacts by an app-keyed
-- external id (e.g. external_ids ? 'shopify' and external_ids @> '{"shopify":"gid://…"}')
-- without a sequential scan. Phase 16 Task A0 (Shopify plugin app).
CREATE INDEX IF NOT EXISTS contacts_external_ids_gin_idx ON kernel.contacts USING gin (external_ids);
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_token_hash_idx" ON "kernel"."sessions" USING btree ("refresh_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "role_scope_grants_role_scope_idx" ON "kernel"."role_scope_grants" USING btree ("role_id","scope");
--> statement-breakpoint
CREATE UNIQUE INDEX "user_scope_grants_user_org_scope_idx" ON "kernel"."user_scope_grants" USING btree ("user_id","org_id","scope");
--> statement-breakpoint
CREATE INDEX "device_flow_user_code_idx" ON "kernel"."device_flow_requests" USING btree ("user_code");
--> statement-breakpoint
-- user_code is the human-typed handle the approver enters; a collision among
-- concurrently-pending requests would let an approver bind a session to the
-- wrong device request (cross-account grant). Enforce uniqueness of user_code
-- among PENDING requests only (approved/denied/expired codes may be reused).
-- The initiate handler retries generation on the resulting 23505.
CREATE UNIQUE INDEX "device_flow_pending_user_code_uq" ON "kernel"."device_flow_requests" USING btree ("user_code") WHERE "state" = 'pending';
--> statement-breakpoint
CREATE INDEX "pending_events_unprocessed_idx" ON "kernel"."pending_events" USING btree ("seq") WHERE processed_at IS NULL AND failed_at IS NULL;
--> statement-breakpoint
CREATE INDEX "pending_events_recovery_idx" ON "kernel"."pending_events" ("claimed_at", "seq") WHERE processed_at IS NULL AND claimed_at IS NOT NULL;

--> statement-breakpoint
-- ============================================================
-- RLS role + grants (must exist BEFORE policies reference it)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    CREATE ROLE liaison_rls NOBYPASSRLS NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    CREATE ROLE liaison_admin NOBYPASSRLS NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    CREATE ROLE liaison_app NOBYPASSRLS NOLOGIN;
  END IF;
END $$;

--> statement-breakpoint
GRANT USAGE ON SCHEMA kernel TO liaison_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kernel TO liaison_rls;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA kernel TO liaison_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO liaison_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_rls;

-- Audit log immutability: liaison_rls cannot UPDATE/DELETE audit entries.
--> statement-breakpoint
REVOKE UPDATE, DELETE ON kernel.audit_log FROM liaison_rls;

-- Users: no DELETE via RLS. The table has per-command SELECT/INSERT/UPDATE
-- policies but deliberately no DELETE policy (user removal is a privileged
-- operation via liaison_admin/BYPASSRLS). Revoke the blanket DELETE grant so
-- the grant/policy state is consistent and an accidental RLS-context DELETE
-- fails loudly at the grant level instead of being silently swallowed by RLS
-- default-deny. Mirrors the audit_log/credit_balances handling above.
REVOKE DELETE ON kernel.users FROM liaison_rls;

-- Threads: no direct DELETE via RLS (thread archival/deletion is a privileged operation)
REVOKE DELETE ON kernel.threads FROM liaison_rls;
-- Thread participants: no UPDATE via RLS (role changes go through service layer)
REVOKE UPDATE ON kernel.thread_participants FROM liaison_rls;
-- Reactions: no UPDATE via RLS (reactions are add/remove only, not editable)
REVOKE UPDATE ON kernel.message_reactions FROM liaison_rls;
-- References: last_visited_at is refreshed on repeated visits; rows are never deleted.
REVOKE DELETE ON kernel.thread_references FROM liaison_rls;

-- Credit balances: read-only for liaison_rls (mutations via liaison_admin only)
REVOKE INSERT, UPDATE, DELETE ON kernel.credit_balances FROM liaison_rls;

-- Credit transactions: append-only, no updates or deletes
REVOKE UPDATE, DELETE ON kernel.credit_transactions FROM liaison_rls;
-- Also revoke INSERT — credit tx are written only via liaison_admin (credit service)
REVOKE INSERT ON kernel.credit_transactions FROM liaison_rls;

-- Model pricing: global reference, read-only for liaison_rls
REVOKE INSERT, UPDATE, DELETE ON kernel.model_pricing FROM liaison_rls;

-- Approval requests: no UPDATE or DELETE via liaison_rls (resolution is Phase 5)
REVOKE UPDATE, DELETE ON kernel.approval_requests FROM liaison_rls;

-- Approved handler executions: no liaison_rls access. Reads/writes via liaison_admin
-- (decide service, reaper, audit log).
REVOKE ALL ON kernel.approved_handler_executions FROM liaison_rls;

-- App-seeded-assets marker (Component A first-install idempotency): no liaison_rls
-- access. The reconciler writes/reads it only via withPrivilegedDb (liaison_admin
-- BYPASSRLS); RLS policies are not its protection boundary — the REVOKE is. This
-- is the explicit privileged-global boundary the RLS-completeness guard's
-- PRIVILEGED_GLOBAL_TABLES allowlist documents.
REVOKE ALL ON kernel.app_seeded_assets FROM liaison_rls;

-- System config: read-only for liaison_rls (writes via liaison_admin only)
REVOKE INSERT, UPDATE, DELETE ON kernel.system_config FROM liaison_rls;

--> statement-breakpoint
-- liaison_admin: BYPASSRLS role for withPrivilegedDb/withSystemDb
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    CREATE ROLE liaison_admin NOLOGIN;
  END IF;
END $$;
ALTER ROLE liaison_admin BYPASSRLS;
-- I-DB-5 — withSchemaAdmin() now runs app-schema DDL (CREATE SCHEMA / TABLE /
-- POLICY) as liaison_admin. It therefore needs CREATE ON DATABASE so
-- `CREATE SCHEMA app_<name>` succeeds at runtime. Granted dynamically so the
-- migration is portable across dev/test/prod DB names. Managed environments
-- where the migration runner is not the DB owner log a notice and continue —
-- the operator runs this GRANT manually as the DB owner.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO liaison_admin', current_database());
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'liaison_admin: could not GRANT CREATE ON DATABASE — run manually as DB owner';
END $$;
GRANT USAGE ON SCHEMA kernel TO liaison_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kernel TO liaison_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA kernel TO liaison_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO liaison_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_admin;

-- Allow the connection role (liaison_app or postgres) to assume liaison_admin and liaison_rls
-- via SET LOCAL ROLE. Without this GRANT, SET LOCAL ROLE fails with "permission denied".
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT liaison_admin TO liaison_app;
    GRANT liaison_rls TO liaison_app;
  END IF;
END $$;
-- Also grant to the bootstrap superuser when it exists (dev/test use `postgres`;
-- production self-hosted compose uses `liaison`). Skip silently when the role
-- doesn't exist so this migration is portable across env shapes.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    GRANT liaison_admin TO postgres;
    GRANT liaison_rls TO postgres;
  END IF;
END $$;
DO $$ BEGIN
  EXECUTE format('GRANT liaison_admin TO %I', current_user);
  EXECUTE format('GRANT liaison_rls TO %I', current_user);
END $$;

--> statement-breakpoint
-- liaison_schema_admin: dedicated role for app-schema DDL (CREATE SCHEMA,
-- GRANT, CREATE TABLE, CREATE POLICY). Separated from liaison_admin so
-- "BYPASSRLS for runtime mutations" and "schema DDL" are distinct privilege
-- floors. Used by withSchemaAdmin() in apps/api/src/db/privileged.ts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_schema_admin') THEN
    CREATE ROLE liaison_schema_admin NOLOGIN;
  END IF;
END $$;

-- DDL capability without BYPASSRLS. GRANT CREATE on the current database
-- dynamically so the migration is portable across dev/test/prod DB names.
-- Production-managed environments where the migration runner is not the DB
-- owner will log a notice and continue — the operator must run this GRANT
-- manually as the DB owner.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO liaison_schema_admin', current_database());
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'liaison_schema_admin: could not GRANT CREATE ON DATABASE — run manually as DB owner';
END $$;

-- Let liaison_schema_admin GRANT table/sequence access to the two runtime
-- roles when it creates per-app schemas (so liaison_rls / liaison_admin can
-- access app tables without further elevation).
GRANT liaison_rls TO liaison_schema_admin;
GRANT liaison_admin TO liaison_schema_admin;

-- Allow the connection role (liaison_app or postgres) to assume it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT liaison_schema_admin TO liaison_app;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    GRANT liaison_schema_admin TO postgres;
  END IF;
END $$;
DO $$ BEGIN
  EXECUTE format('GRANT liaison_schema_admin TO %I', current_user);
END $$;

-- Ensure roles can connect to this database (required for SET LOCAL ROLE at runtime)
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO liaison_rls', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO liaison_admin', current_database());
END $$;

-- Grant the app user direct access so it is not limited to liaison_rls
-- permissions when running outside RLS context (session mgmt, cleanup, etc.)
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT USAGE ON SCHEMA kernel TO liaison_app;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON ALL TABLES IN SCHEMA kernel TO liaison_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA kernel TO liaison_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kernel
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON TABLES TO liaison_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kernel
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_app;
  END IF;
END $$;
-- Also grant REFERENCES to the runtime roles so app DDL can reference kernel tables.
GRANT REFERENCES ON ALL TABLES IN SCHEMA kernel TO liaison_admin, liaison_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT REFERENCES ON TABLES TO liaison_admin, liaison_rls;

--> statement-breakpoint
-- ============================================================
-- Row-level security — ENABLE on ALL org-scoped tables
-- ============================================================
-- Convention: current_setting('...', true) returns '' if GUC not set.
-- The subsequent ::uuid cast on '' throws "invalid input syntax",
-- which is fail-closed. All policies target TO liaison_rls (not PUBLIC).

ALTER TABLE kernel.users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.contact_segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.timeline_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.user_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.role_scope_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.role_dimension_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.user_scope_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.user_dimension_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.apps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.password_resets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.device_flow_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.oauth_providers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.oauth_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.thread_participants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.message_reactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.thread_references ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.user_thread_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.credit_balances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.credit_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.model_pricing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.agent_user_memory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.approval_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.approved_handler_executions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.saved_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.system_config ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.disabled_app_skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- app_seeded_assets is written/read only by the privileged reconciler
-- (liaison_admin BYPASSRLS); enable RLS with no permissive policy so no
-- request-scoped role can read or write it.
ALTER TABLE kernel.app_seeded_assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.routines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.routine_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.routine_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.auto_approve_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.approval_policies ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
-- FORCE RLS so even the table owner is subject to policies
ALTER TABLE kernel.users FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.contact_segments FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.timeline_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.role_scope_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.role_dimension_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_scope_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_dimension_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.apps FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.password_resets FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.device_flow_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.oauth_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.oauth_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.threads FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.thread_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.message_reactions FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.thread_references FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_thread_state FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.credit_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.credit_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.model_pricing FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.agent_user_memory FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.approval_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.approved_handler_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.saved_views FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.system_config FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.skills FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.disabled_app_skills FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.routines FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.routine_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.routine_state FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.auto_approve_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE kernel.approval_policies FORCE ROW LEVEL SECURITY;

--> statement-breakpoint
-- Organizations: no org_id, deny liaison_rls direct access
ALTER TABLE kernel.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_deny_rls ON kernel.organizations FOR ALL TO liaison_rls
  USING (false) WITH CHECK (false);

--> statement-breakpoint
ALTER TABLE kernel.pending_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.pending_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.pending_events TO liaison_admin;
GRANT INSERT ON kernel.pending_events TO liaison_rls;
CREATE POLICY pending_events_insert_only ON kernel.pending_events FOR INSERT TO liaison_rls
  WITH CHECK (true);

--> statement-breakpoint
-- ============================================================
-- Simple org-scope policies (tables with direct org_id column)
-- ============================================================

-- SELECT: any org member may read all users in the same org.
CREATE POLICY users_select_rls ON kernel.users
  FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
-- INSERT: only the app layer (liaison_app, not liaison_rls) inserts users;
--         this policy prevents rogue RLS-session inserts for a foreign org.
CREATE POLICY users_insert_rls ON kernel.users
  FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
-- UPDATE: a user may update their OWN row (this policy). Admin sessions may
--         update any same-org user row via users_update_admin_rls (defined
--         below, after kernel.session_is_admin) — notably the permission_version
--         bumps that role/scope mutations issue for OTHER users, which run under
--         liaison_rls (not the BYPASSRLS admin connection). Permissive policies
--         are OR-combined, so the two cover self-edit + admin user-management.
CREATE POLICY users_update_rls ON kernel.users
  FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND id = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND id = current_setting('app.current_user_id', true)::uuid
  );
--> statement-breakpoint
CREATE POLICY contacts_org_rls ON kernel.contacts
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY contact_segments_org_rls ON kernel.contact_segments
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY timeline_org_rls ON kernel.timeline_entries
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY invitations_org_rls ON kernel.invitations
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY roles_org_rls ON kernel.roles
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY user_roles_org_rls ON kernel.user_roles
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- ============================================================
-- Scope-grant privilege backstop
-- ============================================================
-- The grant tables (user_scope_grants / role_scope_grants) were gated only on
-- org_id, so any liaison_rls session — including a sandboxed app or a non-admin
-- user — could INSERT a row granting itself a privileged scope (e.g.
-- 'kernel:users:admin' or the '*' superscope), self-escalating. These two
-- helpers add a scope-level WITH CHECK so a PRIVILEGED scope can only be granted
-- by a session that already holds an admin scope. Namespaced app grants
-- (`<app>:*`) and ordinary feature scopes are unaffected.

-- A scope is privileged if it could confer cross-cutting kernel authority:
-- the global superscope, the bare kernel namespace, or any kernel:* scope.
-- App-namespaced scopes (`<app>:...`, including an app's own `<app>:x:admin`)
-- are NOT privileged here — they are already confined to that app's RLS and to
-- the calling app's namespace by setUserScopes, so the kernel backstop must not
-- block them or it would break legitimate app-issued grants.
CREATE OR REPLACE FUNCTION kernel.scope_is_privileged(_scope text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT _scope = '*'
      OR _scope = 'kernel'
      OR starts_with(_scope, 'kernel:')
$$;
--> statement-breakpoint
ALTER FUNCTION kernel.scope_is_privileged(text) OWNER TO liaison_admin;
--> statement-breakpoint

-- The current session holds an admin scope: the global superscope, the kernel
-- wildcard, the bare kernel namespace, or the kernel user-admin scope (the same
-- scope that gates the admin role/scope HTTP routes). BYPASSRLS admin
-- connections (liaison_admin) skip RLS entirely and never reach this check.
CREATE OR REPLACE FUNCTION kernel.session_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.current_scopes', true) = '*'
      OR EXISTS (
        SELECT 1
        FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
        WHERE g IN ('*', 'kernel', 'kernel:*', 'kernel:users:admin')
      )
$$;
--> statement-breakpoint
ALTER FUNCTION kernel.session_is_admin() OWNER TO liaison_admin;
--> statement-breakpoint

-- UPDATE (admin): an admin session may update any user row in its own org.
-- Required for the permission_version bumps that assignRole / unassignRole /
-- grantScope / revokeScope issue for OTHER users — those run under liaison_rls
-- (withRequestRls), so the own-row users_update_rls policy alone would match 0
-- rows and leave revoked scopes/roles effective in the auth cache until JWT
-- expiry. session_is_admin() requires the same kernel admin scope that gates the
-- role/scope HTTP routes, so this does not widen who may mutate users.
CREATE POLICY users_update_admin_rls ON kernel.users
  FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND kernel.session_is_admin()
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND kernel.session_is_admin()
  );
--> statement-breakpoint

CREATE POLICY user_scope_grants_org_rls ON kernel.user_scope_grants
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (NOT kernel.scope_is_privileged(scope) OR kernel.session_is_admin())
  );
--> statement-breakpoint
CREATE POLICY user_dim_grants_org_rls ON kernel.user_dimension_grants
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY apps_org_rls ON kernel.apps
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY sessions_org_rls ON kernel.sessions
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY password_resets_org_rls ON kernel.password_resets
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY device_flow_org_rls ON kernel.device_flow_requests
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY oauth_providers_org_rls ON kernel.oauth_providers
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY oauth_accounts_org_rls ON kernel.oauth_accounts
  FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- audit_log: SELECT + INSERT only for liaison_rls (UPDATE/DELETE revoked above)
CREATE POLICY audit_log_org_rls ON kernel.audit_log
  FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY audit_log_insert_rls ON kernel.audit_log
  FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

--> statement-breakpoint
-- ============================================================
-- FK-scoped policies (no org_id — scope via parent FK)
-- ============================================================

CREATE POLICY role_scope_grants_org_rls ON kernel.role_scope_grants
  FOR ALL TO liaison_rls
  USING (
    EXISTS (
      SELECT 1 FROM kernel.roles r
      WHERE r.id = role_scope_grants.role_id
        AND r.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM kernel.roles r
      WHERE r.id = role_scope_grants.role_id
        AND r.org_id = current_setting('app.current_org_id', true)::uuid
    )
    -- Granting a privileged scope to a role requires an admin session.
    AND (NOT kernel.scope_is_privileged(scope) OR kernel.session_is_admin())
  );
--> statement-breakpoint
CREATE POLICY role_dim_grants_org_rls ON kernel.role_dimension_grants
  FOR ALL TO liaison_rls
  USING (
    EXISTS (
      SELECT 1 FROM kernel.roles r
      WHERE r.id = role_dimension_grants.role_id
        AND r.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM kernel.roles r
      WHERE r.id = role_dimension_grants.role_id
        AND r.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

--> statement-breakpoint
-- ============================================================
-- Thread-table policies (participant-scoped, TO liaison_rls)
-- ============================================================

-- Threads: participant-only access (GDPR — no admin bypass)
CREATE POLICY threads_select ON kernel.threads FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = threads.id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);
--> statement-breakpoint
CREATE POLICY threads_insert ON kernel.threads FOR INSERT TO liaison_rls WITH CHECK (
  org_id = current_setting('app.current_org_id', true)::uuid
);
--> statement-breakpoint
CREATE POLICY threads_update ON kernel.threads FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = threads.id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
  );

--> statement-breakpoint
-- Messages: org + participant check
CREATE POLICY messages_select ON kernel.messages FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = messages.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);
--> statement-breakpoint
CREATE POLICY messages_insert ON kernel.messages FOR INSERT TO liaison_rls WITH CHECK (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND author_id = current_setting('app.current_user_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = messages.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);
--> statement-breakpoint
CREATE POLICY messages_update ON kernel.messages FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND author_id = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = messages.thread_id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

--> statement-breakpoint
CREATE POLICY messages_delete ON kernel.messages FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND author_id = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = messages.thread_id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );

--> statement-breakpoint
-- SECURITY DEFINER function to check thread participation without triggering RLS recursion.
-- Runs as the function owner (liaison_admin), bypassing RLS on the inner query.
CREATE OR REPLACE FUNCTION kernel.is_thread_participant(p_thread_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = kernel
AS $$
  SELECT EXISTS (
    SELECT 1 FROM kernel.thread_participants
    WHERE thread_id = p_thread_id AND user_id = p_user_id
  )
$$;
ALTER FUNCTION kernel.is_thread_participant(uuid, uuid) OWNER TO liaison_admin;
--> statement-breakpoint
-- Thread participants: org check + participant-scoped SELECT via SECURITY DEFINER helper.
-- The helper function bypasses RLS on the inner query, avoiding infinite recursion.
CREATE POLICY tp_select ON kernel.thread_participants FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND kernel.is_thread_participant(thread_id, current_setting('app.current_user_id', true)::uuid)
);
--> statement-breakpoint
CREATE POLICY tp_insert ON kernel.thread_participants FOR INSERT TO liaison_rls WITH CHECK (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (
    user_id = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (
      SELECT 1 FROM kernel.thread_participants tp2
      WHERE tp2.thread_id = thread_participants.thread_id
        AND tp2.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp2.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
);
--> statement-breakpoint
CREATE POLICY tp_delete ON kernel.thread_participants FOR DELETE TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (
    user_id = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (
      SELECT 1 FROM kernel.thread_participants tp2
      WHERE tp2.thread_id = thread_participants.thread_id
        AND tp2.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp2.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
);

--> statement-breakpoint
-- Reactions: org + participant via message join
CREATE POLICY reactions_select ON kernel.message_reactions FOR SELECT TO liaison_rls USING (
  EXISTS (
    SELECT 1 FROM kernel.messages m
    WHERE m.id = message_reactions.message_id
      AND m.org_id = current_setting('app.current_org_id', true)::uuid
      AND EXISTS (
        SELECT 1 FROM kernel.thread_participants tp
        WHERE tp.thread_id = m.thread_id
          AND tp.user_id = current_setting('app.current_user_id', true)::uuid
          AND tp.org_id = current_setting('app.current_org_id', true)::uuid
      )
  )
);
--> statement-breakpoint
CREATE POLICY reactions_insert ON kernel.message_reactions FOR INSERT TO liaison_rls WITH CHECK (
  user_id = current_setting('app.current_user_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.messages m
    WHERE m.id = message_reactions.message_id
      AND m.org_id = current_setting('app.current_org_id', true)::uuid
      AND EXISTS (
        SELECT 1 FROM kernel.thread_participants tp
        WHERE tp.thread_id = m.thread_id
          AND tp.user_id = current_setting('app.current_user_id', true)::uuid
          AND tp.org_id = current_setting('app.current_org_id', true)::uuid
      )
  )
);
--> statement-breakpoint
CREATE POLICY reactions_delete ON kernel.message_reactions FOR DELETE TO liaison_rls USING (
  user_id = current_setting('app.current_user_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.messages m
    JOIN kernel.thread_participants tp ON tp.thread_id = m.thread_id
    WHERE m.id = message_reactions.message_id
      AND m.org_id = current_setting('app.current_org_id', true)::uuid
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);

--> statement-breakpoint
-- Thread references: org + participant membership
CREATE POLICY refs_select ON kernel.thread_references FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = thread_references.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);
--> statement-breakpoint
CREATE POLICY refs_insert ON kernel.thread_references FOR INSERT TO liaison_rls WITH CHECK (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = thread_references.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);
--> statement-breakpoint
CREATE POLICY refs_update ON kernel.thread_references FOR UPDATE TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = thread_references.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
) WITH CHECK (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = thread_references.thread_id
      AND tp.user_id = current_setting('app.current_user_id', true)::uuid
      AND tp.org_id = current_setting('app.current_org_id', true)::uuid
  )
);

--> statement-breakpoint
-- User thread state: user owns their own state
CREATE POLICY uts_select ON kernel.user_thread_state FOR SELECT TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND user_id = current_setting('app.current_user_id', true)::uuid
);
--> statement-breakpoint
CREATE POLICY uts_insert ON kernel.user_thread_state FOR INSERT TO liaison_rls WITH CHECK (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (
    -- Own state
    user_id = current_setting('app.current_user_id', true)::uuid
    OR
    -- Service creating state for new participant: actor must be participant
    -- AND the target user_id must also be a participant of that thread
    (
      EXISTS (
        SELECT 1 FROM kernel.thread_participants tp
        WHERE tp.thread_id = user_thread_state.thread_id
          AND tp.user_id = current_setting('app.current_user_id', true)::uuid
          AND tp.org_id = current_setting('app.current_org_id', true)::uuid
      )
      AND user_id IN (
        SELECT tp2.user_id FROM kernel.thread_participants tp2
        WHERE tp2.thread_id = user_thread_state.thread_id
          AND tp2.org_id = current_setting('app.current_org_id', true)::uuid
      )
    )
  )
);
--> statement-breakpoint
CREATE POLICY uts_update ON kernel.user_thread_state FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND user_id = current_setting('app.current_user_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY uts_delete ON kernel.user_thread_state FOR DELETE TO liaison_rls USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (
    -- Own state
    user_id = current_setting('app.current_user_id', true)::uuid
    OR
    -- Participant cleaning up removed participant's stale state
    EXISTS (
      SELECT 1 FROM kernel.thread_participants tp
      WHERE tp.thread_id = user_thread_state.thread_id
        AND tp.user_id = current_setting('app.current_user_id', true)::uuid
        AND tp.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
);

--> statement-breakpoint
-- ============================================================
-- Phase 4a RLS policies
-- ============================================================

-- credit_balances: org-scoped SELECT only
CREATE POLICY credit_balances_select ON kernel.credit_balances FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

--> statement-breakpoint
-- credit_transactions: org-scoped SELECT only
CREATE POLICY credit_transactions_select ON kernel.credit_transactions FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

--> statement-breakpoint
-- model_pricing: globally readable (no org_id)
CREATE POLICY model_pricing_select ON kernel.model_pricing FOR SELECT TO liaison_rls
  USING (true);

--> statement-breakpoint
-- agent_user_memory: org + user scoped (user can only access their own memories)
CREATE POLICY agent_user_memory_select ON kernel.agent_user_memory FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );
CREATE POLICY agent_user_memory_insert ON kernel.agent_user_memory FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );
CREATE POLICY agent_user_memory_update ON kernel.agent_user_memory FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );
CREATE POLICY agent_user_memory_delete ON kernel.agent_user_memory FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

--> statement-breakpoint
-- approval_requests: requester / admin / snapshot-approver SELECT, self-scoped INSERT.
-- Admin and snapshot-approver branches mirror hasScope(required, grants):
-- exact, '*' wildcard, or parent-prefix grant ('mail' covers 'mail:approve').
-- Scope possession is resolved from the caller's DB grants (user_scope_grants +
-- role_scope_grants), NOT the session `app.current_scopes` — so an approval's
-- visibility never depends on the caller having passed the right session scopes
-- (see migration-phase6-1.test.ts `countVisible` which probes with empty
-- session scopes). The service-layer `hasScope(args.scopes)` filter in
-- listApprovals is a redundant second gate over the session scopes, which for a
-- real request are themselves derived from these same DB grants at auth time.
CREATE POLICY approval_requests_select ON kernel.approval_requests FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      requested_by = current_setting('app.current_user_id', true)::uuid
      OR EXISTS (
        SELECT 1
        FROM (VALUES ('kernel:approvals:admin'), ('kernel:users:admin')) AS required(scope)
        WHERE EXISTS (
          SELECT 1 FROM kernel.user_scope_grants g
          WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
            AND g.org_id = current_setting('app.current_org_id', true)::uuid
            AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':')
        )
        OR EXISTS (
          SELECT 1
          FROM kernel.user_roles ur
          JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
          WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
            AND ur.org_id = current_setting('app.current_org_id', true)::uuid
            AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':')
        )
      )
      OR (
        current_setting('app.current_user_id', true)::uuid = ANY(notify_user_ids)
        AND EXISTS (
          SELECT 1
          FROM (SELECT split_part(tool_name, ':', 1) || ':approve' AS scope) AS required
          WHERE EXISTS (
            SELECT 1 FROM kernel.user_scope_grants g
            WHERE g.user_id = current_setting('app.current_user_id', true)::uuid
              AND g.org_id = current_setting('app.current_org_id', true)::uuid
              AND (g.scope = '*' OR g.scope = required.scope OR left(required.scope, length(g.scope) + 1) = g.scope || ':')
          )
          OR EXISTS (
            SELECT 1
            FROM kernel.user_roles ur
            JOIN kernel.role_scope_grants rsg ON rsg.role_id = ur.role_id
            WHERE ur.user_id = current_setting('app.current_user_id', true)::uuid
              AND ur.org_id = current_setting('app.current_org_id', true)::uuid
              AND (rsg.scope = '*' OR rsg.scope = required.scope OR left(required.scope, length(rsg.scope) + 1) = rsg.scope || ':')
          )
        )
      )
    )
  );
CREATE POLICY approval_requests_insert ON kernel.approval_requests FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND requested_by = current_setting('app.current_user_id', true)::uuid
  );

--> statement-breakpoint
-- saved_views: per-user private rows + org-shared rows. Admin scope can manage org-shared/default rows.
CREATE POLICY saved_views_select ON kernel.saved_views FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR shared_with_org = true
    )
  );
CREATE POLICY saved_views_insert ON kernel.saved_views FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      shared_with_org = false
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:share' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY saved_views_update ON kernel.saved_views FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      shared_with_org = false
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:share' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY saved_views_delete ON kernel.saved_views FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:saved_views:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );

--> statement-breakpoint
-- system_config: globally readable (no org_id)
CREATE POLICY system_config_select ON kernel.system_config FOR SELECT TO liaison_rls
  USING (true);

--> statement-breakpoint
-- skills: per-user private rows (author_user_id NOT NULL) + org-shared rows (NULL author).
-- Hierarchy match against app.current_scopes; uses canonical kernel pattern.
CREATE POLICY skills_select ON kernel.skills FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      author_user_id IS NULL
      OR author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
CREATE POLICY skills_insert ON kernel.skills FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      author_user_id IS NULL
      OR author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
-- Mutation (update/delete) ownership clause: the AUTHOR may edit their own personal
-- skill; an ORG-SHARED skill (author_user_id NULL — which only an apps-admin may create,
-- see handleCreateSkill) may be edited/deleted only by an apps-admin. Previously the
-- `author_user_id IS NULL` branch was open to any kernel:skills:write holder, so a
-- non-admin could clobber org-shared skills (defense-in-depth for the service-layer gate
-- in skills-routines-tools.ts loadEditableSkill).
CREATE POLICY skills_update ON kernel.skills FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR (author_user_id IS NULL AND (
        '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        OR 'kernel:apps:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        OR 'kernel:apps' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      ))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR (author_user_id IS NULL AND (
        '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        OR 'kernel:apps:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        OR 'kernel:apps' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      ))
    )
  );
CREATE POLICY skills_delete ON kernel.skills FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR (author_user_id IS NULL AND (
        '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        OR 'kernel:apps:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
        OR 'kernel:apps' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      ))
    )
  );

--> statement-breakpoint
-- disabled_app_skills: per-user (user_id non-null) + org-wide (user_id NULL).
-- Compound "admin scope for NULL user_id" is enforced at the route layer; RLS only
-- gates read scope + row ownership predicate.
CREATE POLICY disabled_app_skills_select ON kernel.disabled_app_skills FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      user_id IS NULL
      OR user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
CREATE POLICY disabled_app_skills_insert ON kernel.disabled_app_skills FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      user_id IS NULL
      OR user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );
CREATE POLICY disabled_app_skills_delete ON kernel.disabled_app_skills FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:skills:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND (
      user_id IS NULL
      OR user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );

--> statement-breakpoint
-- routines: owner-only rows; require kernel:routines:read for visibility.
CREATE POLICY routines_select ON kernel.routines FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
CREATE POLICY routines_insert ON kernel.routines FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
CREATE POLICY routines_update ON kernel.routines FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
CREATE POLICY routines_delete ON kernel.routines FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );

--> statement-breakpoint
-- auto_approve_policies: ORG-scoped (NOT owner-scoped — created_by is informational).
-- Read requires a policy-read/approve scope; writes require policy-write/approve.
CREATE POLICY auto_approve_policies_select ON kernel.auto_approve_policies FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY auto_approve_policies_insert ON kernel.auto_approve_policies FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY auto_approve_policies_update ON kernel.auto_approve_policies FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY auto_approve_policies_delete ON kernel.auto_approve_policies FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );

--> statement-breakpoint
-- approval_policies: ORG-scoped (NOT owner-scoped — created_by is informational).
-- Read requires a policy-read/admin/approve scope; writes require the
-- policy-admin scope (configuring a TIGHTENING policy is an admin authority).
CREATE POLICY approval_policies_select ON kernel.approval_policies FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:approve' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY approval_policies_insert ON kernel.approval_policies FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY approval_policies_update ON kernel.approval_policies FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY approval_policies_delete ON kernel.approval_policies FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:policies:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );

--> statement-breakpoint
-- routine_runs: read-only for owner; writes go through privileged worker.
CREATE POLICY routine_runs_select ON kernel.routine_runs FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:read' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:routines:write' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
    AND routine_id IN (
      SELECT id FROM kernel.routines
       WHERE owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );

--> statement-breakpoint
-- routine_state: org-scoped cross-tick scratch state. Written/read by the
-- privileged routine worker; the org-scoped policy keeps any request-scoped
-- role confined to its own org's rows.
CREATE POLICY routine_state_all ON kernel.routine_state FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  app_name TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id UUID,
  provider_type TEXT NOT NULL,
  identifier TEXT NOT NULL,
  display_name TEXT,
  provider_account_id TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  credentials_encrypted TEXT,
  metadata JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  status_message TEXT,
  disconnected_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_unique_active_idx
  ON kernel.connected_accounts (org_id, app_name, connection_name, identifier)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS connected_accounts_org_idx
  ON kernel.connected_accounts (org_id);
CREATE INDEX IF NOT EXISTS connected_accounts_owner_idx
  ON kernel.connected_accounts (org_id, owner_type, owner_id);

--> statement-breakpoint
-- I-DB-4 — referential integrity + cascade on the encrypted-token table so org
-- deletion cleans up its secrets-bearing rows and the user FKs (owner_id is
-- only set for owner_type='user'; both owner_id and created_by are users).
ALTER TABLE kernel.connected_accounts
  ADD CONSTRAINT connected_accounts_org_fk
  FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.connected_accounts
  ADD CONSTRAINT connected_accounts_owner_fk
  FOREIGN KEY (owner_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.connected_accounts
  ADD CONSTRAINT connected_accounts_created_by_fk
  FOREIGN KEY (created_by) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
-- I-DB-1 — connected_accounts holds the only secrets-bearing rows (encrypted
-- OAuth/credential tokens). Postgres exempts a table's OWNER from RLS unless
-- FORCE is set, so the table must both be owned by a NOBYPASSRLS role
-- (liaison_admin) AND have FORCE ROW LEVEL SECURITY to close the owner-bypass.
ALTER TABLE kernel.connected_accounts OWNER TO liaison_admin;
ALTER TABLE kernel.connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.connected_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY connected_accounts_select ON kernel.connected_accounts FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (owner_type = 'user' AND owner_id = current_setting('app.current_user_id', true)::uuid)
      OR (owner_type = 'org' AND app_name = 'kernel')
    )
  );
CREATE POLICY connected_accounts_insert ON kernel.connected_accounts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
  );
CREATE POLICY connected_accounts_update ON kernel.connected_accounts FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (owner_type = 'user' AND owner_id = current_setting('app.current_user_id', true)::uuid)
      OR (owner_type = 'org' AND app_name = 'kernel')
    )
  );
CREATE POLICY connected_accounts_delete ON kernel.connected_accounts FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (owner_type = 'user' AND owner_id = current_setting('app.current_user_id', true)::uuid)
      OR (owner_type = 'org' AND app_name = 'kernel')
    )
  );

--> statement-breakpoint
-- ============================================================
-- kernel.scope_requests — actors (users + agents) file requests for scopes they
-- lack; admins-of-the-scope (kernel:scope_requests:admin, or any *-ancestor)
-- decide them. RLS: org-isolated; the requester and the target may read their own
-- rows; scope-admins may read + decide all. INSERT is self-targeted (you can only
-- file a request for yourself, as yourself). Uses the canonical kernel inline
-- string_to_array scope check (mirrors skills_*) — there is no kernel-schema
-- app_has_scope helper.
-- ============================================================
CREATE TABLE IF NOT EXISTS kernel.scope_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  requested_by UUID NOT NULL,
  requested_by_type TEXT NOT NULL,
  target_user_id UUID NOT NULL,
  requested_scopes TEXT[] NOT NULL,
  granted_scopes TEXT[],
  reason TEXT,
  originating_thread_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  summary JSONB,
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scope_requests_status_chk CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  CONSTRAINT scope_requests_type_chk CHECK (requested_by_type IN ('user','agent'))
);

CREATE INDEX IF NOT EXISTS scope_requests_org_status_idx
  ON kernel.scope_requests (org_id, status);
CREATE INDEX IF NOT EXISTS scope_requests_requested_by_idx
  ON kernel.scope_requests (org_id, requested_by);
-- Concurrency backstop for the create-time dedup (service.ts createScopeRequest):
-- at most one PENDING request per (org, requester, exact requested-scope set). The
-- service select-then-insert dedup has a race window — two concurrent identical
-- requests (an agent retrying across turns, a user double-clicking) both miss the
-- select and both insert. This partial unique index makes exactly one INSERT win;
-- the loser's `ON CONFLICT DO NOTHING` returns no row and the service re-reads the
-- winner. requested_scopes is canonicalized (deduped + sorted) by the service before
-- insert so set-equal requests collide regardless of input order. Scoped to pending
-- so decided rows never block a fresh re-request of the same scopes.
CREATE UNIQUE INDEX IF NOT EXISTS scope_requests_pending_dedup_idx
  ON kernel.scope_requests (org_id, requested_by, requested_scopes)
  WHERE status = 'pending';

--> statement-breakpoint
ALTER TABLE kernel.scope_requests
  ADD CONSTRAINT scope_requests_org_fk
  FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests
  ADD CONSTRAINT scope_requests_requested_by_fk
  FOREIGN KEY (requested_by) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests
  ADD CONSTRAINT scope_requests_target_user_fk
  FOREIGN KEY (target_user_id) REFERENCES kernel.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests
  ADD CONSTRAINT scope_requests_thread_fk
  FOREIGN KEY (originating_thread_id) REFERENCES kernel.threads(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests
  ADD CONSTRAINT scope_requests_decided_by_fk
  FOREIGN KEY (decided_by) REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE kernel.scope_requests OWNER TO liaison_admin;
ALTER TABLE kernel.scope_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.scope_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY scope_requests_select ON kernel.scope_requests FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      requested_by = current_setting('app.current_user_id', true)::uuid
      OR target_user_id = current_setting('app.current_user_id', true)::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );
CREATE POLICY scope_requests_insert ON kernel.scope_requests FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND requested_by = current_setting('app.current_user_id', true)::uuid
    AND target_user_id = current_setting('app.current_user_id', true)::uuid
  );
CREATE POLICY scope_requests_update ON kernel.scope_requests FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      requested_by = current_setting('app.current_user_id', true)::uuid
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- A scope-admin may set any status (the decide path: approved/denied).
      -- A non-admin requester (USING arm above) may only ever move their own
      -- row to 'cancelled' — never self-approve/deny via a raw UPDATE.
      status = 'cancelled'
      OR '*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests:admin' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
      OR 'kernel:scope_requests:*' = ANY(string_to_array(current_setting('app.current_scopes', true), ','))
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.scope_requests
  TO liaison_rls, liaison_app, liaison_admin;

--> statement-breakpoint
-- ============================================================
-- app_mail schema — seeded here; accounts/conversations/messages owned by liaison_admin
-- so the app runtime can add columns and indexes without ownership conflicts.
-- Drafts have user-private RLS enforced at the kernel level.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app_mail;
-- Transfer ownership to liaison_admin so the app runtime can ALTER DEFAULT PRIVILEGES
ALTER SCHEMA app_mail OWNER TO liaison_admin;

--> statement-breakpoint
-- Grant app_mail schema access so the app runtime can create and modify tables
GRANT USAGE, CREATE ON SCHEMA app_mail TO liaison_admin, liaison_app;
GRANT USAGE ON SCHEMA app_mail TO liaison_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_mail GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO liaison_rls, liaison_app;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_mail GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_rls, liaison_app;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin;

--> statement-breakpoint
-- Minimal stubs for accounts/conversations/messages — owned by liaison_admin so the
-- app runtime (which runs as liaison_admin) can ALTER them to add columns and indexes.
-- Minimal stubs owned by liaison_admin so app runtime ALTER DEFAULT PRIVILEGES works
-- and CREATE INDEX operations succeed. The app runtime adds missing columns on startup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='app_mail' AND table_name='accounts') THEN
    EXECUTE 'CREATE TABLE app_mail.accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, connected_account_id UUID NOT NULL, owner_type TEXT NOT NULL DEFAULT ''user'', owner_id UUID, provider TEXT NOT NULL, email_address TEXT NOT NULL, display_name TEXT, sync_status TEXT NOT NULL, sync_state JSONB, last_sync_at TIMESTAMPTZ, last_sync_error TEXT, disconnected_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (org_id, email_address))';
    EXECUTE 'ALTER TABLE app_mail.accounts OWNER TO liaison_admin';
    EXECUTE 'ALTER TABLE app_mail.accounts ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE app_mail.accounts FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY accounts_deny_default ON app_mail.accounts FOR ALL TO liaison_rls USING (false) WITH CHECK (false)';
  END IF;
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='app_mail' AND table_name='conversations') THEN
    EXECUTE 'CREATE TABLE app_mail.conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, account_id UUID NOT NULL, owner_type TEXT NOT NULL DEFAULT ''user'', owner_id UUID, external_thread_id TEXT NOT NULL, subject TEXT, snippet TEXT, from_email TEXT, contact_id UUID, assigned_to UUID, status TEXT NOT NULL, escalated_ticket_id UUID, labels JSONB NOT NULL DEFAULT ''[]'', is_read BOOLEAN NOT NULL DEFAULT false, is_starred BOOLEAN NOT NULL DEFAULT false, internal_thread_id UUID, last_message_at TIMESTAMPTZ, message_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())';
    EXECUTE 'ALTER TABLE app_mail.conversations OWNER TO liaison_admin';
    EXECUTE 'ALTER TABLE app_mail.conversations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE app_mail.conversations FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY conversations_deny_default ON app_mail.conversations FOR ALL TO liaison_rls USING (false) WITH CHECK (false)';
  END IF;
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='app_mail' AND table_name='messages') THEN
    EXECUTE 'CREATE TABLE app_mail.messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, conversation_id UUID NOT NULL, account_id UUID NOT NULL, external_message_id TEXT, external_provider_id TEXT, in_reply_to TEXT, message_references JSONB NOT NULL DEFAULT ''[]'', from_address JSONB NOT NULL DEFAULT ''{}'', to_addresses JSONB NOT NULL DEFAULT ''[]'', cc_addresses JSONB NOT NULL DEFAULT ''[]'', bcc_addresses JSONB NOT NULL DEFAULT ''[]'', subject TEXT, text_body TEXT, html_body TEXT, snippet TEXT, is_read BOOLEAN NOT NULL DEFAULT false, is_starred BOOLEAN NOT NULL DEFAULT false, labels JSONB NOT NULL DEFAULT ''[]'', direction TEXT NOT NULL, sent_at TIMESTAMPTZ, synced_at TIMESTAMPTZ, raw_headers JSONB NOT NULL DEFAULT ''{}'', owner_type TEXT NOT NULL DEFAULT ''user'', owner_id UUID, sent_by_user_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())';
    EXECUTE 'ALTER TABLE app_mail.messages OWNER TO liaison_admin';
    EXECUTE 'ALTER TABLE app_mail.messages ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE app_mail.messages FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY messages_deny_default ON app_mail.messages FOR ALL TO liaison_rls USING (false) WITH CHECK (false)';
    -- A mail message inherits its parent conversation's visibility: it is
    -- readable / writable exactly when the conversation is (the conversation's
    -- own RLS already enforces org + `mail:conversations:*` scope + the inbox
    -- membership dimension). The runtime RLS generator derives a table-name
    -- scope (`mail:messages:*`) that the mail permission model never grants —
    -- so its generated `messages_rls_*` policies are inert, and `app_mail.messages`
    -- (and every `kernel.files` row parented to a `mail:message`) would be both
    -- unreadable and uninsertable without these. Authorisation of the mutation
    -- itself is enforced upstream by the `mail:conversations:write` tool scope;
    -- these policies are the row-scoped parent-inheritance guard.
    EXECUTE 'CREATE POLICY messages_select ON app_mail.messages FOR SELECT TO liaison_rls USING (org_id = current_setting(''app.current_org_id'', true)::uuid AND EXISTS (SELECT 1 FROM app_mail.conversations c WHERE c.id = conversation_id))';
    EXECUTE 'CREATE POLICY messages_insert ON app_mail.messages FOR INSERT TO liaison_rls WITH CHECK (org_id = current_setting(''app.current_org_id'', true)::uuid AND EXISTS (SELECT 1 FROM app_mail.conversations c WHERE c.id = conversation_id))';
    EXECUTE 'CREATE POLICY messages_update ON app_mail.messages FOR UPDATE TO liaison_rls USING (org_id = current_setting(''app.current_org_id'', true)::uuid AND EXISTS (SELECT 1 FROM app_mail.conversations c WHERE c.id = conversation_id)) WITH CHECK (org_id = current_setting(''app.current_org_id'', true)::uuid AND EXISTS (SELECT 1 FROM app_mail.conversations c WHERE c.id = conversation_id))';
    EXECUTE 'CREATE POLICY messages_delete ON app_mail.messages FOR DELETE TO liaison_rls USING (org_id = current_setting(''app.current_org_id'', true)::uuid AND EXISTS (SELECT 1 FROM app_mail.conversations c WHERE c.id = conversation_id))';
  END IF;
END $$;

--> statement-breakpoint
-- Drafts table — user-private, soft foreign keys (accounts/conversations/messages created by app runtime)
-- Created as the default owner (postgres/alex), then transferred to liaison_admin for consistency.
CREATE TABLE IF NOT EXISTS app_mail.drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  account_id UUID NOT NULL,
  conversation_id UUID,
  reply_to_message_id UUID,
  "to" JSONB NOT NULL DEFAULT '[]',
  cc JSONB NOT NULL DEFAULT '[]',
  bcc JSONB NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  created_by UUID NOT NULL,
  sent_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app_mail.drafts OWNER TO liaison_admin;

CREATE INDEX IF NOT EXISTS drafts_org_user_idx
  ON app_mail.drafts (org_id, created_by);
CREATE INDEX IF NOT EXISTS drafts_conversation_idx
  ON app_mail.drafts (conversation_id)
  WHERE conversation_id IS NOT NULL;

--> statement-breakpoint
-- RLS for app_mail.drafts (user-private, account-accessible)
-- drafts is owned by liaison_admin (NOBYPASSRLS); FORCE so the owner is not
-- exempt from the user-private policy below.
ALTER TABLE app_mail.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_mail.drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY drafts_select ON app_mail.drafts FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = current_setting('app.current_org_id', true)::uuid
        AND (
          (account.owner_type = 'user' AND account.owner_id = current_setting('app.current_user_id', true)::uuid)
          OR account.owner_type = 'org'
        )
    )
  );

CREATE POLICY drafts_insert ON app_mail.drafts FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = current_setting('app.current_org_id', true)::uuid
        AND (
          (account.owner_type = 'user' AND account.owner_id = current_setting('app.current_user_id', true)::uuid)
          OR account.owner_type = 'org'
        )
    )
  );

CREATE POLICY drafts_update ON app_mail.drafts FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = current_setting('app.current_org_id', true)::uuid
        AND (
          (account.owner_type = 'user' AND account.owner_id = current_setting('app.current_user_id', true)::uuid)
          OR account.owner_type = 'org'
        )
    )
  );

CREATE POLICY drafts_delete ON app_mail.drafts FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1
      FROM app_mail.accounts account
      WHERE account.id = app_mail.drafts.account_id
        AND account.org_id = current_setting('app.current_org_id', true)::uuid
        AND (
          (account.owner_type = 'user' AND account.owner_id = current_setting('app.current_user_id', true)::uuid)
          OR account.owner_type = 'org'
        )
    )
  );

--> statement-breakpoint
-- ============================================================
-- app_tickets schema — manifest-backed Tickets foundations.
-- Seeded in the squashed migration so reset test databases expose the
-- Phase 7.2 schema invariants before any runtime app registration.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app_tickets;
ALTER SCHEMA app_tickets OWNER TO liaison_admin;

GRANT USAGE, CREATE ON SCHEMA app_tickets TO liaison_admin, liaison_app;
GRANT USAGE ON SCHEMA app_tickets TO liaison_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_tickets GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO liaison_rls, liaison_app;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_tickets GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_rls, liaison_app;

CREATE SEQUENCE IF NOT EXISTS app_tickets.tickets_handle_seq;
ALTER SEQUENCE app_tickets.tickets_handle_seq OWNER TO liaison_admin;

CREATE TABLE IF NOT EXISTS app_tickets.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_id UUID REFERENCES app_tickets.categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ
);
ALTER TABLE app_tickets.categories OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_app_tickets_categories_parent_id_sort_order ON app_tickets.categories (org_id, parent_id, sort_order);

-- Reply templates (canned-response macros) — org-shared saved replies a support agent
-- authors once and reuses. BL-169 #9 (impossible→works_today). Org-scoped, no dimensions
-- (templates are shared across the support team); read = tickets:tickets:read, write =
-- tickets:tickets:write (same scopes a support agent already holds to reply).
CREATE TABLE IF NOT EXISTS app_tickets.reply_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  body_text TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
ALTER TABLE app_tickets.reply_templates OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_app_tickets_reply_templates_org ON app_tickets.reply_templates (org_id, category, name);

-- CSAT post-resolution satisfaction surveys — BL-169 #8 (impossible→works_today). A support
-- agent dispatches a short satisfaction survey to the customers of recently-closed tickets;
-- each row is ONE survey (pending until the customer responds). There is NO aggregate CSAT
-- score/trend until responses accrue — csat.summary aggregates ONLY recorded responses and
-- returns averageScore=null while none exist, so the agent reports dispatch + honest-pending
-- and never fabricates a CSAT %. Org-scoped, one survey per ticket (UNIQUE org_id,ticket_id).
-- read = tickets:tickets:read, write = tickets:tickets:write (the support-agent scopes).
CREATE TABLE IF NOT EXISTS app_tickets.ticket_csat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  ticket_id UUID NOT NULL,
  contact_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'responded', 'declined')),
  score INTEGER CHECK (score BETWEEN 1 AND 5),
  comment TEXT,
  survey_token TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, ticket_id)
);
ALTER TABLE app_tickets.ticket_csat OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_app_tickets_ticket_csat_org ON app_tickets.ticket_csat (org_id, status);

CREATE OR REPLACE FUNCTION app_tickets.categories_enforce_category_depth_fn() RETURNS TRIGGER AS $TRIGGER_BODY$
DECLARE _exists boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.categories WHERE id = $1 AND parent_id IS NOT NULL)', TG_TABLE_SCHEMA) INTO _exists USING NEW.parent_id;
  IF _exists THEN
    RAISE EXCEPTION 'category_depth_limit';
  END IF;
  RETURN NEW;
END;
$TRIGGER_BODY$ LANGUAGE plpgsql;
ALTER FUNCTION app_tickets.categories_enforce_category_depth_fn() OWNER TO liaison_admin;
DROP TRIGGER IF EXISTS enforce_category_depth ON app_tickets.categories;
CREATE TRIGGER enforce_category_depth BEFORE INSERT OR UPDATE OF parent_id ON app_tickets.categories FOR EACH ROW EXECUTE FUNCTION app_tickets.categories_enforce_category_depth_fn();

CREATE TABLE IF NOT EXISTS app_tickets.inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_account_id UUID NOT NULL,
  name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  default_team TEXT,
  default_sensitivity TEXT,
  from_display_name TEXT,
  is_default_for_create BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  UNIQUE (org_id, email_address)
);
ALTER TABLE app_tickets.inboxes OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_tickets_inboxes_org ON app_tickets.inboxes (org_id) WHERE is_default_for_create = true;

CREATE TABLE IF NOT EXISTS app_tickets.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handle TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_customer', 'awaiting_followup', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'web_form', 'api', 'mail_escalation', 'manual', 'social')),
  team TEXT,
  language TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('internal', 'confidential', 'restricted')),
  category_id UUID REFERENCES app_tickets.categories(id) ON DELETE SET NULL,
  contact_id UUID,
  assigned_to UUID,
  reply_token TEXT NOT NULL,
  source_account_id UUID,
  source_inbox_id UUID REFERENCES app_tickets.inboxes(id) ON DELETE NO ACTION,
  source_conversation_id UUID,
  converted_to_mail_conversation_id UUID,
  merged_into_ticket_id UUID REFERENCES app_tickets.tickets(id) ON DELETE SET NULL,
  closed_reason TEXT CHECK (closed_reason IN ('resolved', 'converted_to_mail', 'merged', 'spam', 'duplicate', 'no_response')),
  first_response_at TIMESTAMPTZ,
  sla_target_seconds INTEGER NOT NULL,
  sla_deadline TIMESTAMPTZ NOT NULL,
  sla_active_started_at TIMESTAMPTZ,
  sla_paused_at TIMESTAMPTZ,
  sla_elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  sla_breached_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0,
  nudge_sent_at TIMESTAMPTZ,
  followup_at TIMESTAMPTZ,
  followup_reason TEXT,
  followup_trigger TEXT,
  internal_thread_id UUID,
  external_ref TEXT,
  summary_text TEXT,
  summary_at TIMESTAMPTZ,
  summary_message_count INTEGER NOT NULL DEFAULT 0,
  summary_status TEXT NOT NULL DEFAULT 'idle' CHECK (summary_status IN ('idle', 'generating', 'error')),
  summary_model TEXT,
  summary_token_usage JSONB,
  summary_error TEXT,
  UNIQUE (org_id, handle),
  UNIQUE (org_id, reply_token)
);
ALTER TABLE app_tickets.tickets OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_tickets_tickets_external_ref ON app_tickets.tickets (org_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_status_sla_deadline ON app_tickets.tickets (org_id, status, sla_deadline);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_status_followup_at ON app_tickets.tickets (org_id, status, followup_at);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_status_last_outbound_at ON app_tickets.tickets (org_id, status, last_outbound_at);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_team_status ON app_tickets.tickets (org_id, team, status);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_sensitivity ON app_tickets.tickets (org_id, sensitivity);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_contact_id ON app_tickets.tickets (org_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_category_id ON app_tickets.tickets (org_id, category_id);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_assigned_to ON app_tickets.tickets (org_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_merged_into_ticket_id ON app_tickets.tickets (org_id, merged_into_ticket_id) WHERE merged_into_ticket_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_tickets.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ticket_id UUID NOT NULL REFERENCES app_tickets.tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inbound', 'outbound', 'note')),
  from_email TEXT,
  from_name TEXT,
  to_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT,
  html_body TEXT,
  text_body TEXT,
  snippet TEXT,
  external_message_id TEXT,
  in_reply_to TEXT,
  header_references JSONB,
  sent_at TIMESTAMPTZ NOT NULL,
  created_by UUID
);
ALTER TABLE app_tickets.messages OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_tickets_messages_external_message_id ON app_tickets.messages (org_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_tickets_messages_ticket_id_sent_at ON app_tickets.messages (org_id, ticket_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_app_tickets_messages_external_message_id ON app_tickets.messages (org_id, external_message_id) WHERE external_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_tickets.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (org_id, key_hash)
);
ALTER TABLE app_tickets.api_keys OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_app_tickets_api_keys_key_prefix ON app_tickets.api_keys (org_id, key_prefix);

CREATE TABLE IF NOT EXISTS app_tickets.ticket_reads (
  ticket_id UUID NOT NULL REFERENCES app_tickets.tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_message_id UUID REFERENCES app_tickets.messages(id) ON DELETE SET NULL,
  PRIMARY KEY (ticket_id, user_id)
);
ALTER TABLE app_tickets.ticket_reads OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS ticket_reads_ticket_read_at_idx ON app_tickets.ticket_reads (ticket_id, read_at DESC);
CREATE INDEX IF NOT EXISTS ticket_reads_user_read_at_idx ON app_tickets.ticket_reads (user_id, read_at DESC);

ALTER TABLE app_tickets.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.ticket_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.reply_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.categories FORCE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.inboxes FORCE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.ticket_reads FORCE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.reply_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY categories_deny_default ON app_tickets.categories FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY inboxes_deny_default ON app_tickets.inboxes FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY tickets_deny_default ON app_tickets.tickets FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY messages_deny_default ON app_tickets.messages FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY api_keys_deny_default ON app_tickets.api_keys FOR ALL TO liaison_rls USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION app_tickets.can_read_ticket(_ticket_id UUID) RETURNS boolean AS $FUNCTION_BODY$
  SELECT EXISTS (
    SELECT 1
    FROM app_tickets.tickets t
    WHERE t.id = _ticket_id
      AND t.org_id = current_setting('app.current_org_id', true)::uuid
      AND (
        current_setting('app.current_scopes', true) = '*'
        OR EXISTS (
          SELECT 1 FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
          WHERE g = '*'
            OR g = 'tickets:tickets'
            OR g = 'tickets:tickets:write'
            OR g = 'tickets:tickets:read'
            OR g = 'tickets:*'
            OR g = 'tickets'
            OR starts_with('tickets:tickets', g || ':')
        )
      )
      AND (
        (current_setting('app.current_dimensions', true)::jsonb ? '*' AND current_setting('app.current_dimensions', true)::jsonb->'*' @> '"*"'::jsonb)
        OR (current_setting('app.current_dimensions', true)::jsonb ? 'tickets:team' AND current_setting('app.current_dimensions', true)::jsonb->'tickets:team' @> '"*"'::jsonb)
        OR t.team = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('app.current_dimensions', true)::jsonb->'tickets:team')))
      )
      AND (
        (current_setting('app.current_dimensions', true)::jsonb ? '*' AND current_setting('app.current_dimensions', true)::jsonb->'*' @> '"*"'::jsonb)
        OR (current_setting('app.current_dimensions', true)::jsonb ? 'tickets:sensitivity' AND current_setting('app.current_dimensions', true)::jsonb->'tickets:sensitivity' @> '"*"'::jsonb)
        OR (CASE t.sensitivity WHEN 'internal' THEN 0 WHEN 'confidential' THEN 1 WHEN 'restricted' THEN 2 END) <= (
          SELECT MAX(CASE v WHEN 'internal' THEN 0 WHEN 'confidential' THEN 1 WHEN 'restricted' THEN 2 END)
          FROM jsonb_array_elements_text(current_setting('app.current_dimensions', true)::jsonb->'tickets:sensitivity') AS v
        )
      )
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
ALTER FUNCTION app_tickets.can_read_ticket(UUID) OWNER TO liaison_admin;

CREATE POLICY ticket_reads_select ON app_tickets.ticket_reads
  FOR SELECT TO liaison_rls
  USING (app_tickets.can_read_ticket(ticket_id));

-- Ticket messages are readable by anyone who can read the parent ticket. This
-- backs the generic file system: `kernel.files` rows parented to a ticket
-- message (agent attachments copied onto an outbound reply) are RLS-projected
-- through an EXISTS join onto this table, and `assertParentVisible` resolves a
-- `tickets:message` file-parent destination through the same SELECT. Without a
-- permissive SELECT policy the deny-default makes every such file invisible.
-- Read-only — message mutations stay on the privileged host path.
CREATE POLICY messages_select ON app_tickets.messages
  FOR SELECT TO liaison_rls
  USING (app_tickets.can_read_ticket(ticket_id));

-- Categories are org-level reference data for ticketing: any user who can read
-- tickets (tickets:tickets:read) may LIST them — required to categorize. Without
-- a permissive SELECT policy the deny-default makes the agent's categories_list
-- tool return [] under RLS, so it cannot categorize (it re-applies existing
-- categoryIds or fabricates). No dimensions on categories. Category MUTATIONS
-- stay deny-default (admin path / tickets:categories:admin), read-only here.
CREATE POLICY categories_select ON app_tickets.categories
  FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      current_setting('app.current_scopes', true) = '*'
      OR EXISTS (
        SELECT 1 FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
        WHERE g = '*'
          OR g = 'tickets'
          OR g = 'tickets:*'
          OR g = 'tickets:tickets'
          OR g = 'tickets:tickets:read'
          OR starts_with('tickets:tickets:read', g || ':')
      )
    )
  );

-- Reply-template (canned-response macro) policies — org-scoped, scope-gated, no dimensions.
-- Mirrors the projects per-op deny-default model. Read = tickets:tickets:read,
-- write = tickets:tickets:write (the scopes a support agent already holds to reply).
CREATE OR REPLACE FUNCTION app_tickets.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT
    current_setting('app.current_scopes', true) = '*'
    OR EXISTS (
      SELECT 1
      FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = split_part(_scope, ':', 1) || ':*'
        OR g = split_part(_scope, ':', 1)
        OR starts_with(_scope, g || ':')
    );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
ALTER FUNCTION app_tickets.app_has_scope(TEXT) OWNER TO liaison_admin;

CREATE POLICY reply_templates_deny_default ON app_tickets.reply_templates FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY reply_templates_select ON app_tickets.reply_templates FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:read'));
CREATE POLICY reply_templates_insert ON app_tickets.reply_templates FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'));
CREATE POLICY reply_templates_update ON app_tickets.reply_templates FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'));
CREATE POLICY reply_templates_delete ON app_tickets.reply_templates FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'));

ALTER TABLE app_tickets.ticket_csat ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tickets.ticket_csat FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_csat_deny_default ON app_tickets.ticket_csat FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY ticket_csat_select ON app_tickets.ticket_csat FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:read'));
CREATE POLICY ticket_csat_insert ON app_tickets.ticket_csat FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'));
CREATE POLICY ticket_csat_update ON app_tickets.ticket_csat FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'));
CREATE POLICY ticket_csat_delete ON app_tickets.ticket_csat FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_tickets.app_has_scope('tickets:tickets:write'));

CREATE POLICY ticket_reads_modify_self ON app_tickets.ticket_reads
  FOR ALL TO liaison_rls
  USING (
    user_id = current_setting('app.current_user_id', true)::uuid
    AND app_tickets.can_read_ticket(ticket_id)
  )
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)::uuid
    AND app_tickets.can_read_ticket(ticket_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA app_tickets TO liaison_rls, liaison_app, liaison_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app_tickets TO liaison_rls, liaison_app, liaison_admin;

-- app_projects schema — manifest-backed Projects foundations.

CREATE SCHEMA IF NOT EXISTS app_projects;
ALTER SCHEMA app_projects OWNER TO liaison_admin;
GRANT USAGE, CREATE ON SCHEMA app_projects TO liaison_admin, liaison_app;
GRANT USAGE ON SCHEMA app_projects TO liaison_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_projects GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO liaison_rls, liaison_app;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_projects GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_rls, liaison_app;

CREATE TABLE IF NOT EXISTS app_projects.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,
  owner_id UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.projects OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_projects_org_updated ON app_projects.projects (org_id, updated_at);

CREATE TABLE IF NOT EXISTS app_projects.project_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES app_projects.projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  color TEXT,
  "order" INTEGER NOT NULL,
  terminal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.project_statuses OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_project_statuses_project_order ON app_projects.project_statuses (project_id, "order");

CREATE TABLE IF NOT EXISTS app_projects.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES app_projects.projects(id) ON DELETE RESTRICT,
  parent_task_id UUID REFERENCES app_projects.tasks(id) ON DELETE RESTRICT,
  status_id UUID NOT NULL REFERENCES app_projects.project_statuses(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date DATE,
  start_date DATE,
  position DOUBLE PRECISION NOT NULL DEFAULT 1000,
  blocked BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  thread_id UUID NOT NULL REFERENCES kernel.threads(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.tasks OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_position ON app_projects.tasks (project_id, status_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_project_parent_position ON app_projects.tasks (project_id, parent_task_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON app_projects.tasks (assignee_id, due_date);

ALTER TABLE app_projects.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.project_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE app_projects.project_statuses FORCE ROW LEVEL SECURITY;
ALTER TABLE app_projects.tasks FORCE ROW LEVEL SECURITY;

-- Helper for projects RLS: check whether the requested scope is granted to the
-- current actor. Mirrors the inline pattern used by the manifest rls-generator.
CREATE OR REPLACE FUNCTION app_projects.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT
    current_setting('app.current_scopes', true) = '*'
    OR EXISTS (
      SELECT 1
      FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = split_part(_scope, ':', 1) || ':*'
        OR g = split_part(_scope, ':', 1)
        OR starts_with(_scope, g || ':')
    );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
ALTER FUNCTION app_projects.app_has_scope(TEXT) OWNER TO liaison_admin;

-- Default-deny + scoped read/write policies.
CREATE POLICY projects_deny_default ON app_projects.projects FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY project_statuses_deny_default ON app_projects.project_statuses FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
CREATE POLICY tasks_deny_default ON app_projects.tasks FOR ALL TO liaison_rls USING (false) WITH CHECK (false);

CREATE POLICY projects_select ON app_projects.projects FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:read'));
CREATE POLICY projects_insert ON app_projects.projects FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));
CREATE POLICY projects_update ON app_projects.projects FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));
CREATE POLICY projects_delete ON app_projects.projects FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));

CREATE POLICY project_statuses_select ON app_projects.project_statuses FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:read'));
CREATE POLICY project_statuses_insert ON app_projects.project_statuses FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));
CREATE POLICY project_statuses_update ON app_projects.project_statuses FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));
CREATE POLICY project_statuses_delete ON app_projects.project_statuses FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));

CREATE POLICY tasks_select ON app_projects.tasks FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:read'));
CREATE POLICY tasks_insert ON app_projects.tasks FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'));
CREATE POLICY tasks_update ON app_projects.tasks FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'));
CREATE POLICY tasks_delete ON app_projects.tasks FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'));

-- J2: reusable project templates (a stored task tree materialized by
-- instantiateTemplate) and directed task dependencies (blocks-edges that drive
-- the stored `tasks.blocked` flag). Both org-scoped.
CREATE TABLE IF NOT EXISTS app_projects.project_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  name TEXT NOT NULL,
  structure JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_projects.project_templates OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_project_templates_org ON app_projects.project_templates (org_id);

CREATE TABLE IF NOT EXISTS app_projects.task_dependencies (
  org_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'blocks',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id)
);
ALTER TABLE app_projects.task_dependencies OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON app_projects.task_dependencies (depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_org ON app_projects.task_dependencies (org_id);

ALTER TABLE app_projects.project_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.project_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE app_projects.task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_projects.task_dependencies FORCE ROW LEVEL SECURITY;

CREATE POLICY project_templates_select ON app_projects.project_templates FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:read'));
CREATE POLICY project_templates_insert ON app_projects.project_templates FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));
CREATE POLICY project_templates_update ON app_projects.project_templates FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));
CREATE POLICY project_templates_delete ON app_projects.project_templates FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:write'));

CREATE POLICY task_dependencies_select ON app_projects.task_dependencies FOR SELECT TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:projects:read'));
CREATE POLICY task_dependencies_insert ON app_projects.task_dependencies FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'));
CREATE POLICY task_dependencies_update ON app_projects.task_dependencies FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'));
CREATE POLICY task_dependencies_delete ON app_projects.task_dependencies FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_projects.app_has_scope('projects:tasks:write'));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA app_projects TO liaison_rls, liaison_app, liaison_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app_projects TO liaison_rls, liaison_app, liaison_admin;

-- ============================================================================
-- app_knowledge schema — first-party Knowledge workspace foundations.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS app_knowledge;
ALTER SCHEMA app_knowledge OWNER TO liaison_admin;
GRANT USAGE, CREATE ON SCHEMA app_knowledge TO liaison_admin, liaison_app;
GRANT USAGE ON SCHEMA app_knowledge TO liaison_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_knowledge GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO liaison_rls, liaison_app;
ALTER DEFAULT PRIVILEGES FOR ROLE liaison_admin IN SCHEMA app_knowledge GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO liaison_rls, liaison_app;

CREATE TABLE IF NOT EXISTS app_knowledge.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL DEFAULT '',
  document_scope TEXT NOT NULL DEFAULT 'organization' CHECK (document_scope IN ('personal', 'organization')),
  owner_user_id UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  participant_ids JSONB,
  team JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity TEXT CHECK (sensitivity IS NULL OR sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  review_status TEXT NOT NULL DEFAULT 'unverified' CHECK (review_status IN ('unverified', 'verified', 'needs_review', 'stale')),
  verified_by UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  review_due_at TIMESTAMPTZ,
  review_reason TEXT,
  archived_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  updated_by UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  CONSTRAINT knowledge_documents_personal_owner_check CHECK (document_scope <> 'personal' OR owner_user_id IS NOT NULL),
  CONSTRAINT knowledge_documents_personal_shape_check CHECK (
    document_scope <> 'personal'
    OR (
      sensitivity IS NULL
      AND team = '[]'::jsonb
      AND participant_ids IS NOT NULL
    )
  ),
  -- IC-4: organization-scoped documents must always carry a sensitivity. This
  -- closes the raw-SQL bypass — the service layer already defaults to
  -- "internal" but a forged INSERT could omit it; the DB CHECK is the floor.
  CONSTRAINT knowledge_documents_org_sensitivity_check CHECK (
    document_scope <> 'organization' OR sensitivity IS NOT NULL
  )
);
ALTER TABLE app_knowledge.documents OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_title ON app_knowledge.documents (org_id, title);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_owner ON app_knowledge.documents (org_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_review_status ON app_knowledge.documents (org_id, review_status);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_active ON app_knowledge.documents (org_id, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_team_gin ON app_knowledge.documents USING gin (team);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_participants_gin ON app_knowledge.documents USING gin (participant_ids);

CREATE TABLE IF NOT EXISTS app_knowledge.source_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  mime_type TEXT,
  url TEXT,
  modified_at TIMESTAMPTZ,
  cache_status TEXT NOT NULL DEFAULT 'available' CHECK (cache_status IN ('available', 'partial', 'unavailable', 'unauthorized', 'stale', 'unsupported'))
);
ALTER TABLE app_knowledge.source_identities OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_source_identities_source_external ON app_knowledge.source_identities (org_id, source, external_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_identities_source ON app_knowledge.source_identities (org_id, source);

CREATE TABLE IF NOT EXISTS app_knowledge.source_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_identity_id UUID NOT NULL REFERENCES app_knowledge.source_identities(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  mime_type TEXT,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL DEFAULT 'unverified' CHECK (review_status IN ('unverified', 'verified', 'needs_review', 'stale')),
  verified_by UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  review_due_at TIMESTAMPTZ,
  review_reason TEXT,
  archived_at TIMESTAMPTZ,
  visibility_status TEXT NOT NULL DEFAULT 'available' CHECK (visibility_status IN ('available', 'partial', 'unavailable', 'unauthorized', 'stale', 'unsupported')),
  cache_status TEXT NOT NULL DEFAULT 'available' CHECK (cache_status IN ('available', 'partial', 'unavailable', 'unauthorized', 'stale', 'unsupported'))
);
ALTER TABLE app_knowledge.source_links OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_source_links_active_identity ON app_knowledge.source_links (org_id, source_identity_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_source_links_source ON app_knowledge.source_links (org_id, source);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_links_title ON app_knowledge.source_links (org_id, title);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_links_active ON app_knowledge.source_links (org_id, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS app_knowledge.collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parent_collection_id UUID REFERENCES app_knowledge.collections(id) ON DELETE RESTRICT,
  owner_user_id UUID REFERENCES kernel.users(id) ON DELETE SET NULL,
  maintainer_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  name TEXT NOT NULL,
  description TEXT,
  archived_at TIMESTAMPTZ
);
ALTER TABLE app_knowledge.collections OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_knowledge_collections_parent ON app_knowledge.collections (org_id, parent_collection_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_collections_name ON app_knowledge.collections (org_id, name);

CREATE OR REPLACE FUNCTION app_knowledge.collections_prevent_invalid_parent_fn() RETURNS TRIGGER AS $FUNCTION_BODY$
DECLARE
  current_parent UUID;
BEGIN
  IF NEW.parent_collection_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_collection_id = NEW.id THEN
    RAISE EXCEPTION 'collection cannot parent itself';
  END IF;

  SELECT parent_collection_id INTO current_parent
  FROM app_knowledge.collections
  WHERE id = NEW.parent_collection_id AND org_id = NEW.org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent collection must belong to same org';
  END IF;

  WHILE current_parent IS NOT NULL LOOP
    IF current_parent = NEW.id THEN
      RAISE EXCEPTION 'collection cycle detected';
    END IF;
    SELECT parent_collection_id INTO current_parent
    FROM app_knowledge.collections
    WHERE id = current_parent AND org_id = NEW.org_id;
  END LOOP;

  RETURN NEW;
END;
$FUNCTION_BODY$ LANGUAGE plpgsql;
ALTER FUNCTION app_knowledge.collections_prevent_invalid_parent_fn() OWNER TO liaison_admin;
DROP TRIGGER IF EXISTS collections_prevent_invalid_parent ON app_knowledge.collections;
CREATE TRIGGER collections_prevent_invalid_parent BEFORE INSERT OR UPDATE OF parent_collection_id, org_id ON app_knowledge.collections FOR EACH ROW EXECUTE FUNCTION app_knowledge.collections_prevent_invalid_parent_fn();

CREATE TABLE IF NOT EXISTS app_knowledge.collection_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  collection_id UUID NOT NULL REFERENCES app_knowledge.collections(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('document', 'source_link')),
  target_id UUID NOT NULL,
  created_by UUID REFERENCES kernel.users(id) ON DELETE SET NULL
);
ALTER TABLE app_knowledge.collection_memberships OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_collection_memberships_target ON app_knowledge.collection_memberships (org_id, collection_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_collection_memberships_target ON app_knowledge.collection_memberships (org_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS app_knowledge.tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT
);
ALTER TABLE app_knowledge.tags OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_tags_normalized ON app_knowledge.tags (org_id, normalized_name);

CREATE TABLE IF NOT EXISTS app_knowledge.taggings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tag_id UUID NOT NULL REFERENCES app_knowledge.tags(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('document', 'source_link')),
  target_id UUID NOT NULL,
  created_by UUID REFERENCES kernel.users(id) ON DELETE SET NULL
);
ALTER TABLE app_knowledge.taggings OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_taggings_target ON app_knowledge.taggings (org_id, tag_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_taggings_target ON app_knowledge.taggings (org_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS app_knowledge.content_cache_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_identity_id UUID NOT NULL REFERENCES app_knowledge.source_identities(id) ON DELETE CASCADE,
  policy TEXT NOT NULL DEFAULT 'remote_search',
  cache_bytes INTEGER NOT NULL DEFAULT 0,
  retained_chunks INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 0,
  usable BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ
);
ALTER TABLE app_knowledge.content_cache_entries OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_knowledge_content_cache_identity ON app_knowledge.content_cache_entries (org_id, source_identity_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_content_cache_usable ON app_knowledge.content_cache_entries (org_id, usable);

CREATE TABLE IF NOT EXISTS app_knowledge.source_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'remote_search',
  connection_mode TEXT NOT NULL DEFAULT 'selected',
  broad_search_enabled BOOLEAN NOT NULL DEFAULT false,
  cache_bytes INTEGER NOT NULL DEFAULT 0,
  retained_chunks INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 0,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE app_knowledge.source_policies OWNER TO liaison_admin;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_source_policies_source ON app_knowledge.source_policies (org_id, source);

ALTER TABLE app_knowledge.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.source_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.collection_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.taggings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.content_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.source_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.source_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.source_links FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.collections FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.collection_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.tags FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.taggings FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.content_cache_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE app_knowledge.source_policies FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_knowledge.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
BEGIN
  RETURN current_setting('app.current_scopes', true) = '*'
    OR EXISTS (
      SELECT 1 FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = 'knowledge:*'
        OR g = 'knowledge'
        OR starts_with(_scope, g || ':')
    );
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
ALTER FUNCTION app_knowledge.app_has_scope(TEXT) OWNER TO liaison_admin;

CREATE OR REPLACE FUNCTION app_knowledge.dimension_values(_key TEXT) RETURNS TEXT[] AS $FUNCTION_BODY$
DECLARE
  dims JSONB := nullif(current_setting('app.current_dimensions', true), '')::jsonb;
BEGIN
  IF dims IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;
  IF dims ? _key THEN
    RETURN ARRAY(SELECT jsonb_array_elements_text(dims -> _key));
  END IF;
  RETURN ARRAY[]::TEXT[];
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
ALTER FUNCTION app_knowledge.dimension_values(TEXT) OWNER TO liaison_admin;

CREATE OR REPLACE FUNCTION app_knowledge.dimension_allows(_key TEXT, _value TEXT) RETURNS boolean AS $FUNCTION_BODY$
DECLARE
  values TEXT[] := app_knowledge.dimension_values(_key);
BEGIN
  RETURN '*' = ANY(values) OR _value = ANY(values);
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
ALTER FUNCTION app_knowledge.dimension_allows(TEXT, TEXT) OWNER TO liaison_admin;

-- Cumulative sensitivity ladder — SQL parity with
-- packages/shared/src/validation/knowledge-sensitivity.ts expandKnowledgeSensitivityGrants.
-- The ladder is least -> most sensitive (public < internal < confidential < restricted), so
-- granting a tier implicitly grants all LOWER tiers (a 'restricted'-cleared reader can read
-- public/internal/confidential docs too). '*' short-circuits to all; unknown/externally-defined
-- tiers are preserved verbatim (exact-match). Used by can_read_knowledge_dimensions so the RLS
-- LIST path matches the in-memory single-doc read path (authorizeDocumentRead). Previously the
-- check was exact-match (dimension_allows), so e.g. a sensitivity=[restricted] grant matched ONLY
-- 'restricted' docs and a member saw NONE of the lower-tier org docs.
CREATE OR REPLACE FUNCTION app_knowledge.expand_sensitivity_grants(_grants TEXT[]) RETURNS TEXT[] AS $FUNCTION_BODY$
DECLARE
  order_arr TEXT[] := ARRAY['public', 'internal', 'confidential', 'restricted'];
  max_idx INT := 0;
  g TEXT;
  idx INT;
  result TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF _grants IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;
  IF '*' = ANY(_grants) THEN
    RETURN ARRAY['*'];
  END IF;
  FOREACH g IN ARRAY _grants LOOP
    idx := array_position(order_arr, g);  -- 1-based; NULL when not a known tier
    IF idx IS NULL THEN
      result := result || g;             -- preserve unknown tier verbatim
    ELSIF idx > max_idx THEN
      max_idx := idx;
    END IF;
  END LOOP;
  IF max_idx >= 1 THEN
    result := result || order_arr[1:max_idx];  -- all tiers up to the highest granted
  END IF;
  RETURN result;
END;
$FUNCTION_BODY$ LANGUAGE plpgsql IMMUTABLE;
ALTER FUNCTION app_knowledge.expand_sensitivity_grants(TEXT[]) OWNER TO liaison_admin;

CREATE OR REPLACE FUNCTION app_knowledge.can_read_knowledge_dimensions(_team JSONB, _sensitivity TEXT) RETURNS boolean AS $FUNCTION_BODY$
DECLARE
  team_value TEXT;
  has_team BOOLEAN := false;
  sens_expanded TEXT[];
BEGIN
  IF app_knowledge.dimension_allows('*', '*') THEN
    RETURN true;
  END IF;

  -- Sensitivity is a cumulative ladder (not exact-match): expand the caller's grants
  -- (both the namespaced `knowledge:sensitivity` and the bare `sensitivity` dimension)
  -- and require the doc's tier to be covered.
  IF _sensitivity IS NOT NULL THEN
    sens_expanded := app_knowledge.expand_sensitivity_grants(
      app_knowledge.dimension_values('knowledge:sensitivity')
      || app_knowledge.dimension_values('sensitivity')
    );
    IF NOT ('*' = ANY(sens_expanded) OR _sensitivity = ANY(sens_expanded)) THEN
      RETURN false;
    END IF;
  END IF;

  IF _team IS NULL OR jsonb_array_length(_team) = 0 THEN
    RETURN true;
  END IF;

  FOR team_value IN SELECT jsonb_array_elements_text(_team) LOOP
    has_team := true;
    IF app_knowledge.dimension_allows('knowledge:team', team_value)
      OR app_knowledge.dimension_allows('team', team_value) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN NOT has_team;
END;
$FUNCTION_BODY$ LANGUAGE plpgsql STABLE;
ALTER FUNCTION app_knowledge.can_read_knowledge_dimensions(JSONB, TEXT) OWNER TO liaison_admin;

CREATE POLICY knowledge_documents_select ON app_knowledge.documents FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (archived_at IS NULL OR app_knowledge.app_has_scope('knowledge:documents:archive') OR app_knowledge.app_has_scope('knowledge:documents:admin'))
    AND (
      (
        -- BS-4: personal docs are SELECT-able only by their owner AND only
        -- when the caller carries `knowledge:documents:read`. Without the
        -- scope check, a session that strictly speaking has no read scope at
        -- all could still enumerate the owner's personal drafts via raw SQL.
        document_scope = 'personal'
        AND owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        AND app_knowledge.app_has_scope('knowledge:documents:read')
      )
      OR (
        document_scope = 'organization'
        AND app_knowledge.app_has_scope('knowledge:documents:read')
        AND app_knowledge.can_read_knowledge_dimensions(team, sensitivity)
      )
      OR (
        -- A document's CREATOR (or owner) always reads back their OWN doc, regardless of the
        -- sensitivity ladder. Without this, creating a confidential doc fails its own
        -- post-insert read ("Knowledge document not found after insert") whenever the creator
        -- lacks a confidential sensitivity grant — you must be able to see what you just
        -- authored. Additive (only widens visibility for the author); still scope-gated.
        app_knowledge.app_has_scope('knowledge:documents:read')
        AND (
          created_by = nullif(current_setting('app.current_user_id', true), '')::uuid
          OR owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        )
      )
    )
  );
CREATE POLICY knowledge_documents_insert ON app_knowledge.documents FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:create')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (
      document_scope <> 'personal'
      OR owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
    AND (document_scope <> 'organization' OR app_knowledge.can_read_knowledge_dimensions(team, sensitivity))
  );
CREATE POLICY knowledge_documents_update ON app_knowledge.documents FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (
      -- PERSONAL docs are an owner-only private workspace: only the owner (or an admin) may write them.
      -- ORGANIZATION docs are SHARED, collaboratively-maintained org knowledge — any member who can READ
      -- the doc (the dimension check below) AND holds knowledge:documents:update may MAINTAIN it, even
      -- when they are not its original owner_user_id. This MIRRORS the service-layer authz
      -- (assertCanWriteDocumentRow: an org doc + update-scope is the write gate, BL-275/l724). Before this,
      -- the RLS USING clause was OWNER-ONLY for EVERY scope, so an org doc updated by a non-owner (e.g. a
      -- routine tick whose RLS app.current_user_id is not the doc's owner) silently matched ZERO rows: the
      -- UPDATE ran, affected 0 rows, the service reloaded the unchanged revision-0 row and returned
      -- "success" — a knowledge.update that CLAIMED to land but wrote nothing (BL-277 root cause: the
      -- firmware-keep-fresh routine tick's troubleshooting-doc body update never persisted).
      document_scope = 'organization'
      OR owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (document_scope = 'personal' OR app_knowledge.can_read_knowledge_dimensions(team, sensitivity))
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:documents:update')
      OR app_knowledge.app_has_scope('knowledge:documents:admin')
    )
    AND (document_scope <> 'organization' OR app_knowledge.can_read_knowledge_dimensions(team, sensitivity))
  );
CREATE POLICY knowledge_documents_delete ON app_knowledge.documents FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:documents:admin'));

-- Spec §210: knowledge:documents:read covers Knowledge source links; we do not
-- invent a separate :source-links read scope. Writes to source_links require
-- knowledge:links:create (insert) or knowledge:documents:update (update/archive).
CREATE POLICY knowledge_source_links_select ON app_knowledge.source_links FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (archived_at IS NULL OR app_knowledge.app_has_scope('knowledge:sources:manage'))
    AND app_knowledge.app_has_scope('knowledge:documents:read')
  );
CREATE POLICY knowledge_source_links_insert ON app_knowledge.source_links FOR INSERT TO liaison_rls
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:links:create'));
CREATE POLICY knowledge_source_links_update ON app_knowledge.source_links FOR UPDATE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:documents:update'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:documents:update'));
CREATE POLICY knowledge_source_links_delete ON app_knowledge.source_links FOR DELETE TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:sources:manage'));

-- Registering a source_link (knowledge:links:create) inherently upserts the
-- backing source_identity (the per-(org,source,external_id) dedup key for the
-- remote doc). So the WITH CHECK must accept knowledge:links:create in addition
-- to knowledge:sources:manage (the curator-level manage-sources path) — otherwise
-- a links:create-only holder could never write the identity and the
-- knowledge:links:create scope would be unusable on its own (it gates the
-- source_links insert but not the prerequisite identity upsert). USING (reads)
-- stays at knowledge:sources:read.
CREATE POLICY knowledge_source_identities_rls ON app_knowledge.source_identities FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:sources:read'))
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      app_knowledge.app_has_scope('knowledge:sources:manage')
      OR app_knowledge.app_has_scope('knowledge:links:create')
    )
  );
CREATE POLICY knowledge_collections_rls ON app_knowledge.collections FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:documents:read'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:collections:manage'));
-- BS-5: split FOR ALL into FOR SELECT (per-row join through to the target's
-- visibility) + FOR INSERT/UPDATE/DELETE (scope check). The SELECT predicate
-- piggybacks on the documents/source_links RLS that already runs on the
-- joined sub-table — so a row only surfaces when the target itself is
-- readable to this caller.
CREATE POLICY knowledge_collection_memberships_select ON app_knowledge.collection_memberships
  FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:documents:read')
    AND (
      (target_type = 'document' AND EXISTS (
        SELECT 1 FROM app_knowledge.documents d
        WHERE d.id = collection_memberships.target_id
          AND d.org_id = collection_memberships.org_id
      ))
      OR (target_type = 'source_link' AND EXISTS (
        SELECT 1 FROM app_knowledge.source_links sl
        WHERE sl.id = collection_memberships.target_id
          AND sl.org_id = collection_memberships.org_id
      ))
    )
  );
-- INSERT/UPDATE/DELETE only — SELECT is governed by the per-row policy above.
-- (Postgres ORs PERMISSIVE policies on the same command, so a FOR ALL here
-- would defeat the target-visibility join for SELECT.)
CREATE POLICY knowledge_collection_memberships_insert ON app_knowledge.collection_memberships
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:collections:manage')
  );
CREATE POLICY knowledge_collection_memberships_update ON app_knowledge.collection_memberships
  FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:collections:manage')
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:collections:manage')
  );
CREATE POLICY knowledge_collection_memberships_delete ON app_knowledge.collection_memberships
  FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:collections:manage')
  );
CREATE POLICY knowledge_tags_rls ON app_knowledge.tags FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:documents:read'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:tags:manage'));
-- BS-5: see comment on collection_memberships above — same shape applied to
-- taggings.
CREATE POLICY knowledge_taggings_select ON app_knowledge.taggings
  FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:documents:read')
    AND (
      (target_type = 'document' AND EXISTS (
        SELECT 1 FROM app_knowledge.documents d
        WHERE d.id = taggings.target_id
          AND d.org_id = taggings.org_id
      ))
      OR (target_type = 'source_link' AND EXISTS (
        SELECT 1 FROM app_knowledge.source_links sl
        WHERE sl.id = taggings.target_id
          AND sl.org_id = taggings.org_id
      ))
    )
  );
CREATE POLICY knowledge_taggings_insert ON app_knowledge.taggings
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:tags:manage')
  );
CREATE POLICY knowledge_taggings_update ON app_knowledge.taggings
  FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:tags:manage')
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:tags:manage')
  );
CREATE POLICY knowledge_taggings_delete ON app_knowledge.taggings
  FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:tags:manage')
  );
CREATE POLICY knowledge_content_cache_entries_rls ON app_knowledge.content_cache_entries FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:sources:read'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:cache:manage'));
CREATE POLICY knowledge_source_policies_rls ON app_knowledge.source_policies FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:sources:read'))
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid AND app_knowledge.app_has_scope('knowledge:sources:manage'));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA app_knowledge TO liaison_rls, liaison_app, liaison_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app_knowledge TO liaison_rls, liaison_app, liaison_admin;

-- ============================================================================
-- Phase 10 — Platform Infrastructure
-- kernel.files       : file metadata (S3 objects stored externally)
-- kernel.attention_events : persisted attention deliveries (mentions, digests)
-- kernel.user_preferences : per-user digest cadence + always-on work-hours schedule
-- ============================================================================

CREATE TABLE IF NOT EXISTS kernel.files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id UUID NOT NULL,
  app TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT,
  -- Nullable to support system-ingested files (inbound mail/ticket attachments)
  -- where no human actor is attributable. End-user uploads always set this.
  uploaded_by UUID REFERENCES kernel.users(id),
  disposition TEXT NOT NULL DEFAULT 'attachment'
    CHECK (disposition IN ('attachment', 'inline')),
  content_id TEXT,
  original_content_id TEXT,
  ordinal INTEGER NOT NULL DEFAULT 0,
  -- When this row is a copy of another file (an agent attaching an existing
  -- file onto a new entity via attachFileToParent), points at the source
  -- file's id. Null for originally-uploaded files. Drives copy provenance
  -- and idempotency.
  copied_from_id UUID,
  -- Media-analysis columns — nullable, async-populated by the analyze_media
  -- kernel tool / slow-path job. Absence (all null) means "never analyzed".
  -- No default — nullable so existing rows + un-analyzed inbound attachments
  -- are valid.
  analysis_status TEXT,
  analysis_summary TEXT,
  analysis_model TEXT,
  analysis_at TIMESTAMPTZ,
  analysis_error TEXT,
  analysis_context_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kernel.files OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_files_parent ON kernel.files (org_id, app, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_files_org_created ON kernel.files (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_parent_ordinal
  ON kernel.files (org_id, app, entity_type, entity_id, ordinal, created_at, id);
-- Partial UNIQUE — makes attachFileToParent's idempotency race-proof: two
-- concurrent gated-handler retries copying the same source onto the same
-- parent cannot both insert. Partial so it never constrains uploaded files.
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_copied_from
  ON kernel.files (org_id, app, entity_type, entity_id, copied_from_id)
  WHERE copied_from_id IS NOT NULL;
ALTER TABLE kernel.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.files FORCE ROW LEVEL SECURITY;
-- Initial placeholder SELECT policy; runtime rebuilds via DDL after manifest registration.
CREATE POLICY files_select ON kernel.files FOR SELECT TO liaison_rls USING (false);
-- INSERT/DELETE are kernel-only; liaison_admin BYPASSRLS handles them.
-- I-DB-4 — org referential integrity + cascade so org deletion reaps file
-- metadata rows (object-storage byte reclamation is handled out-of-band).
ALTER TABLE kernel.files
  ADD CONSTRAINT files_org_fk
  FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- kernel.file_upload_sessions
-- Pre-message staging parent for attachments uploaded before the final message
-- entity exists (composer drafts, ticket replies, mail drafts). Sessions store
-- the validated target parent + owner so `authorizeUpload` can defer permission
-- checks to the eventual target, and `moveFilesToParent` can verify ownership
-- before reparenting.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kernel.file_upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  target_app TEXT NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
ALTER TABLE kernel.file_upload_sessions OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS idx_file_upload_sessions_owner
  ON kernel.file_upload_sessions (org_id, created_by, expires_at);
ALTER TABLE kernel.file_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.file_upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY file_upload_sessions_owner ON kernel.file_upload_sessions FOR ALL TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
  );

CREATE TABLE IF NOT EXISTS kernel.attention_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  urgency SMALLINT NOT NULL CHECK (urgency BETWEEN 0 AND 100),
  summary TEXT NOT NULL,
  actor_id UUID,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent','system','mcp')),
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  read_at TIMESTAMPTZ,
  is_urgent BOOLEAN NOT NULL DEFAULT false,
  digest_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (digest_state IN ('pending','sent','suppressed','not_eligible')),
  digest_eligible_at TIMESTAMPTZ NOT NULL,
  email_only BOOLEAN NOT NULL DEFAULT false,
  source_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kernel.attention_events OWNER TO liaison_admin;
-- I-DB-4 — org referential integrity + cascade (user_id already cascades inline).
ALTER TABLE kernel.attention_events
  ADD CONSTRAINT attention_events_org_fk
  FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_attention_unread
  ON kernel.attention_events (org_id, user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attention_digest
  ON kernel.attention_events (digest_state, digest_eligible_at) WHERE digest_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_attention_entity
  ON kernel.attention_events (org_id, app, entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_unread_dedupe
  ON kernel.attention_events (user_id, app, entity_type, entity_id, kind)
  WHERE read_at IS NULL AND email_only = false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_email_only_source
  ON kernel.attention_events (user_id, source_key)
  WHERE email_only = true AND source_key IS NOT NULL;
ALTER TABLE kernel.attention_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.attention_events FORCE ROW LEVEL SECURITY;
CREATE POLICY attention_events_user_rls ON kernel.attention_events FOR ALL TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

CREATE TABLE IF NOT EXISTS kernel.user_preferences (
  user_id UUID PRIMARY KEY REFERENCES kernel.users(id) ON DELETE CASCADE,
  digest_cadence TEXT NOT NULL DEFAULT 'daily'
    CHECK (digest_cadence IN ('immediate','hourly','daily','off')),
  work_hours_start TIME NOT NULL DEFAULT '09:00',
  work_hours_end TIME NOT NULL DEFAULT '17:00',
  -- ISO weekday numbers: 1=Mon … 7=Sun. Must contain at least one entry.
  work_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}'::smallint[]
    CHECK (
      array_length(work_days, 1) >= 1
      AND work_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
    ),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- Per-user UI language (Phase 13, I4). Shipped locale set is enforced in the
  -- app layer (packages/shared SHIPPED_LOCALES); an unshipped persisted value
  -- resolves to 'en' at read time (preferences-service mapRow clamp).
  language TEXT NOT NULL DEFAULT 'en',
  -- Per-user UI theme preference (Phase 14). 'system' resolves to OS preference
  -- client-side via prefers-color-scheme; 'light' / 'dark' force explicit mode.
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system','light','dark')),
  -- Per-user "magic wand" custom instruction (tone/style). NULL = plain
  -- spelling/grammar correction only. Length-capped at the route layer (2000).
  magic_wand_instructions TEXT,
  last_daily_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kernel.user_preferences OWNER TO liaison_admin;
ALTER TABLE kernel.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.user_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_preferences_self_rls ON kernel.user_preferences FOR ALL TO liaison_rls
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.files TO liaison_rls, liaison_app, liaison_admin;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.file_upload_sessions TO liaison_rls, liaison_app, liaison_admin;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.attention_events TO liaison_rls, liaison_app, liaison_admin;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.user_preferences TO liaison_rls, liaison_app, liaison_admin;

-- ============================================================================
-- Phase 12 — MCP Server
-- ============================================================================

-- Decided gated tool result — written once on successful decided execution,
-- read by the liaison_approval_status meta-tool. Nullable: pre-decision rows
-- and read-only tools have result IS NULL.
ALTER TABLE kernel.approved_handler_executions ADD COLUMN IF NOT EXISTS result jsonb;

-- Dynamically Registered OAuth clients (RFC 7591). Public PKCE clients — no secret stored.
CREATE TABLE IF NOT EXISTS kernel.mcp_oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT,
  redirect_uris TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kernel.mcp_oauth_clients OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS mcp_oauth_clients_client_id_idx
  ON kernel.mcp_oauth_clients (client_id);
-- Privileged-only (OAuth server runs via withSystemDb, BYPASSRLS) — no liaison_rls access.
REVOKE ALL ON kernel.mcp_oauth_clients FROM liaison_rls;

-- Durable per-client credential. NOT subject to the login session cap (explicit
-- divergence from kernel.sessions): no eviction, no cap. Owner delete cascades.
CREATE TABLE IF NOT EXISTS kernel.mcp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  label TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  thread_id UUID,
  discovered_tools TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kernel.mcp_connections OWNER TO liaison_admin;
CREATE INDEX IF NOT EXISTS mcp_connections_user_idx ON kernel.mcp_connections (user_id);
CREATE INDEX IF NOT EXISTS mcp_connections_org_idx ON kernel.mcp_connections (org_id);
-- Privileged-only (connection service runs via withSystemDb, BYPASSRLS) — no liaison_rls access.
REVOKE ALL ON kernel.mcp_connections FROM liaison_rls;

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.mcp_oauth_clients TO liaison_app, liaison_admin;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON kernel.mcp_connections TO liaison_app, liaison_admin;


--> statement-breakpoint
-- ══════════════════════════════════════════════════════════════════════════
-- Apps installed (folded from 0001_apps_installed.sql)
-- ══════════════════════════════════════════════════════════════════════════
-- Runtime-installed apps (`.liaisonapp` packages). Instance-wide, not per-org.
-- Privileged-only: the install service is the sole writer and runs via
-- withSystemDb (BYPASSRLS). The composite (name, version) PK lets multiple
-- versions coexist during an atomic upgrade swap.
CREATE TABLE "kernel"."apps_installed" (
  "name" text NOT NULL,
  "version" text NOT NULL,
  "source_url" text NOT NULL,
  "update_url" text,
  "sha256" text NOT NULL,
  "signature_bundle" text,
  "granted_scopes" text[] DEFAULT '{}' NOT NULL,
  "granted_connections" text[] DEFAULT '{}' NOT NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "installed_by" uuid NOT NULL,
  -- Phase 17 C2 — persisted snapshot of the app's PDF templates so the kernel
  -- PDF registry can be rehydrated at boot without re-reading the tarball.
  -- Each entry: { kind: string, source: string }. `source` is the transpiled
  -- JS body the PDF worker executes via new Function("data","pdfLib", source).
  "pdf_templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "apps_installed_name_version_pk" PRIMARY KEY("name","version")
);
--> statement-breakpoint
-- One row per app names the currently-active (registered) version.
CREATE TABLE "kernel"."apps_active_version" (
  "name" text PRIMARY KEY NOT NULL,
  "version" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kernel"."apps_installed" OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE "kernel"."apps_active_version" OWNER TO liaison_admin;
--> statement-breakpoint
-- Privileged-only — no liaison_rls access. A kernel table reachable from an
-- RLS-scoped tenant session with write grants but no RLS policy would let any
-- app handler forge an install row (arbitrary app + arbitrary granted scopes)
-- or silently widen an existing app's scopes. The install service only ever
-- touches these tables via withSystemDb, so revoke all tenant access outright.
-- (`ALTER DEFAULT PRIVILEGES` in 0000 auto-grants new tables to liaison_rls —
-- this REVOKE is what makes the tables privileged-only.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    REVOKE ALL ON "kernel"."apps_installed" FROM liaison_rls;
    REVOKE ALL ON "kernel"."apps_active_version" FROM liaison_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."apps_installed" TO liaison_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."apps_active_version" TO liaison_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."apps_installed" TO liaison_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."apps_active_version" TO liaison_app;
  END IF;
END
$$;

--> statement-breakpoint
-- ══════════════════════════════════════════════════════════════════════════
-- Phase 17 K3 — gapless app sequence allocator (kernel.app_sequences)
-- ══════════════════════════════════════════════════════════════════════════
-- Atomically allocates monotonic integers per (org_id, app_id, key). The
-- allocator runs INSIDE the calling tool-handler's transaction and uses
-- `pg_advisory_xact_lock(hashtextextended(key, 0))` so two concurrent
-- transactions on the same key serialize. The lock auto-releases at
-- commit/rollback — which gives the table its gapless property: a rolled-
-- back allocation does not consume a value.
CREATE TABLE IF NOT EXISTS "kernel"."app_sequences" (
  "org_id" uuid NOT NULL,
  "app_id" text NOT NULL,
  "key" text NOT NULL,
  "value" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "app_sequences_pk" PRIMARY KEY ("org_id", "app_id", "key")
);
--> statement-breakpoint
ALTER TABLE "kernel"."app_sequences" OWNER TO liaison_admin;
--> statement-breakpoint
-- B14 — The gapless allocator runs INSIDE the calling tool-handler's ambient
-- transaction so a rollback releases the advisory lock without consuming a
-- value. For UNTRUSTED sandboxed apps that tx runs under liaison_rls (see
-- packages/test-helpers db.ts + the sandbox bridge), so liaison_rls needs DML
-- here too — otherwise ctx.sequences.allocate() fails with "permission denied"
-- and document numbering (K3) is unreachable for every bundled app. The bridge
-- namespaces every key by the calling app id (`key must start with "<appId>:"`),
-- but the table is also org-scoped, so we ENABLE + FORCE RLS and add an
-- org-scoped policy rather than leaving RLS off — that keeps one org from
-- reading/incrementing another org's counters while the allocator continues to
-- work under liaison_rls (it always supplies org_id = the actor's org).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."app_sequences" TO liaison_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."app_sequences" TO liaison_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."app_sequences" TO liaison_app;
  END IF;
END
$$;
--> statement-breakpoint
-- app_sequences is owned by liaison_admin (NOBYPASSRLS); FORCE so the owner is
-- not exempt. The ALL policy covers the allocator's INSERT … ON CONFLICT DO
-- UPDATE: USING gates the update-conflict path, WITH CHECK gates the insert and
-- the post-update row — both pinned to the current org GUC.
ALTER TABLE "kernel"."app_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kernel"."app_sequences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_sequences_org_rls ON "kernel"."app_sequences" FOR ALL TO liaison_rls
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint
-- I-DB-4 — org referential integrity + cascade so deleting an org reaps its
-- per-app sequence counters.
ALTER TABLE "kernel"."app_sequences"
  ADD CONSTRAINT app_sequences_org_fk
  FOREIGN KEY (org_id) REFERENCES kernel.organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
-- ══════════════════════════════════════════════════════════════════════════
-- Knowledge synced sources (folded from 0002_knowledge_synced_sources.sql)
-- ══════════════════════════════════════════════════════════════════════════
-- 0002_knowledge_synced_sources
--
-- Adds the `synced_sources` config table for mounting external folder trees
-- (Drive, GitHub, ...) into the Knowledge workspace, plus the columns on
-- `documents` that mark a document as a read-only materialization of one of
-- those mounted files. See docs / plan: pipeline 2026-05-24-knowledge-app-synced-read-only.

CREATE TABLE IF NOT EXISTS app_knowledge.synced_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  folder_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  root_collection_id UUID NOT NULL REFERENCES app_knowledge.collections(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES kernel.users(id) ON DELETE CASCADE,
  default_sensitivity TEXT,
  -- Minimum effective interval is ~2x the tick period (60s tick + 60s floor =
  -- ~120s cadence in practice). The DB floor here only prevents pathological
  -- config; the Settings UI surfaces the realistic minimum.
  sync_interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (sync_interval_seconds >= 60),
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (last_sync_status IN ('idle','running','ok','error')),
  last_error TEXT,
  created_by UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT knowledge_synced_sources_scope_sensitivity_check CHECK (
    (owner_user_id IS NOT NULL AND default_sensitivity IS NULL)
    OR (owner_user_id IS NULL AND default_sensitivity IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE app_knowledge.synced_sources OWNER TO liaison_admin;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_synced_sources_org
  ON app_knowledge.synced_sources (org_id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_synced_sources_owner
  ON app_knowledge.synced_sources (org_id, owner_user_id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_synced_sources_due
  ON app_knowledge.synced_sources (last_sync_at)
  WHERE archived_at IS NULL AND last_sync_status IN ('idle','ok','error');
--> statement-breakpoint
-- documents: provenance + read-only marker
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS synced_source_id UUID
    REFERENCES app_knowledge.synced_sources(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS source_identity_id UUID
    REFERENCES app_knowledge.source_identities(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS external_path TEXT;
--> statement-breakpoint
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS external_rev TEXT;
--> statement-breakpoint
-- Denormalized per-document sync timestamp; saves a JOIN on the GET hot path
-- (force-on-open staleness check).
ALTER TABLE app_knowledge.documents
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE app_knowledge.documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_synced_pair_check;
--> statement-breakpoint
ALTER TABLE app_knowledge.documents
  ADD CONSTRAINT knowledge_documents_synced_pair_check CHECK (
    (synced_source_id IS NULL AND source_identity_id IS NULL)
    OR (synced_source_id IS NOT NULL AND source_identity_id IS NOT NULL)
  );
--> statement-breakpoint
-- Synced documents are immutable from the application's perspective. The
-- reconciler is the only writer (running as system via withSystemDb) and it
-- only advances external_rev / last_synced_at — never `revision`. Enforce at
-- the DB layer so the agent tool surface and any bulk paths can't accidentally
-- bump a synced doc's revision counter.
ALTER TABLE app_knowledge.documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_synced_revision_check;
--> statement-breakpoint
ALTER TABLE app_knowledge.documents
  ADD CONSTRAINT knowledge_documents_synced_revision_check CHECK (
    synced_source_id IS NULL OR revision = 0
  );
--> statement-breakpoint
-- One active materialized document per (synced_source, identity).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_documents_synced_identity_active
  ON app_knowledge.documents (synced_source_id, source_identity_id)
  WHERE archived_at IS NULL AND synced_source_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_synced_source
  ON app_knowledge.documents (synced_source_id) WHERE synced_source_id IS NOT NULL;
--> statement-breakpoint
-- source_links: provenance. Which synced_source materialized this link; NULL =
-- a manual link (linkRemoteDocument). The reconciler scopes its archival pass by
-- this column so syncing one source never archives another synced source's links
-- or a manual link that happens to share the same `source` app name.
ALTER TABLE app_knowledge.source_links
  ADD COLUMN IF NOT EXISTS synced_source_id UUID
    REFERENCES app_knowledge.synced_sources(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_knowledge_source_links_synced_source
  ON app_knowledge.source_links (synced_source_id) WHERE synced_source_id IS NOT NULL;
--> statement-breakpoint
-- RLS for synced_sources.
-- SELECT: any caller who can read Knowledge in this org sees org-shared rows
-- (owner_user_id IS NULL) and their own personal rows.
-- INSERT/UPDATE/DELETE: gated on knowledge:sources:manage. The service layer
-- additionally narrows personal-row writes to the row owner.
ALTER TABLE app_knowledge.synced_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_knowledge.synced_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY knowledge_synced_sources_select ON app_knowledge.synced_sources
  FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_knowledge.app_has_scope('knowledge:documents:read')
    AND (
      owner_user_id IS NULL
      OR owner_user_id = current_setting('app.current_user_id', true)::uuid
    )
  );
--> statement-breakpoint
CREATE POLICY knowledge_synced_sources_insert ON app_knowledge.synced_sources
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      -- Personal sources: any reader can mount one for themselves.
      (owner_user_id = current_setting('app.current_user_id', true)::uuid
       AND app_knowledge.app_has_scope('knowledge:documents:read'))
      OR
      -- Org-shared sources: require sources:manage.
      (owner_user_id IS NULL
       AND app_knowledge.app_has_scope('knowledge:sources:manage'))
    )
  );
--> statement-breakpoint
CREATE POLICY knowledge_synced_sources_update ON app_knowledge.synced_sources
  FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (owner_user_id = current_setting('app.current_user_id', true)::uuid
       AND app_knowledge.app_has_scope('knowledge:documents:read'))
      OR
      (owner_user_id IS NULL
       AND app_knowledge.app_has_scope('knowledge:sources:manage'))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (owner_user_id = current_setting('app.current_user_id', true)::uuid
       AND app_knowledge.app_has_scope('knowledge:documents:read'))
      OR
      (owner_user_id IS NULL
       AND app_knowledge.app_has_scope('knowledge:sources:manage'))
    )
  );
--> statement-breakpoint
CREATE POLICY knowledge_synced_sources_delete ON app_knowledge.synced_sources
  FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (owner_user_id = current_setting('app.current_user_id', true)::uuid
       AND app_knowledge.app_has_scope('knowledge:documents:read'))
      OR
      (owner_user_id IS NULL
       AND app_knowledge.app_has_scope('knowledge:sources:manage'))
    )
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES
  ON app_knowledge.synced_sources TO liaison_rls, liaison_app, liaison_admin;


--> statement-breakpoint
-- ══════════════════════════════════════════════════════════════════════════
-- App: mcp-manager (folded from 0003_app_mcp_manager.sql)
-- ══════════════════════════════════════════════════════════════════════════
-- 0003_app_mcp_manager
--
-- Adds the `app_mcp_manager` schema for the MCP Client (inbound) feature:
-- five tables — connections, tool policy, resource subscriptions, OAuth state,
-- and connection health — plus an `app_has_scope` helper, RLS policies, and
-- privilege grants. See pipeline 2026-05-24-feature-mcp-support-before-we.

CREATE SCHEMA IF NOT EXISTS app_mcp_manager;
--> statement-breakpoint
ALTER SCHEMA app_mcp_manager OWNER TO liaison_admin;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA app_mcp_manager TO liaison_admin, liaison_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app_mcp_manager TO liaison_rls;
--> statement-breakpoint

-- ============================================================================
-- Enums
-- ============================================================================
CREATE TYPE app_mcp_manager.mcp_transport AS ENUM ('stdio','http','sse');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_ownership_scope AS ENUM ('org','personal');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_auth_flavor AS ENUM ('none','bearer','oauth_dcr','oauth_static');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_agent_visibility AS ENUM ('discoverable','hidden');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_default_policy AS ENUM ('auto','gate_writes','gate_all');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_managed_by AS ENUM ('env','ui');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_decision AS ENUM ('auto','gate','deny');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_subscriber_actor_type AS ENUM ('user','agent');
--> statement-breakpoint
CREATE TYPE app_mcp_manager.mcp_connection_health_status AS ENUM
  ('connected','idle','dialing','down','failed','needs_reauth');
--> statement-breakpoint

-- ============================================================================
-- Scope helper — mirrors app_projects.app_has_scope (0000_initial.sql:2540).
-- ============================================================================
CREATE OR REPLACE FUNCTION app_mcp_manager.app_has_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT
    current_setting('app.current_scopes', true) = '*'
    OR EXISTS (
      SELECT 1
      FROM unnest(string_to_array(current_setting('app.current_scopes', true), ',')) AS g
      WHERE g = '*'
        OR g = _scope
        OR g = split_part(_scope, ':', 1) || ':*'
        OR g = split_part(_scope, ':', 1)
        OR starts_with(_scope, g || ':')
    );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
ALTER FUNCTION app_mcp_manager.app_has_scope(TEXT) OWNER TO liaison_admin;
--> statement-breakpoint

-- ============================================================================
-- mcp_connections
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_mcp_manager.mcp_connections (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  slug                        TEXT NOT NULL CHECK (slug ~ '^[a-z0-9-]+$' AND length(slug) BETWEEN 1 AND 32),
  display_name                TEXT NOT NULL,
  transport                   app_mcp_manager.mcp_transport NOT NULL,
  ownership_scope             app_mcp_manager.mcp_ownership_scope NOT NULL DEFAULT 'org',
  owner_user_id               UUID REFERENCES kernel.users(id) ON DELETE CASCADE,
  http_url                    TEXT,
  stdio_command               TEXT,
  stdio_args                  TEXT[],
  auth_flavor                 app_mcp_manager.mcp_auth_flavor NOT NULL DEFAULT 'none',
  secrets_encrypted           TEXT,
  oauth_metadata              JSONB,
  agent_visibility            app_mcp_manager.mcp_agent_visibility NOT NULL DEFAULT 'discoverable',
  expose_via_gateway          BOOLEAN NOT NULL DEFAULT TRUE,
  connection_default_policy   app_mcp_manager.mcp_default_policy NOT NULL DEFAULT 'gate_writes',
  managed_by                  app_mcp_manager.mcp_managed_by NOT NULL DEFAULT 'ui',
  disabled                    BOOLEAN NOT NULL DEFAULT FALSE,
  rate_cap_per_minute         INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  UUID NOT NULL REFERENCES kernel.users(id) ON DELETE RESTRICT,
  CONSTRAINT mcp_connections_personal_owner_check CHECK (
    (ownership_scope = 'personal' AND owner_user_id IS NOT NULL) OR
    (ownership_scope = 'org'      AND owner_user_id IS NULL)
  ),
  CONSTRAINT mcp_connections_transport_config_check CHECK (
    (transport IN ('http','sse') AND http_url IS NOT NULL AND stdio_command IS NULL) OR
    (transport = 'stdio'          AND stdio_command IS NOT NULL AND http_url IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connections OWNER TO liaison_admin;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_mcp_connections_org_slug
  ON app_mcp_manager.mcp_connections (org_id, slug);
--> statement-breakpoint

-- ============================================================================
-- mcp_tool_policy
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_mcp_manager.mcp_tool_policy (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       UUID NOT NULL REFERENCES app_mcp_manager.mcp_connections(id) ON DELETE CASCADE,
  tool_name           TEXT NOT NULL,
  override_decision   app_mcp_manager.mcp_decision,
  role_overrides      JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_tool_policy OWNER TO liaison_admin;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_mcp_tool_policy_connection_tool
  ON app_mcp_manager.mcp_tool_policy (connection_id, tool_name);
--> statement-breakpoint

-- ============================================================================
-- mcp_resource_subscription
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_mcp_manager.mcp_resource_subscription (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id           UUID NOT NULL REFERENCES app_mcp_manager.mcp_connections(id) ON DELETE CASCADE,
  resource_uri            TEXT NOT NULL,
  subscriber_actor_id     UUID NOT NULL,
  subscriber_actor_type   app_mcp_manager.mcp_subscriber_actor_type NOT NULL,
  thread_id               UUID REFERENCES kernel.threads(id) ON DELETE CASCADE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_resource_subscription OWNER TO liaison_admin;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_mcp_resource_subscription_unique
  ON app_mcp_manager.mcp_resource_subscription
     (connection_id, resource_uri, subscriber_actor_id, subscriber_actor_type);
--> statement-breakpoint

-- ============================================================================
-- mcp_oauth_state
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_mcp_manager.mcp_oauth_state (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       UUID NOT NULL REFERENCES app_mcp_manager.mcp_connections(id) ON DELETE CASCADE,
  pkce_verifier       TEXT NOT NULL,
  state               TEXT NOT NULL,
  -- Bound at /oauth/start so the callback can verify the same session
  -- completes the flow. NULL only for legacy rows pre-dating B5 fix.
  initiator_user_id   UUID REFERENCES kernel.users(id) ON DELETE CASCADE,
  initiator_org_id    UUID REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_oauth_state OWNER TO liaison_admin;
--> statement-breakpoint

-- ============================================================================
-- mcp_connection_health (PK = connection_id, one row per connection)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_mcp_manager.mcp_connection_health (
  connection_id           UUID PRIMARY KEY REFERENCES app_mcp_manager.mcp_connections(id) ON DELETE CASCADE,
  status                  app_mcp_manager.mcp_connection_health_status NOT NULL DEFAULT 'idle',
  last_handshake_at       TIMESTAMPTZ,
  last_error_at           TIMESTAMPTZ,
  last_error              TEXT,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  server_capabilities     JSONB,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connection_health OWNER TO liaison_admin;
--> statement-breakpoint

-- ============================================================================
-- Row-Level Security
-- ============================================================================
-- mcp_connections: personal rows visible only to owner; org rows to anyone with
-- mcp_manager:connection:read in the org. Writes additionally require
-- mcp_manager:connection:write for org-shared, and owner-match for personal.
ALTER TABLE app_mcp_manager.mcp_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mcp_connections_deny_default ON app_mcp_manager.mcp_connections
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY mcp_connections_select ON app_mcp_manager.mcp_connections
  FOR SELECT TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:read')
    AND (
      ownership_scope = 'org'
      OR (ownership_scope = 'personal'
          AND owner_user_id = current_setting('app.current_user_id', true)::uuid)
    )
  );
--> statement-breakpoint
CREATE POLICY mcp_connections_insert ON app_mcp_manager.mcp_connections
  FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND created_by = current_setting('app.current_user_id', true)::uuid
    AND app_mcp_manager.app_has_scope('mcp_manager:connection:write')
    AND (
      (ownership_scope = 'personal'
       AND owner_user_id = current_setting('app.current_user_id', true)::uuid)
      OR
      (ownership_scope = 'org'
       AND owner_user_id IS NULL)
    )
  );
--> statement-breakpoint
CREATE POLICY mcp_connections_update ON app_mcp_manager.mcp_connections
  FOR UPDATE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (ownership_scope = 'personal'
       AND owner_user_id = current_setting('app.current_user_id', true)::uuid)
      OR
      (ownership_scope = 'org'
       AND app_mcp_manager.app_has_scope('mcp_manager:connection:write'))
    )
  )
  WITH CHECK (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (ownership_scope = 'personal'
       AND owner_user_id = current_setting('app.current_user_id', true)::uuid)
      OR
      (ownership_scope = 'org'
       AND app_mcp_manager.app_has_scope('mcp_manager:connection:write'))
    )
  );
--> statement-breakpoint
CREATE POLICY mcp_connections_delete ON app_mcp_manager.mcp_connections
  FOR DELETE TO liaison_rls
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      (ownership_scope = 'personal'
       AND owner_user_id = current_setting('app.current_user_id', true)::uuid)
      OR
      (ownership_scope = 'org'
       AND app_mcp_manager.app_has_scope('mcp_manager:connection:write'))
    )
  );
--> statement-breakpoint

-- mcp_tool_policy: visibility/writes piggyback on the parent connection's RLS.
ALTER TABLE app_mcp_manager.mcp_tool_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_tool_policy FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mcp_tool_policy_deny_default ON app_mcp_manager.mcp_tool_policy
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY mcp_tool_policy_select ON app_mcp_manager.mcp_tool_policy
  FOR SELECT TO liaison_rls
  USING (
    app_mcp_manager.app_has_scope('mcp_manager:policy:read')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_tool_policy.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
--> statement-breakpoint
CREATE POLICY mcp_tool_policy_modify ON app_mcp_manager.mcp_tool_policy
  FOR ALL TO liaison_rls
  USING (
    app_mcp_manager.app_has_scope('mcp_manager:policy:write')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_tool_policy.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    app_mcp_manager.app_has_scope('mcp_manager:policy:write')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_tool_policy.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
--> statement-breakpoint

-- mcp_resource_subscription: same join-through-parent pattern; the actor that
-- owns the subscription is the only writer; everyone with read on the parent
-- can see (so the manager UI can list).
ALTER TABLE app_mcp_manager.mcp_resource_subscription ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_resource_subscription FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mcp_resource_subscription_deny_default ON app_mcp_manager.mcp_resource_subscription
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY mcp_resource_subscription_select ON app_mcp_manager.mcp_resource_subscription
  FOR SELECT TO liaison_rls
  USING (
    app_mcp_manager.app_has_scope('mcp_manager:connection:read')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_resource_subscription.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
--> statement-breakpoint
CREATE POLICY mcp_resource_subscription_modify ON app_mcp_manager.mcp_resource_subscription
  FOR ALL TO liaison_rls
  USING (
    app_mcp_manager.app_has_scope('mcp_manager:connection:write')
    AND subscriber_actor_id = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_resource_subscription.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  )
  WITH CHECK (
    app_mcp_manager.app_has_scope('mcp_manager:connection:write')
    AND subscriber_actor_id = current_setting('app.current_user_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_resource_subscription.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
--> statement-breakpoint

-- mcp_oauth_state: writes happen through the kernel privileged path; the
-- manager UI never reads or writes them directly. Default-deny on liaison_rls.
ALTER TABLE app_mcp_manager.mcp_oauth_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_oauth_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mcp_oauth_state_deny_default ON app_mcp_manager.mcp_oauth_state
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
--> statement-breakpoint

-- mcp_connection_health: SELECT-only for the manager UI; INSERT/UPDATE/DELETE
-- only via withSystemDb (kernel). Same default-deny baseline + a read policy.
ALTER TABLE app_mcp_manager.mcp_connection_health ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_mcp_manager.mcp_connection_health FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mcp_connection_health_deny_default ON app_mcp_manager.mcp_connection_health
  FOR ALL TO liaison_rls USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY mcp_connection_health_select ON app_mcp_manager.mcp_connection_health
  FOR SELECT TO liaison_rls
  USING (
    app_mcp_manager.app_has_scope('mcp_manager:connection:read')
    AND EXISTS (
      SELECT 1 FROM app_mcp_manager.mcp_connections c
      WHERE c.id = mcp_connection_health.connection_id
        AND c.org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
--> statement-breakpoint

-- ============================================================================
-- Privileges
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES
  ON ALL TABLES IN SCHEMA app_mcp_manager
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app_mcp_manager
  TO liaison_rls, liaison_app, liaison_admin;


--> statement-breakpoint
-- ══════════════════════════════════════════════════════════════════════════
-- Sub-agent dispatch primitive (folded from 0004_sub_agent_dispatch.sql)
-- ══════════════════════════════════════════════════════════════════════════
-- 0004_sub_agent_dispatch
--
-- Adds the sub-agent dispatch primitive (pipeline 2026-05-25-quick-planning-add-a-sub-4f7f):
--   * threads.type — drop the old CHECK constraint and re-add it with 'subrun'
--                    as a new allowed value (paired with hidden_from_list=true
--                    by the spawn-agent flow)
--
--   * kernel.agent_runs            — every agent execution (root or sub) gets a row
--   * kernel.sub_agent_definitions — declarative sub-agent role registry, one row per
--                                    (org, agentType)
--   * audit_log_run_metadata_idx    — partial GIN on audit_log.metadata for cheap
--                                    queries by runId / parentRunId (linkage lives
--                                    in metadata JSONB; no top-level FK columns)
--
-- Hidden subrun threads reuse the existing kernel.threads columns: a new allowed
-- value `subrun` on `threads.type` (plain-text column, no enum) paired with the
-- existing `threads.hidden_from_list = true` boolean. No DDL change to threads.
--
-- RLS:
--   * agent_runs        — scoped to participants of the run's thread_id
--   * sub_agent_defs    — scoped to org members (any reader within the org)
--
-- Cascades:
--   * org delete       cascades to both new tables
--   * parent run delete cascades to children (parent_run_id)
--   * root run delete   cascades to all descendants (root_run_id, deferred FK)
--   * thread delete    cascades to the matching agent_run row

-- threads.type CHECK constraint extension: 'subrun' joins the allowed set.
-- The original constraint in 0000_initial.sql restricts type to
-- ('thread','agent_chat','approval','routine'); we drop and re-add to widen.
ALTER TABLE "kernel"."threads" DROP CONSTRAINT IF EXISTS "threads_type_check";
--> statement-breakpoint
ALTER TABLE "kernel"."threads" ADD CONSTRAINT "threads_type_check"
  CHECK (type IN ('thread','agent_chat','approval','routine','subrun'));
--> statement-breakpoint

CREATE TABLE "kernel"."agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "kernel"."organizations"("id") ON DELETE CASCADE,
  "parent_run_id" uuid REFERENCES "kernel"."agent_runs"("id") ON DELETE CASCADE,
  "root_run_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "kernel"."threads"("id") ON DELETE CASCADE,
  -- The parent's surface thread id (where the collapsed sub_run card lives).
  -- Equal to thread_id for root runs; for sub-runs this points at the parent's
  -- thread so the worker can emit WS update events carrying it (the frontend
  -- store keyed by threadId then finds and patches the card message in place).
  "parent_thread_id" uuid REFERENCES "kernel"."threads"("id") ON DELETE CASCADE,
  -- Null for root chat runs; set to the role slug for sub-runs.
  "subagent_type" text,
  -- JSONB snapshot of the ActorContext (user or system actor) that owns the run.
  "actor" jsonb NOT NULL,
  -- Computed intersection of parent scopes ∩ role ceiling ∩ call-site narrowing.
  "effective_scopes" text[] NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'queued'
    CHECK ("status" IN ('queued','running','done','failed','cancelled')),
  "prompt" text NOT NULL,
  "input" jsonb,
  "output" jsonb,
  "output_schema" jsonb,
  "summary" text,
  "error_code" text,
  "error_message" text,
  "usage_prompt_tokens" integer NOT NULL DEFAULT 0,
  "usage_completion_tokens" integer NOT NULL DEFAULT 0,
  "credit_cost" numeric NOT NULL DEFAULT 0,
  "max_steps" integer NOT NULL,
  "timeout_ms" integer NOT NULL,
  "schema_retry_budget" integer NOT NULL,
  "schema_retry_count" integer NOT NULL DEFAULT 0,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "nesting_depth" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- root_run_id self-reference: root runs point to themselves; sub-runs to their
-- top ancestor. Deferred so a single statement using gen_random_uuid() can capture
-- the new id and set root_run_id = id atomically.
ALTER TABLE "kernel"."agent_runs"
  ADD CONSTRAINT "agent_runs_root_run_fk"
  FOREIGN KEY ("root_run_id") REFERENCES "kernel"."agent_runs"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX "agent_runs_org_parent_idx" ON "kernel"."agent_runs" ("org_id","parent_run_id");
--> statement-breakpoint
CREATE INDEX "agent_runs_org_root_idx" ON "kernel"."agent_runs" ("org_id","root_run_id");
--> statement-breakpoint
CREATE INDEX "agent_runs_org_status_idx" ON "kernel"."agent_runs" ("org_id","status");
--> statement-breakpoint
CREATE INDEX "agent_runs_org_thread_idx" ON "kernel"."agent_runs" ("org_id","thread_id");
--> statement-breakpoint

CREATE TABLE "kernel"."sub_agent_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "kernel"."organizations"("id") ON DELETE CASCADE,
  "app_name" text NOT NULL,
  "agent_type" text NOT NULL,
  "when_to_use" text NOT NULL,
  "scope_ceiling" text[] NOT NULL DEFAULT '{}',
  "tool_allowlist" text[],
  "tool_denylist" text[],
  "skills" text[] NOT NULL DEFAULT '{}',
  "mcp_servers" text[] NOT NULL DEFAULT '{}',
  "system_prompt" text NOT NULL,
  "default_max_steps" integer,
  "default_timeout_ms" integer,
  "default_schema_retry_budget" integer,
  "context_profile" text NOT NULL DEFAULT 'standard'
    CHECK ("context_profile" IN ('minimal','standard','full')),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sub_agent_definitions_org_type_idx"
  ON "kernel"."sub_agent_definitions" ("org_id","agent_type");
--> statement-breakpoint

-- audit_log: no column changes. Sub-run linkage (runId, parentRunId) lives in
-- metadata->>'runId' / metadata->>'parentRunId'. The partial GIN index keeps
-- ad-hoc audit queries cheap without paying index cost on rows that never carry
-- run metadata (webhooks, cron jobs, etc.).
CREATE INDEX IF NOT EXISTS "audit_log_run_metadata_idx"
  ON "kernel"."audit_log" USING gin ("metadata" jsonb_path_ops)
  WHERE "metadata" ? 'runId';
--> statement-breakpoint

-- Ownership + privileges follow the existing kernel convention. RLS is enabled
-- on both new tables (tenant readers must be participants of the run's thread,
-- or members of the org for definitions). The install service / kernel worker
-- writes go through withPrivilegedDb (liaison_admin), bypassing RLS.
ALTER TABLE "kernel"."agent_runs" OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE "kernel"."sub_agent_definitions" OWNER TO liaison_admin;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."agent_runs" TO liaison_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."sub_agent_definitions" TO liaison_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."agent_runs" TO liaison_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "kernel"."sub_agent_definitions" TO liaison_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    GRANT SELECT ON "kernel"."agent_runs" TO liaison_rls;
    GRANT SELECT ON "kernel"."sub_agent_definitions" TO liaison_rls;
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "kernel"."agent_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- m13 — these tables are owned by liaison_admin (NOBYPASSRLS), so without FORCE
-- the owner is exempt from the policy. FORCE so the org/participant scoping
-- below applies to every role, including the owner.
ALTER TABLE "kernel"."agent_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "agent_runs_select" ON "kernel"."agent_runs"
  FOR SELECT TO liaison_rls USING (
    "org_id" = current_setting('app.current_org_id', true)::uuid
    AND EXISTS (
      SELECT 1 FROM "kernel"."thread_participants" tp
      WHERE tp."thread_id" = "agent_runs"."thread_id"
        AND tp."user_id" = current_setting('app.current_user_id', true)::uuid
        AND tp."org_id" = "agent_runs"."org_id"
    )
  );
--> statement-breakpoint

ALTER TABLE "kernel"."sub_agent_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- m13 — FORCE so the liaison_admin owner is not exempt from the org policy.
ALTER TABLE "kernel"."sub_agent_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sub_agent_definitions_select" ON "kernel"."sub_agent_definitions"
  FOR SELECT TO liaison_rls USING (
    "org_id" = current_setting('app.current_org_id', true)::uuid
  );
