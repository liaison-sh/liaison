-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Attention email digests become opt-in (default cadence 'off').
--
-- Digests previously defaulted to 'daily' on three layers: the column default,
-- the lazy user_preferences row creation, and COALESCE(..., 'daily') fallbacks
-- in the digest/translator queries — so every user received notification email
-- without ever opting in. Notifications are now opt-in: a user gets zero
-- attention emails until they explicitly pick a cadence in Settings → Attention.
--
-- Existing 'daily' rows are reset to 'off' as well: under the default-on
-- regime a persisted 'daily' was indistinguishable from "never asked", so it
-- cannot be treated as consent. Users who want digests re-enable them once.
ALTER TABLE kernel.user_preferences
  ALTER COLUMN digest_cadence SET DEFAULT 'off';

UPDATE kernel.user_preferences
  SET digest_cadence = 'off', updated_at = now()
  WHERE digest_cadence = 'daily';

-- Drain the queue for opted-out users: attention events already materialized
-- as 'pending' (including urgent ones, which previously bypassed the cadence)
-- would otherwise still email after this deploy. In-app visibility of the
-- items is unaffected — 'suppressed' only stops email delivery.
UPDATE kernel.attention_events a
  SET digest_state = 'suppressed'
  WHERE a.digest_state = 'pending'
    AND COALESCE(
      (SELECT p.digest_cadence FROM kernel.user_preferences p WHERE p.user_id = a.user_id),
      'off') = 'off';
