-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4c-T38: the three fields the Settings tab edits that the agent row never had.
--
-- `purpose` is the one sentence a directory card and a page header show. It was
-- DERIVED from the system prompt's first line until now (`deriveAgentPurpose`,
-- services/agent/context.ts, which already prefers this column the moment it
-- exists), and a derived purpose cannot be edited: an admin changing the
-- sentence would have had to rewrite the prompt's first line to do it. Nullable,
-- because a row without one keeps falling back to the prompt's first line and
-- nothing about the existing fleet changes.
--
-- `avatar_url` is the picture every participant surface already renders a slot
-- for (the listing and the page read both answered a hardcoded null for it).
--
-- `model_preference` is which model this agent's turns ask for, null meaning
-- Auto, the same null the composer's own picker uses. It is a preference and
-- never a permission: what an org may actually call is decided by the provider
-- keys and the plan, server side, exactly as it is for a human's pick.
--
-- No backfill: every column is nullable and every reader has a fallback.
ALTER TABLE kernel.agents ADD COLUMN IF NOT EXISTS purpose text;--> statement-breakpoint
ALTER TABLE kernel.agents ADD COLUMN IF NOT EXISTS avatar_url text;--> statement-breakpoint
ALTER TABLE kernel.agents ADD COLUMN IF NOT EXISTS model_preference text;
