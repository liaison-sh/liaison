-- SPDX-License-Identifier: FSL-1.1-ALv2
-- P4c-T48: near-duplicate clusters over the search documents.
--
-- The same fact said six ways is six documents, and a hybrid search finds all
-- six: the vector leg is exactly the thing that makes rewordings of one fact
-- retrievable together. Left alone, a top five becomes one fact five times.
--
-- So the clusterer writes a CANONICAL ID on every document whose vector sits
-- within a cosine threshold of another's, here and on the Meili document, and
-- the read path keeps one hit per cluster with the cluster's other ids listed
-- so `memory_open` can still reach them.
--
-- WHY A TABLE AND NOT ONLY THE INDEX. The Meili document is a cache: it is
-- rebuilt by a reindex, dropped by a settings drift, and carries no history.
-- The cluster is a derived FACT about the org's transcript, so it lives in the
-- database and the index carries a copy for the query path.
CREATE TABLE IF NOT EXISTS kernel.search_document_clusters (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  -- The document's own identity, the same pair the Meili document carries:
  -- 'message' / 'message_window' / 'brief_row' / 'episode', plus its entity id.
  -- Text, not uuid: a window document's entity id is '<thread>:<anchor>'.
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  -- The cluster this document belongs to: the entity id of the cluster's
  -- representative. A document in a cluster of one carries its own id, so
  -- "is this a duplicate of anything" is never a null check.
  canonical_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_type, entity_id)
);
--> statement-breakpoint

-- The read path's query: every member of a cluster, for one org.
CREATE INDEX IF NOT EXISTS search_document_clusters_canonical_idx
  ON kernel.search_document_clusters (org_id, canonical_id);
--> statement-breakpoint

ALTER TABLE kernel.search_document_clusters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.search_document_clusters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.search_document_clusters TO liaison_rls, liaison_app;
--> statement-breakpoint

-- A cluster row says only "these documents say the same thing". It carries no
-- text and no scopes, and every read of it is followed by the ordinary
-- visibility re-check on the documents themselves, so org scoping is the whole
-- policy here.
DROP POLICY IF EXISTS search_document_clusters_select ON kernel.search_document_clusters;
--> statement-breakpoint
CREATE POLICY search_document_clusters_select ON kernel.search_document_clusters FOR SELECT TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS search_document_clusters_insert ON kernel.search_document_clusters;
--> statement-breakpoint
CREATE POLICY search_document_clusters_insert ON kernel.search_document_clusters FOR INSERT TO liaison_rls
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS search_document_clusters_update ON kernel.search_document_clusters;
--> statement-breakpoint
CREATE POLICY search_document_clusters_update ON kernel.search_document_clusters FOR UPDATE TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

DROP POLICY IF EXISTS search_document_clusters_delete ON kernel.search_document_clusters;
--> statement-breakpoint
CREATE POLICY search_document_clusters_delete ON kernel.search_document_clusters FOR DELETE TO liaison_rls
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
