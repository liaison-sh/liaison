-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.messages SELECT checks a message's required scopes in one cheap pass.
--
-- 0060's visibility clause (the generator's
-- generateRequiredScopesVisibilityClause) compares every required scope of a
-- row with every granted scope, splitting both with regexp_split_to_array
-- and walking the segments with generate_subscripts: rows x required x
-- granted regular-expression splits. A thread whose messages carry about a
-- hundred required scopes, read by a viewer holding a few hundred grants,
-- spent more than the 10 s statement timeout counting its unread messages,
-- where the same query without the policy takes under a millisecond.
--
-- The rule is unchanged, rule for rule (hasScope, permissions.ts):
-- - a NULL column never passes the scope branch; an empty one always does;
-- - a NULL or empty required entry is never covered;
-- - grant `*` covers every other entry;
-- - a grant with a `*` segment anywhere but last covers nothing;
-- - a grant ending in a `*` segment, `p:*`, covers an entry that starts with
--   `p:` (it has at least as many segments, and the leading ones equal);
-- - any other grant `g` covers the entry `g` itself and every entry starting
--   with `g:`.
-- So the grants are turned into lookup keys ONCE per statement (an InitPlan
-- over rls_ctx.scopes()): `*`, `=g` for an exact match, `>p:` for a prefix
-- that ends at a segment boundary. A required entry is then covered by a key
-- lookup on `*`, on `=entry`, or on `>` followed by the entry cut after one of
-- its `:` separators: a few jsonb lookups per entry, no regular expressions.
-- An exact match of the arrays (`required <@ granted`) is not used as a
-- shortcut: a grant like `*:read` equals the entry `*:read` yet covers
-- nothing, and the key set already answers an exact match first.
--
-- The org and room-membership gate and the disclosure branch are the
-- installed policy's (0060 through the 0184-0186 readers) as they were.
-- Both functions are invokers with every name schema-qualified (no SET
-- clause: it would cost a settings save and restore per row), so the
-- caller's search_path cannot change what they compute. The required scopes
-- of existing rows are deduplicated (order kept), which reads the same.
-- Re-runnable.

-- ALTER POLICY locks kernel.messages: fail the deploy cleanly behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.scope_cover_keys(grants text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(pg_catalog.jsonb_object_agg(k.key, true), '{}'::jsonb)
  FROM pg_catalog.unnest(pg_catalog.string_to_array(
         NULLIF(NULLIF(grants, ''), '__none__'), ',')) AS g(scope)
  CROSS JOIN LATERAL (SELECT pg_catalog.regexp_split_to_array(g.scope, ':') AS gp) AS p
  CROSS JOIN LATERAL pg_catalog.unnest(CASE
    WHEN g.scope OPERATOR(pg_catalog.=) '*' THEN ARRAY['*']
    WHEN COALESCE(pg_catalog.array_position(p.gp, '*'), pg_catalog.cardinality(p.gp))
         OPERATOR(pg_catalog.<>) pg_catalog.cardinality(p.gp) THEN ARRAY[]::text[]
    WHEN p.gp[pg_catalog.cardinality(p.gp)] OPERATOR(pg_catalog.=) '*'
      THEN ARRAY['>' OPERATOR(pg_catalog.||) pg_catalog.left(g.scope, -1)]
    ELSE ARRAY['=' OPERATOR(pg_catalog.||) g.scope,
               '>' OPERATOR(pg_catalog.||) g.scope OPERATOR(pg_catalog.||) ':']
  END) AS k(key)
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kernel.scopes_covered(required text[], cover jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  r text;
  i integer;
  j integer;
  hit boolean;
BEGIN
  IF required IS NULL OR cover IS NULL THEN
    RETURN required IS NOT NULL AND pg_catalog.cardinality(required) OPERATOR(pg_catalog.=) 0;
  END IF;
  FOREACH r IN ARRAY required LOOP
    IF r IS NULL OR r OPERATOR(pg_catalog.=) '' THEN
      RETURN false;
    END IF;
    CONTINUE WHEN cover OPERATOR(pg_catalog.?) '*'
      OR cover OPERATOR(pg_catalog.?) ('=' OPERATOR(pg_catalog.||) r);
    hit := false;
    i := 0;
    LOOP
      j := pg_catalog.strpos(pg_catalog.substr(r, i OPERATOR(pg_catalog.+) 1), ':');
      EXIT WHEN j OPERATOR(pg_catalog.=) 0;
      i := i OPERATOR(pg_catalog.+) j;
      IF cover OPERATOR(pg_catalog.?) ('>' OPERATOR(pg_catalog.||) pg_catalog.left(r, i)) THEN
        hit := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT hit THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;
--> statement-breakpoint
-- Dedupe first, before ALTER POLICY takes its ACCESS EXCLUSIVE lock, so reads of messages are blocked only for the policy swap, not for this scan.
UPDATE kernel.messages m
SET required_scopes = ARRAY(
  SELECT s.scope FROM unnest(m.required_scopes) WITH ORDINALITY AS s(scope, n)
  GROUP BY s.scope ORDER BY min(s.n)
)
WHERE m.required_scopes IS NOT NULL
  AND array_position(m.required_scopes, NULL) IS NULL
  AND cardinality(m.required_scopes) > (SELECT count(DISTINCT x) FROM unnest(m.required_scopes) AS x);
--> statement-breakpoint
-- expand-safe: same rows visible to the same viewers (the rule above, proven against 0060's clause by 0249_messages_select_scope_cover.test.ts); the previous release reads messages unchanged.
ALTER POLICY messages_select ON kernel.messages USING (
  org_id = ((SELECT rls_ctx.org_id()))::uuid
  AND EXISTS (
    SELECT 1 FROM kernel.thread_participants tp
    WHERE tp.thread_id = messages.thread_id
      AND tp.user_id = ((SELECT rls_ctx.user_id()))::uuid
      AND tp.org_id = ((SELECT rls_ctx.org_id()))::uuid
  )
  AND (
    kernel.scopes_covered(required_scopes, (SELECT kernel.scope_cover_keys((SELECT rls_ctx.scopes()))))
    OR COALESCE(NULLIF((SELECT rls_ctx.user_id()), '') = ANY (disclosure_list::text[]), false)
  )
);
