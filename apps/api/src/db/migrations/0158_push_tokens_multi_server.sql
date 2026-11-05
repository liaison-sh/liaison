-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A phone signed in to several Liaison servers receives from all of them, so
-- its pushes have to say which organisation is talking (the APNs subtitle, the
-- FCM title prefix). A phone signed in to one server has nothing to tell apart
-- and gets no label. The app says which it is when it registers its token and
-- again whenever a server is added or removed; a client from before the field
-- sends nothing and is single server (the default).
ALTER TABLE kernel.push_tokens ADD COLUMN IF NOT EXISTS multi_server boolean NOT NULL DEFAULT false;
