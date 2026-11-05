-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A workspace can remove an app (S18, A4, A24-1): `kernel.apps.status` gains
-- `removed`. The row and the app's data stay; "added to this workspace" means
-- status <> 'removed'. Its own file: a value added by ALTER TYPE cannot be used
-- in the transaction that adds it, and nothing in this release's migrations
-- uses it (only the runtime does, after commit). Re-runnable.
ALTER TYPE kernel.app_status ADD VALUE IF NOT EXISTS 'removed';
