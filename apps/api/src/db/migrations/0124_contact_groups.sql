-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Contact groups: named groups with hand-picked members, beside the rule-based
-- segments (S15).
--
--  - kernel.contact_segments.kind: 'rule' (a stored filter evaluated live, every
--    segment that exists today) or 'manual' (a group whose members are listed
--    in kernel.contact_group_members). Existing rows stay 'rule'.
--  - kernel.contact_group_members: one row per (group, contact). A member row
--    is visible only when its CONTACT is visible to the reader: the policy reads
--    kernel.contacts under the caller's own RLS, so a restricted contact never
--    shows up as somebody else's group member, and the group's member count is
--    the count of members the reader may see. Adding or removing a member needs
--    the same visibility; the group must be a manual one of the same org.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.contact_segments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'rule';
--> statement-breakpoint
ALTER TABLE kernel.contact_segments DROP CONSTRAINT IF EXISTS contact_segments_kind_check;
--> statement-breakpoint
ALTER TABLE kernel.contact_segments
  ADD CONSTRAINT contact_segments_kind_check CHECK (kind IN ('rule', 'manual'));
--> statement-breakpoint
-- Two groups of one org never share a name (case-insensitive): an agent asked to
-- "add Alice to VIP" must find one group, not pick between two.
CREATE UNIQUE INDEX IF NOT EXISTS contact_segments_manual_name_idx
  ON kernel.contact_segments (org_id, lower(name)) WHERE kind = 'manual';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS kernel.contact_group_members (
  segment_id uuid NOT NULL REFERENCES kernel.contact_segments(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES kernel.contacts(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  added_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, contact_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_group_members_contact_idx
  ON kernel.contact_group_members (org_id, contact_id);
--> statement-breakpoint

ALTER TABLE kernel.contact_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.contact_group_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON kernel.contact_group_members TO liaison_rls, liaison_app;
--> statement-breakpoint

DROP POLICY IF EXISTS contact_group_members_select ON kernel.contact_group_members;
--> statement-breakpoint
CREATE POLICY contact_group_members_select ON kernel.contact_group_members FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM kernel.contacts c WHERE c.id = contact_group_members.contact_id)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contact_group_members_insert ON kernel.contact_group_members;
--> statement-breakpoint
CREATE POLICY contact_group_members_insert ON kernel.contact_group_members FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM kernel.contacts c WHERE c.id = contact_group_members.contact_id
                AND c.org_id = contact_group_members.org_id)
    AND EXISTS (
      SELECT 1 FROM kernel.contact_segments s
       WHERE s.id = contact_group_members.segment_id
         AND s.org_id = contact_group_members.org_id
         AND s.kind = 'manual'
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS contact_group_members_delete ON kernel.contact_group_members;
--> statement-breakpoint
CREATE POLICY contact_group_members_delete ON kernel.contact_group_members FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM kernel.contacts c WHERE c.id = contact_group_members.contact_id)
  );
