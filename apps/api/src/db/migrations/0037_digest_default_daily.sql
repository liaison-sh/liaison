-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Attention email digests flip back to default-on: cadence 'daily'.
--
-- Reverses 0007_digest_cadence_opt_in.sql (which set default 'off' and reset
-- every then-existing 'daily' row to 'off', bumping updated_at on every row
-- it touched). Approved by the operator 2026-08-27: default-on is the desired
-- experience — a user sees no in-app value from the digest until they
-- receive one, so opt-in mechanically suppressed adoption. Cadence stays
-- fully configurable in Settings -> Attention; this only changes what a user
-- who has never touched the setting gets.
--
-- Column default -> 'daily' (new user_preferences rows, and the
-- getOrCreatePreferences lazy-insert literal, follow separately in app code).
ALTER TABLE kernel.user_preferences
  ALTER COLUMN digest_cadence SET DEFAULT 'daily';

-- Backfill, SCOPED so it cannot resurrect an explicit opt-out.
--
-- 0007 shipped 2026-07-03 (commit b4ca0b90, committed 2026-07-03 13:56:50
-- UTC, "notification email is opt-in -- default digest cadence 'off'"); its
-- bulk UPDATE set digest_cadence='off', updated_at=now() on every row that
-- was 'daily' at that moment, and its deploy followed the same day. The
-- cutoff below is pinned to the END of that deploy day (2026-07-03
-- 23:59:59+00) -- the tightest defensible bound that still covers the
-- mechanical reset with a same-day deploy margin, without also covering
-- 2026-07-04 or later, when any 'off' write is an explicit user action
-- (Settings -> Attention PUT) under the now-live opt-in regime and must be
-- left alone. (An earlier draft of this migration used a 2-day-wider cutoff
-- of 2026-07-05, which would have silently resurrected an explicit opt-out
-- made on 2026-07-03/04 -- fixed here.)
--
-- Any row still 'off' with updated_at at-or-before the cutoff is that
-- mechanical reset, never a real choice, and is safe to flip back. Any row
-- with updated_at AFTER the cutoff was touched after the opt-in regime went
-- live -- that touch is treated as the user having seen and kept 'off', so
-- it is left alone. 'hourly' / 'immediate' rows are untouched by this
-- predicate (not 'off') regardless of updated_at.
--
-- KNOWN, ACCEPTED GAP: a user whose row was lazily created by
-- `getOrCreatePreferences` (with the old 'off' literal) strictly AFTER the
-- cutoff -- i.e. signed up / first opened Settings -> Attention between
-- 2026-07-03 end-of-day and this migration's deploy -- and who never
-- explicitly touched digestCadence, is mechanically defaulted, not an
-- explicit choice, and this migration does NOT flip that row to 'daily'.
-- `user_preferences` carries only `updated_at` (no `created_at`), so a
-- lazily-created row's timestamp is INDISTINGUISHABLE from an explicit
-- Settings PUT made moments after signup -- any predicate covering the
-- former would risk silently resurrecting the latter, which is exactly the
-- failure mode this scoping exists to prevent. Left alone deliberately;
-- affected users self-heal the next time they touch Settings -> Attention
-- (getOrCreatePreferences' INSERT literal + the schema/COALESCE defaults are
-- already flipped to 'daily' in this same change, so this gap cannot grow
-- past this deploy).
--
-- Idempotent: a second run finds no more updated_at <= cutoff rows still 'off'
-- (they are now 'daily', predicate no longer matches), so it is a no-op.
UPDATE kernel.user_preferences
  SET digest_cadence = 'daily', updated_at = now()
  WHERE digest_cadence = 'off'
    AND updated_at <= '2026-07-03 23:59:59+00'::timestamptz;
