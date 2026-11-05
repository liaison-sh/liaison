-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Profile pictures: capability-URL avatar key.
--
-- Adds `avatar_key` -- an unguessable random token that appears in the public
-- avatar-serving URL (`/api/avatars/<key>`) and, combined with `org_id`, locates
-- the stored object (`orgs/<org_id>/avatars/<key>.webp`). The pre-existing
-- `avatar_url` column stores the derived `/api/avatars/<key>` path, so every user
-- serializer and the shared Avatar component render uploaded pictures with no
-- other change.
--
-- Serving is an UNAUTHENTICATED capability route: bearer-token auth cannot ride
-- on an <img> tag, so the random key itself IS the capability. It rotates on
-- every upload, so a stale URL stops resolving once the picture is replaced.
--
-- Nullable: a NULL avatar_key means no picture, which renders the initials
-- fallback. Additive and safe against existing data.

ALTER TABLE kernel.users
  ADD COLUMN IF NOT EXISTS avatar_key text;

CREATE UNIQUE INDEX IF NOT EXISTS users_avatar_key_idx
  ON kernel.users (avatar_key) WHERE avatar_key IS NOT NULL;
