-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Indexes for foreign-key columns that deleting a parent row has to search.
--
-- Postgres does not index the referencing side of a foreign key. Deleting a
-- thread, a user, a tag or a document runs each ON DELETE action (cascade,
-- set null, restrict check) as a lookup on the child table, and without an
-- index every lookup is a sequential scan of that table across EVERY org. An
-- org purge deletes thousands of such parents, so its cost grew with the
-- whole database: on a demo-sized box, purging 372 workspaces spent about
-- 1 000 s of Postgres time in these lookups (6 ms per thread on
-- agent_memory.source_thread_id alone), while visitors' requests waited for
-- the CPU. The columns below are the ones that measurement named.
--
-- Additive: indexes only, no data change. Nullable columns whose rows mostly
-- hold NULL get a partial index.
--
-- Locking: the migrator runs each file in one transaction, so CONCURRENTLY is
-- unavailable; CREATE INDEX blocks writes to its table while it builds. The
-- index-build notes are measured on a demo-sized box holding about 2 000
-- workspaces (larger than any known deployment): every build under 0.4 s.
-- lock_timeout makes a deploy that cannot get a lock fail cleanly instead of
-- queueing every writer behind it. Idempotent: IF NOT EXISTS.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- index-build: kernel.agent_memory 21690 17
CREATE INDEX IF NOT EXISTS idx_kernel_agent_memory_source_thread_id_fk ON kernel.agent_memory (source_thread_id) WHERE source_thread_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.agent_memory 21690 13
CREATE INDEX IF NOT EXISTS idx_kernel_agent_memory_supersedes_id_fk ON kernel.agent_memory (supersedes_id) WHERE supersedes_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.thread_participants 88685 37
CREATE INDEX IF NOT EXISTS idx_kernel_thread_participants_thread_id_fk ON kernel.thread_participants (thread_id);
--> statement-breakpoint
-- index-build: app_knowledge.taggings 83214 41
CREATE INDEX IF NOT EXISTS idx_app_knowledge_taggings_tag_id_fk ON app_knowledge.taggings (tag_id);
--> statement-breakpoint
-- index-build: app_knowledge.taggings 83214 45
CREATE INDEX IF NOT EXISTS idx_app_knowledge_taggings_created_by_fk ON app_knowledge.taggings (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.routines 8044 10
CREATE INDEX IF NOT EXISTS idx_kernel_routines_report_thread_id_fk ON kernel.routines (report_thread_id) WHERE report_thread_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.routines 8044 16
CREATE INDEX IF NOT EXISTS idx_kernel_routines_output_thread_id_fk ON kernel.routines (output_thread_id) WHERE output_thread_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.routines 8044 12
CREATE INDEX IF NOT EXISTS idx_kernel_routines_created_by_user_id_fk ON kernel.routines (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.routines 8044 12
CREATE INDEX IF NOT EXISTS idx_kernel_routines_edited_by_user_id_fk ON kernel.routines (edited_by_user_id) WHERE edited_by_user_id IS NOT NULL;
--> statement-breakpoint
-- index-build: app_projects.tasks 22058 15
CREATE INDEX IF NOT EXISTS idx_app_projects_tasks_thread_id_fk ON app_projects.tasks (thread_id) WHERE thread_id IS NOT NULL;
--> statement-breakpoint
-- index-build: app_projects.tasks 22058 15
CREATE INDEX IF NOT EXISTS idx_app_projects_tasks_created_by_fk ON app_projects.tasks (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.pending_events 523444 313
CREATE INDEX IF NOT EXISTS idx_kernel_pending_events_org_id_fk ON kernel.pending_events (org_id);
--> statement-breakpoint
-- index-build: kernel.user_thread_state 61807 31
CREATE INDEX IF NOT EXISTS idx_kernel_user_thread_state_thread_id_fk ON kernel.user_thread_state (thread_id);
--> statement-breakpoint
-- index-build: app_knowledge.documents 38592 25
CREATE INDEX IF NOT EXISTS idx_app_knowledge_documents_created_by_fk ON app_knowledge.documents (created_by) WHERE created_by IS NOT NULL;
--> statement-breakpoint
-- index-build: app_knowledge.documents 38592 22
CREATE INDEX IF NOT EXISTS idx_app_knowledge_documents_verified_by_fk ON app_knowledge.documents (verified_by) WHERE verified_by IS NOT NULL;
--> statement-breakpoint
-- index-build: app_knowledge.documents 38592 16
CREATE INDEX IF NOT EXISTS idx_app_knowledge_documents_updated_by_fk ON app_knowledge.documents (updated_by) WHERE updated_by IS NOT NULL;
--> statement-breakpoint
-- index-build: app_knowledge.documents 38592 20
CREATE INDEX IF NOT EXISTS idx_app_knowledge_documents_source_identity_id_fk ON app_knowledge.documents (source_identity_id) WHERE source_identity_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.agent_turns 27137 20
CREATE INDEX IF NOT EXISTS idx_kernel_agent_turns_thread_id_fk ON kernel.agent_turns (thread_id);
--> statement-breakpoint
-- index-build: kernel.skills 10845 12
CREATE INDEX IF NOT EXISTS idx_kernel_skills_created_by_user_id_fk ON kernel.skills (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
-- index-build: app_tickets.tickets 20178 17
CREATE INDEX IF NOT EXISTS idx_app_tickets_tickets_related_ticket_id_fk ON app_tickets.tickets (related_ticket_id) WHERE related_ticket_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.agents 14473 13
CREATE INDEX IF NOT EXISTS idx_kernel_agents_owner_user_id_fk ON kernel.agents (owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.approval_requests 3235 5
CREATE INDEX IF NOT EXISTS idx_kernel_approval_requests_thread_id_fk ON kernel.approval_requests (thread_id) WHERE thread_id IS NOT NULL;
--> statement-breakpoint
-- index-build: kernel.approval_requests 3235 4
CREATE INDEX IF NOT EXISTS idx_kernel_approval_requests_originating_thread_id_fk ON kernel.approval_requests (originating_thread_id) WHERE originating_thread_id IS NOT NULL;
--> statement-breakpoint
-- index-build: app_knowledge.collection_memberships 38592 22
CREATE INDEX IF NOT EXISTS idx_app_knowledge_collection_memberships_created_by_fk ON app_knowledge.collection_memberships (created_by) WHERE created_by IS NOT NULL;
