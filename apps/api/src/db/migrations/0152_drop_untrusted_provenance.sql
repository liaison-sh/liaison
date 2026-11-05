-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Agent memory and Knowledge documents no longer record whether the agent turn
-- that wrote them had read outside text (0150, 0151). What is written stays as
-- written; an agent's write to memory or to a document during such a turn goes
-- through an approval instead (or an auto-approve policy). Re-runnable.
ALTER TABLE kernel.agent_memory DROP COLUMN IF EXISTS from_untrusted;
ALTER TABLE app_knowledge.documents DROP COLUMN IF EXISTS from_untrusted;
