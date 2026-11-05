-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Routine scopes guessed from the prompt, recorded apart (P6-fix9).
--
-- routines.scopes is the routine's whole required set (what the scope-drift
-- check compares with the owner's grants). Part of it is guessed from the
-- prompt (BL-209), and every edit used to union the new guess with the stored
-- set, so a scope an old prompt implied stayed required forever. inferred_scopes
-- names the part of `scopes` that came only from inference, so a save can
-- recompute it from the current prompt and keep the explicit rest.
--
-- NULL = written before this column (the guessed part is unknown); the
-- application treats it on the next edit. Re-runnable.

ALTER TABLE kernel.routines ADD COLUMN IF NOT EXISTS inferred_scopes text[];
