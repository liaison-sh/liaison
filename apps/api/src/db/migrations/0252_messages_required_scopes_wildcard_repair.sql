-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.messages: drop the grant wildcards an agent turn's stamp carried,
-- only where that can never widen who reads the row.
--
-- An agent turn that ended abnormally after a tool call used to be stamped
-- with the agent's whole effective scope, unioned with what the turn had
-- read. On an agent whose ceiling holds the grant `*`, that put `*` (and
-- patterns such as `*:approve`) into the reply's required_scopes; later
-- turns re-read the stamp as history and carried it into their own replies.
-- 0249's kernel.scopes_covered covers a REQUIRED `*` only with the grant `*`,
-- so those replies are hidden from every participant without `*`, including
-- teammates who hold everything the turns actually read. The runtime no
-- longer stamps a wildcard (scope-taint.ts, rules 10b and 12); this repairs
-- the agent replies written before.
--
-- The runtime expands a wildcard onto the catalogue of read scopes it covers.
-- That catalogue is the running process's (the kernel's and the installed
-- apps' scope declarations), not the database's, so it cannot be done here.
-- Dropping a wildcard instead is safe only where the row's other entries
-- already classify everything the row can carry. That holds for an AGENT
-- TURN'S stamp, by induction over the turns of an org:
-- - the stamp is the turn's accumulated scopes, plus, on an abnormal end, the
--   effective scope; the accumulated scopes are the concrete scopes of the
--   tool calls it made and the stamps of what it was given to read (history,
--   memory, skills, a caller's or a sub-run's taint);
-- - a wildcard in it came from an effective scope (a ceiling intersected with
--   the requester's grants, which classifies nothing it did not read) or from
--   a stamp it read; if every wildcard-bearing message of the org is such an
--   agent turn stamp, the stamps it read are repaired by the same argument,
--   and what is left explicit still covers every read.
-- So the repair is limited to exactly that case:
-- - only rows with author_type 'agent' that are not an external client's post
--   (metadata key externalClientPost: stamped with the person's own grants,
--   not with reads);
-- - only in an org where EVERY message whose stamp holds a wildcard is such a
--   row. A system or user row with one (an approval failure notice is stamped
--   with the requester's whole grant set and quotes handler errors verbatim;
--   a routine tick prompt is stamped with the tick's effective scope) may
--   have been read by a later turn, so that org is left entirely as it is;
-- - an entry is a wildcard when it is `*` or has a `*` segment anywhere but
--   last (`*:approve`, `a:*:b`): as grants those cover nothing `*` does not,
--   so as required entries they demand `*`. They are removed; a trailing
--   `p:*` is kept (the grants `p` and `p:*` cover it), as is every other
--   entry, in order;
-- - a row whose list would become EMPTY is left unchanged (an empty list is
--   readable by every participant), as are rows with a NULL entry.
-- Every row it does not touch stays hidden from readers without `*`: fail
-- closed. Re-runnable: a second run finds no row with both a wildcard and
-- another entry in a qualifying org.

-- The UPDATE takes row locks on kernel.messages: fail the deploy cleanly behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
WITH wildcard_rows AS (
  SELECT m.id, m.org_id, m.author_type, m.metadata
  FROM kernel.messages m
  WHERE m.required_scopes IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM unnest(m.required_scopes) AS w(scope)
      WHERE w.scope = '*'
        OR COALESCE(array_position(string_to_array(w.scope, ':'), '*'),
                    cardinality(string_to_array(w.scope, ':')))
           < cardinality(string_to_array(w.scope, ':'))
    )
),
unsafe_orgs AS (
  SELECT DISTINCT r.org_id FROM wildcard_rows r
  WHERE r.author_type IS DISTINCT FROM 'agent'
    OR COALESCE(r.metadata, '{}'::jsonb) ? 'externalClientPost'
)
UPDATE kernel.messages m
SET required_scopes = ARRAY(
  SELECT s.scope FROM unnest(m.required_scopes) WITH ORDINALITY AS s(scope, n)
  WHERE NOT (
    s.scope = '*'
    OR COALESCE(array_position(string_to_array(s.scope, ':'), '*'),
                cardinality(string_to_array(s.scope, ':')))
       < cardinality(string_to_array(s.scope, ':'))
  )
  ORDER BY s.n
)
FROM wildcard_rows r
WHERE m.id = r.id
  AND m.author_type = 'agent'
  AND NOT (COALESCE(m.metadata, '{}'::jsonb) ? 'externalClientPost')
  AND m.org_id NOT IN (SELECT org_id FROM unsafe_orgs)
  AND array_position(m.required_scopes, NULL) IS NULL
  AND EXISTS (
    SELECT 1 FROM unnest(m.required_scopes) AS k(scope)
    WHERE NOT (
      k.scope = '*'
      OR COALESCE(array_position(string_to_array(k.scope, ':'), '*'),
                  cardinality(string_to_array(k.scope, ':')))
         < cardinality(string_to_array(k.scope, ':'))
    )
  );
