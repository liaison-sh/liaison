-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.sessions: the lineage a refresh-token rotation needs to tell a lost
-- response from a stolen token (auth.ts refreshSession).
--
--  - family_id: every session minted from one sign-in, through all its
--    rotations. A reused rotated token revokes the whole family. NULL on rows
--    that predate this migration: such a row is its own family, and its first
--    rotation writes coalesce(family_id, id) onto both rows.
--  - successor_id: on a rotated row, the session its rotation issued.
--  - rotated_at: when the row was rotated. The lost-response window counts
--    from here and never restarts.
--  - successor_issued_at: when the current successor was issued (the rotation,
--    or a later lost-response reissue). It is also the compare-and-set stamp
--    the issuing transaction checks before it links the successor.
--  - rotated_ua_hash: sha256 of the User-Agent that rotated the row. Only the
--    same client may claim the lost-response window.
--  - used_at: the first time a request authenticated with one of the
--    session's access tokens. A used successor means its client got the
--    response, so a replay of the predecessor is not a lost response.
--
-- All columns are nullable with no default: existing rows read as "no lineage
-- yet" and behave exactly as before. Additive and re-runnable.

ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS family_id uuid;
ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS successor_id uuid;
ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS rotated_at timestamp with time zone;
ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS successor_issued_at timestamp with time zone;
ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS rotated_ua_hash text;
ALTER TABLE kernel.sessions ADD COLUMN IF NOT EXISTS used_at timestamp with time zone;
CREATE INDEX IF NOT EXISTS sessions_family_idx ON kernel.sessions (family_id);
