-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.push_tokens (P7-T11): one registered mobile device token per
-- (user, platform, token).
--
-- RLS IS OWNERSHIP, NOT MEMBERSHIP, and that is the whole point of the table.
-- Every other kernel table lets a member of the org read the org's rows; a
-- device token is the ADDRESS of one person's phone, so the same rule here
-- would hand every colleague a way to address that phone directly. So the
-- policies read `user_id = app.current_user_id` on top of the usual org pin,
-- on all four verbs, and there is deliberately NO widening branch for an
-- admin scope: a `*` holder has no business enumerating the org's devices.
--
-- THE FANOUT WORKER DOES NOT GO THROUGH THESE POLICIES. It must address every
-- recipient of an event, which is by definition other people's rows, so it
-- reads through the privileged (liaison_admin, BYPASSRLS) connection, the same
-- way every other background reader in the tree does. Adding a system branch
-- to the policy instead would put the cross-user read behind a GUC any RLS
-- caller can be given, which is a wider hole than the one it closes.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t
                  JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'push_platform' AND n.nspname = 'kernel') THEN
    CREATE TYPE kernel.push_platform AS ENUM ('ios', 'android');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  platform kernel.push_platform NOT NULL,
  token text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The upsert target of POST /api/push/tokens: one row per device, re-registered
-- on every launch without accumulating a row per launch.
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_user_platform_token_idx
  ON kernel.push_tokens (user_id, platform, token);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS push_tokens_org_user_idx
  ON kernel.push_tokens (org_id, user_id);
--> statement-breakpoint

ALTER TABLE kernel.push_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.push_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.push_tokens TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS push_tokens_select ON kernel.push_tokens;
--> statement-breakpoint
CREATE POLICY push_tokens_select ON kernel.push_tokens FOR SELECT TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS push_tokens_insert ON kernel.push_tokens;
--> statement-breakpoint
CREATE POLICY push_tokens_insert ON kernel.push_tokens FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS push_tokens_update ON kernel.push_tokens;
--> statement-breakpoint
CREATE POLICY push_tokens_update ON kernel.push_tokens FOR UPDATE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
--> statement-breakpoint

DROP POLICY IF EXISTS push_tokens_delete ON kernel.push_tokens;
--> statement-breakpoint
CREATE POLICY push_tokens_delete ON kernel.push_tokens FOR DELETE TO liaison_rls
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
