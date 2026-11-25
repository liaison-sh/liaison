-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A bare marker scope on a stamp is held as it was before 0347.
--
-- 0347 made every bare marker scope (no `:`, such as a role's `clevel`) exact-only where row
-- security reads a stamp, so a person holding `*` without the marker itself stopped reading a
-- stamped row. Stamps written by earlier releases carry such markers (a requester's own grants
-- on an approval's failure notice, a reply read under a person's role scope), and a workspace
-- upgraded to this release would hide those rows from its admins. Here the stamp readers'
-- exact-only test names the listed scopes alone: a bare marker is covered by `*`, its exact
-- grant and nothing else, as before 0347, for rows old and new. The listed scopes are new in
-- this release, so no earlier row carries them.
--
-- The app's own check (`isExactOnlyScope`, scope-coverage.ts) keeps the bare-marker rule for
-- grants and ceilings; it is stricter than this answer, so the two never let more through
-- than this one. Re-runnable.
-- expand-safe: covers what 0347's version covers plus a bare marker under `*`, as 0331's version did; the previous release reads the same rows or fewer.
CREATE OR REPLACE FUNCTION kernel.scope_is_exact_only(scope text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT scope OPERATOR(pg_catalog.=) ANY (ARRAY[
    'projects:cost_rates:write',
    'projects:margin:read',
    'projects:timesheet:read'
  ]::text[])
$fn$;
