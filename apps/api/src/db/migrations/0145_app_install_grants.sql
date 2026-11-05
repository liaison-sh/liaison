-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Admin grants for installed apps beyond scopes and connections.
--
-- granted_capabilities: the platform capabilities (kernel primitives such as
--   messages.post or grants.setUserScopes) the admin approved at install. NULL
--   means a row installed before this column existed: those installs are
--   grandfathered with every capability their manifest declares, and the next
--   upgrade records an explicit grant.
-- granted_cross_app_calls: the `app:tool` targets of the manifest's cross_app_calls
--   the admin approved. A declared target authorizes app-to-app dispatch without the
--   caller's RBAC scopes, so it is part of the grant. NULL = grandfathered, as above.
-- ui_full_access_approved_*: the admin's explicit, recorded approval that the
--   app's own interface (ui.js) runs in the web origin with the user's session.
--   Without it (and without a trusted-publisher signature or a first-party
--   voucher) the UI bundle is neither listed nor served.
ALTER TABLE kernel.apps_installed
  ADD COLUMN IF NOT EXISTS granted_capabilities text[],
  ADD COLUMN IF NOT EXISTS granted_cross_app_calls text[],
  ADD COLUMN IF NOT EXISTS ui_full_access_approved_by uuid,
  ADD COLUMN IF NOT EXISTS ui_full_access_approved_at timestamptz;
