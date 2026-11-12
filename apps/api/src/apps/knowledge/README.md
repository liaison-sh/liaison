# Knowledge — the org's shared memory

Internal-only store of brand voice, policies, product facts, FAQs, and
procedures that agents and members draw on. Supports collections, a review/verify
queue, and **folder sources** that federate external documents into search.
Tools: `search`, `get`, `find_by_title`, `create`, `update`, `archive`,
`restore`, `review_queue`, `verify`, `collection_*`, `add_to_collection`,
`remove_from_collection`, `add_folder_source`, `source_link_create`.

## Connecting

**No kernel connection is required** — Knowledge owns its own local documents and
declares no `connections` block, so nothing appears under Settings → connections
for this app.

One nuance worth knowing: `add_folder_source` syncs an **external folder**
(e.g. a Google Drive folder) into Knowledge. The sync runs in the *other* app,
through its own connection and its manifest's `knowledgeSources` (Google Drive:
`bundled-apps/google-drive/src/knowledge.ts`); Knowledge holds no external
credential of its own.

Items Knowledge reaches without syncing them come from the apps that declare
`knowledgeItems` in their manifest (`source-registry.ts`): `search` answers
`search` across sources (on unless the org's policy for the app, or the app's
`searchByDefault`, says otherwise), `resolve` serves `source_link_create`,
link verify and refresh, and reading a remote hit. GitLab and Google Drive
declare both; Drive's search is off until an admin turns it on
(`PATCH /api/knowledge/sources/google-drive {"broadSearchEnabled": true}`).

For the shared connection machinery behind those sources, see
[`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md).
