-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Channels get a TOPIC and a DESCRIPTION, the Slack/Buzz model.
--
-- A channel's name says what to call it and nothing about what it is for. The
-- two fields answer different questions and that is why there are two of them,
-- rather than one "about" blob:
--
--   `topic` is the one line that travels WITH the name. It is what the room is
--   on about right now ("shipping the 0.9 beta", "on call: Alex"), it changes
--   often, and it renders in the header beside the title and on the unjoined
--   discoverable row, where it is the only thing that can tell a member whether
--   the channel is worth joining. Short by construction: 250 characters, which
--   is a line, not a paragraph.
--
--   `description` is the standing answer to "what is this channel". It changes
--   rarely, it lives in the channel details rather than the header, and it has
--   room for a few sentences: 2000 characters.
--
-- BOTH NULLABLE, no backfill and no default. A channel without either is the
-- state every existing row is already in, and an empty topic must stay
-- distinguishable from an unset one so the header can render nothing at all
-- rather than an empty line.
--
-- The lengths are CHECKed here as well as in the Zod, because the Zod guards
-- one door: the thread PATCH. Nothing stops a job, a tool or a future route
-- writing this column, and a 2000 character "line" in the header is a layout
-- break for everyone in the org, not a bad request for one caller.
--
-- Every statement is re-runnable, following the 0033/0045/0082/0089/0090/0094
-- convention.
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS topic text;--> statement-breakpoint
ALTER TABLE kernel.threads ADD COLUMN IF NOT EXISTS description text;--> statement-breakpoint

ALTER TABLE kernel.threads DROP CONSTRAINT IF EXISTS threads_topic_length;--> statement-breakpoint
ALTER TABLE kernel.threads ADD CONSTRAINT threads_topic_length
  CHECK (topic IS NULL OR char_length(topic) <= 250);--> statement-breakpoint

ALTER TABLE kernel.threads DROP CONSTRAINT IF EXISTS threads_description_length;--> statement-breakpoint
ALTER TABLE kernel.threads ADD CONSTRAINT threads_description_length
  CHECK (description IS NULL OR char_length(description) <= 2000);
