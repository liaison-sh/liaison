---
title: Knowledge
description: "Write and organise your team's policies, procedures and product facts, share them, sync a Drive folder, and keep them verified for agents."
screenshot: "assets/screens/knowledge.webp"
screenshotAlt: "The Knowledge home with a folder tree on the left and a list of recently touched documents such as product spec sheets and support procedures."
---

Knowledge holds the documents your team and your agents rely on: policies, procedures, product facts, boilerplate. Agents search it before they answer, so a reply quotes your real return policy instead of a guess.

Search matches the words a document contains. When someone asks in another language than your documents, the agent searches with the key terms translated into the documents' language, and when a search finds nothing it tries again in English.

## Write a document

1. Click **Knowledge** in the activity bar.
2. Click **New document** in the sidebar.
3. Give it a title and write the body. Click **Save**.

The sidebar has two trees: **Personal** for your own notes and **Shared with org** for team documents. Use **New personal folder**, **New shared folder** or **New folder** to make folders, and **Move to** to file a document. Documents in no folder are under **Unfiled**. Deleting a folder keeps the documents inside it.

You can also click **Create knowledge from…** on the Knowledge home to ask your agent to write documents from material you give it.

If someone else saves the document while you edit it, Liaison tells you and offers **Load the latest version**.

## Share a document

1. Open the document and click **Share**.
2. Under **General access**, choose one:
   - **Restricted**: only people with access
   - **Anyone in the org can view**
   - **Anyone in the org can edit**
   - **C-Level**: everyone in the organization can view, only C-Level can edit
3. Under **People with access**, click **Add people…** (or type a name) and choose **Viewer** or **Editor** for each person. You are not in the list: you already have access.
4. Under **Roles with access**, click **Add roles…** to share with a whole role.
5. Click **Save**.

Admins have no bypass: a restricted document is editable only by its owner or someone with an **Editor** share. Search follows the same sharing rules, so a document not shared with you does not appear in your results or your agent's.

## Sync a Google Drive folder

A synced source mounts an external folder so its files appear as read-only Knowledge documents that stay fresh. Google Drive is the folder source you can add from settings. Connect [Google Drive](google-drive.md) first.

1. Open **Settings › Apps › Knowledge**, section **Synced sources**.
2. Click **+ Add source**.
3. Paste the **Drive folder ID**. Open the folder in Drive and copy the id from the URL after `drive.google.com/drive/folders/`.
4. Enter a **Display name**, for example "Product manual", and a **Sync interval (minutes)**.
5. Choose the **Scope**: **Personal** or **Shared with org**. Shared needs `knowledge:sources:manage` or `knowledge:documents:admin` (an admin holding every scope has both).
6. Choose the **Sensitivity**: internal, confidential, restricted or public.
7. Click **Add source**.

Through the organization's Drive connection, a folder syncs only when it sits in one of the shared drives an admin picked ([Google Drive](google-drive.md#share-the-organizations-shared-drives)); a folder in someone's My Drive syncs through that person's own connection. When one Google account is both the organization's Drive and a person's own, an organization folder syncs through the organization's connection and that person's own folders through theirs. A folder of the organization's Drive is hidden while no shared drive is picked, or when it is in none of the picked drives, until a sync finds it inside a picked drive again.

A Drive connected in picked mode (a personal Google account, see [Google Drive](google-drive.md#choose-the-files-liaison-sees)) adds its source by itself, **Google Drive: <address>**, holding the files and folders picked with **Choose files** in **Settings › Apps › Google Drive**.

The Google Drive app syncs the folder itself (its `folder` source kind): a pass walks the folder and its subfolders, each subfolder a collection, and removes from Knowledge what the folder no longer holds.

Text files (plain text, Markdown, CSV, JSON, XML, YAML), Google Docs, Slides and Sheets, and Excel workbooks (.xlsx, each sheet as CSV) become documents. Other files, such as PDFs and images, become links in a source shared with the organization and are left out of a personal one; the sync then names the files it left out instead of reporting a plain success.

Documents from a source marked confidential or restricted are readable only by the person who added the source and the people and roles they are shared with, not by the whole organization.

Synced documents show **Synced from** with the last refresh time and a **Refresh** button. The **Synced sources** list shows each source, where it comes from (Google Drive, GitLab or Database) and who it is shared with. Click **Sync now** to sync one at once, or archive it to stop syncing. Its documents stay when you stop.

In the [live demo](../getting-started/demo.md), the GitLab and Google Drive sources are seeded with their documents and do not sync: the demo has no connected accounts.

An agent can also bring in a GitLab repository path or the connected database's knowledge base with `knowledge__add_folder_source`. For GitLab, see [GitLab](gitlab.md). The database knowledge base is the Database app's own synced source (see below): it takes no folder reference and syncs on its schedule, never as a one-time import.

## Sync from an installed app

An installed app can offer its own kind of synced source, for example a notes tool or a wiki. Liaison keeps its documents up to date the same way: on the source's interval, page by page, from where the last sync stopped. If a sync fails, the next one starts again from the last page that was saved.

Add one through the API: `GET /api/knowledge/synced-sources/kinds` lists the kinds you may add, and `POST /api/knowledge/synced-sources` with `appName`, `sourceKind` and `sourceConfig` adds a source. You need the app's read scope for that kind, and the config must match what the app asks for. Before every sync, Liaison checks again that the source's owner is still an active member and still holds that scope; if not, the sync stops and the source says why. The app can file the documents in folders of its own, shown as collections inside the source's collection; they follow renames and moves, and a folder that ends up empty is archived. To build such an app, see [Offer a knowledge source](../app-development.md#18-offer-a-knowledge-source).

## Keep documents verified

1. On the Knowledge home, click **Needs review** to see documents that are flagged, stale, missing an owner or past their review date.
2. Open a document, check it, and click **Verify**.

Use **Archive** to retire a document and **Restore** to bring it back.

## Import collections and documents

Collections import as the `knowledge.collection` kind and documents as the `knowledge.document` kind, each matched on its `externalRef`: one imported before is skipped, never updated. In a run with both, collections go first, so a document can be filed in a collection the same run creates (`collectionRefs`).

An imported document follows the same rules as one you write: its sensitivity sets who in the organization can open it (**Confidential** and **Restricted** documents start shared with nobody), and you can only import a sensitivity or a team you have access to. Tags are matched on their name; an existing tag is reused as it is. Attachments are copies of files you uploaded. A personal document can belong to another person (`ownerEmail`) when you can assign document owners.

Importing documents needs `knowledge:documents:create` (and `knowledge:tags:manage` to tag them), importing collections `knowledge:collections:manage`. Each import is a run you can undo from **Settings › Organization › Imports** (see [Undo an import](../admin/settings.md#undo-an-import)).

## Roles and scopes

Knowledge ships three roles. See [roles](../admin/roles.md).

| Role | Scopes |
|---|---|
| `member` | `knowledge:documents:read`, `knowledge:documents:create`, `knowledge:documents:update`, `knowledge:links:create`, `knowledge:sources:read`, `knowledge:attachments:download`, `knowledge:attachments:upload` |
| `curator` | `knowledge:collections:manage`, `knowledge:tags:manage`, `knowledge:documents:archive`, `knowledge:documents:assign-owner`, `knowledge:sources:manage` |
| `admin` | `knowledge:documents:admin`, `knowledge:cache:manage` |

`knowledge:approve` decides any Knowledge approvals. Full list: [scope reference](../reference/scopes.md).

## What agents can do

| Tool | What it does | Scope |
|---|---|---|
| `search` | Search Knowledge and enabled remote sources | `knowledge:documents:read` |
| `get` | Read a document or a remote source item | `knowledge:documents:read` |
| `find_by_title` | Find a document by its exact title | `knowledge:documents:read` |
| `review_queue` | List items that need review | `knowledge:documents:read` |
| `create` | Create a document | `knowledge:documents:create` |
| `update` | Update a document | `knowledge:documents:update` |
| `verify` | Mark a document verified | `knowledge:documents:update` |
| `archive`, `restore` | Archive or restore a document | `knowledge:documents:archive` |
| `collection_create`, `collection_update`, `collection_delete` | Create, change or archive a folder | `knowledge:collections:manage` |
| `add_to_collection`, `remove_from_collection` | File a document in a folder or take it out | `knowledge:collections:manage` |
| `add_folder_source` | Import a Drive folder, a GitLab repository path or the database knowledge base, once or on a schedule | `knowledge:sources:manage` |
| `source_link_create` | Link one remote document so Knowledge always shows its current version | `knowledge:links:create` |
| `synced_sources.list`, `synced_sources.run_now`, `synced_sources.archive` | List synced sources, sync one now, stop syncing one | `knowledge:documents:read` |

See the [agent tool reference](../reference/agent-tools.md).
