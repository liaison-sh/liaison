-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A project's group: free text that files the project under a heading in the
-- projects sidebar (e.g. "Product", "Legal"). Shared by the org, no separate
-- entity: projects with the same text share a heading. Nullable and additive:
-- an existing project is ungrouped. Trimmed, empty stored as NULL, at most 60
-- characters, enforced by its one writer (service/create-project.ts
-- normalizeProjectGroup, used by the create and update paths). The projects
-- manifest declares the same column (group).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE app_projects.projects
  ADD COLUMN IF NOT EXISTS "group" text;
