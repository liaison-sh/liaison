-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A personal agent's handle names its owner's AGENT, not the owner.
--
-- Personal agents were created as `@<first name>` (or the email local part),
-- so a member who mentioned their own agent in a discussion posted "@ada",
-- which every reader took for the person Ada. New rows are created as
-- `@<slug>s-agent`, or `@<slug>-agent` when the slug already ends in "s"
-- (personal-agent.ts, personalAgentBaseHandle). This renames the rows created
-- under the old form, and only those.
--
-- The old slug is the handle without its "@". A trailing number is the old
-- collision discriminator (`@ada2` beside `@ada`) only when the undiscriminated
-- handle exists in the same org; otherwise it is part of the name (`@jdoe85`).
-- Several old handles can map to one new base (`@ada`, `@ada2`), and another
-- agent may already hold it, so each row takes the first free spelling in its
-- org, oldest agent first: the base, then base2, base3, ... (the discriminator
-- createPersonalAgent uses).
--
-- `handle` is immutable (0051's agents_handle_immutable trigger). The trigger
-- has no bypass, by design, so it is disabled for this one UPDATE and enabled
-- again in the same migration transaction: if anything here fails, the whole
-- transaction rolls back with the trigger still in place.
--
-- RE-RUNNABLE: a handle already in the new form (`-agent` plus an optional
-- discriminator) is skipped.

ALTER TABLE kernel.agents DISABLE TRIGGER agents_handle_immutable;
--> statement-breakpoint

DO $RENAME$
DECLARE
  r record;
  slug text;
  base text;
  candidate text;
  n int;
BEGIN
  -- The old slug is decided in the loop's own query, so it reads the handles
  -- as they were before this rename: `@ada2` is still recognised as `@ada`'s
  -- discriminated twin after `@ada` itself has been renamed.
  FOR r IN
    SELECT a.id, a.org_id,
      CASE
        WHEN substr(a.handle, 2) ~ '[0-9]$' AND EXISTS (
          SELECT 1 FROM kernel.agents o
          WHERE o.org_id = a.org_id AND o.id <> a.id
            AND o.handle = '@' || regexp_replace(substr(a.handle, 2), '[0-9]+$', '')
        ) THEN regexp_replace(substr(a.handle, 2), '[0-9]+$', '')
        ELSE substr(a.handle, 2)
      END AS old_slug
    FROM kernel.agents a
    WHERE a.kind = 'personal' AND a.handle !~ '-agent[0-9]*$'
    ORDER BY a.org_id, a.created_at, a.id
  LOOP
    slug := r.old_slug;
    -- A slug never carries a leading or trailing dash (slugify trims both).
    slug := regexp_replace(slug, '^-+|-+$', '', 'g');

    IF slug = '' THEN
      base := '@agent';
    ELSIF right(slug, 1) = 's' THEN
      base := '@' || slug || '-agent';
    ELSE
      base := '@' || slug || 's-agent';
    END IF;

    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM kernel.agents a
      WHERE a.org_id = r.org_id AND a.handle = candidate AND a.id <> r.id
    ) LOOP
      n := n + 1;
      candidate := base || n::text;
    END LOOP;

    UPDATE kernel.agents SET handle = candidate, updated_at = now() WHERE id = r.id;
  END LOOP;
END
$RENAME$;
--> statement-breakpoint

ALTER TABLE kernel.agents ENABLE TRIGGER agents_handle_immutable;
