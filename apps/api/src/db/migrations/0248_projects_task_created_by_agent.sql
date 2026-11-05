-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who created a task when an agent did.
--
-- tasks.created_by is always a person: an agent acts under the person whose
-- turn it is. The task header says "Created by <name>", and for a task an
-- agent filed the honest name is the agent's, never the person's (an agent
-- post is attributed, not impersonated). The label is resolved once, at
-- creation, the way a thread post stores its agent author label: the routine
-- ("Routine <name>"), a named agent's display name, or "<person>'s agent".
-- Nullable and additive: an existing task was created by its created_by.
-- The projects manifest declares the same column (createdByAgentLabel).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE app_projects.tasks
  ADD COLUMN IF NOT EXISTS created_by_agent_label text;
