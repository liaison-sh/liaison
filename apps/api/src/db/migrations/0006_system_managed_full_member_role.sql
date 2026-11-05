-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Auto-maintained "Full Member" composite role.
--
-- Liaison ships kernel-only `member`/`viewer` defaults plus one `<app>.member` /
-- `<app>.admin` role per app, but nothing that spans EVERY app. Self-hosters
-- therefore hand-build an umbrella "full member" role — and every time a new app
-- is installed, that umbrella silently misses it until an admin edits it
-- (the 2026-07-03 calendar-access gap: full members could not see the newly
-- installed Calendar app because no role granted its scopes).
--
-- The app-registration path now maintains a system-managed "Full Member" role
-- that automatically gains each app's standard non-admin scopes. This column
-- marks such rows so the reconciler owns only what it created/adopted, and so
-- the UI can flag them as system-managed (not freely editable).
ALTER TABLE kernel.roles
  ADD COLUMN IF NOT EXISTS system_managed boolean NOT NULL DEFAULT false;
