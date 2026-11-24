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

The sidebar has two trees: **Personal** for your own notes and **Shared with org** for team documents. Use **New personal folder**, **New shared folder** or **New folder** to make folders, and **Move to** to file a document. Documents in no folder you can see are under **Unfiled**.

A personal folder is yours alone: nobody else sees it, admins included. It does not change who can read a document: one you share from a personal folder is under **Unfiled** for the others. A subfolder is seen by whoever sees the folder it is in. A shared folder that holds something of another person stays shared.

Deleting a folder moves its documents and subfolders to the folder above it. At the top, its documents become unfiled. No document is deleted. When a person's account is erased, their personal folders are archived without their names.

Moving a document, or taking it out of a folder, needs the right to edit it. A folder synced from another app is changed in that app only. You can still take one of your own documents out of it. When the sync is stopped, its folders become ordinary ones; syncing again takes them back.

You can also click **Create knowledge from…** on the Knowledge home to ask your agent to write documents from material you give it.

If someone else saves the document while you edit it, Liaison tells you and offers **Load the latest version**.

## A folder's own page

A folder can have a page of its own: text about what the folder holds, shown above the list of what is inside. The folder has no page until someone writes in it. The first text makes an ordinary document, titled as the folder and filed in it. In a shared folder everyone in the organization can edit it; in a personal folder only you can see it. After that you share it like any other document.

Writing the first text needs the right to manage folders and to create documents. A folder synced from another app has no page.

The list under the page shows the folders and documents directly inside that you can open. Someone who cannot read the folder's page still sees the list, and nothing of the page.

Renaming the folder renames its page, when you can edit the page. Renaming the page renames the folder, when you can manage folders. The page stops being the folder's page when it moves to the archive or leaves the folder; the folder then has none until someone writes in it again. Deleting the folder keeps a page that has text: it goes where the folder's documents go, to the folder above it or to **Unfiled**. An empty page goes to the archive, when the person deleting the folder can archive it.

Agents read and update a folder's page like any other document.

## Images and files in a document

A document's images and files are read by the people who can read the document, and by nobody else. When someone loses access to the document, they lose access to its files too. Adding or removing a file needs the right to edit the document.

A document shows only images stored in Liaison. When you save a document that shows an image or a file of another document, Liaison stores its own copy on this document, so it stays when the other document is deleted. A file you cannot read is not copied: its place in the text is kept, and readers see that it is not available. Only images and files of other documents, and files you have just uploaded, are copied: an email or ticket attachment, a template's file or an encrypted file is never copied onto a document, and readers see it as not available. A copy made by a save that then failed, which no version of the document names, is removed by an hourly cleanup. When your organization's storage is full, the document is still saved and the copy is made at a later save, once there is room.

## Links between documents

A link to another document stores that document's id, never its title. Each reader sees the title only if they can read the linked document; anyone else sees that they cannot open it, and receives no title, in the app or through the API. A link to a document in the archive shows nothing until it is restored. When the linked document is renamed, every link to it shows the new name.

Each document lists the documents that link to it, limited to the ones you can read, beside the conversations that mention it.

Older texts held the linked document's title, as agents wrote their links. Liaison removes those titles from documents, summaries and their history once, in a daily job: only the links change, a document keeps its version and its review status. Self-hosters can run it at once with `liaison knowledge links-backfill` (`--dry-run` only counts). The titles are removed for good: if you go back to a release from before links held only the id, those links show as plain links without a title.

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

An agent can also bring in a GitLab repository folder or the connected database's knowledge base with `knowledge__add_folder_source`. A GitLab folder is the GitLab app's own synced source: it takes the folder reference (`<project>:<branch>:<path>`) and syncs on its schedule, never as a one-time import; see [GitLab](gitlab.md). The database knowledge base is the Database app's own synced source (see below): it takes no folder reference and syncs on its schedule, never as a one-time import.

## Sync from an installed app

An installed app can offer its own kind of synced source, for example a notes tool or a wiki. Liaison keeps its documents up to date the same way: on the source's interval, page by page, from where the last sync stopped. If a sync fails, the next one starts again from the last page that was saved.

Add one through the API: `GET /api/knowledge/synced-sources/kinds` lists the kinds you may add, and `POST /api/knowledge/synced-sources` with `appName`, `sourceKind` and `sourceConfig` adds a source. You need the app's read scope for that kind, and the config must match what the app asks for. Adding a folder that is already a source (the same app, kind, owner and `ref`) gives you that source back, reactivated if it was archived, instead of a second copy. Before every sync, Liaison checks again that the source's owner is still an active member and still holds that scope; if not, the sync stops and the source says why. The app can file the documents in folders of its own, shown as collections inside the source's collection; they follow renames and moves, and a folder that ends up empty is archived. To build such an app, see [Offer a knowledge source](../app-development.md#18-offer-a-knowledge-source).

## Search and link files without syncing them

Some apps let Knowledge reach their files without a copy. GitLab and Google Drive do.

- **Search.** `search` also looks in GitLab (code and text files in the connected group) for people who hold `gitlab:repo:read`. Google Drive joins only once an admin turns it on with `PATCH /api/knowledge/sources/google-drive` and `{ "broadSearchEnabled": true }`; the same call with `false` turns a source off.
- **Live links.** Ask your agent to "link the live pricing sheet, don't copy it". It finds the file, then stores a source link that always opens the current version (`source_link_create`). Verifying or refreshing a link asks the app again: a file that was deleted or is no longer shared with you turns the link **stale**. If the app cannot be reached, the link stays as it was and the agent says so.
- **Reading.** An agent can read the text of a remote hit with `get`.

Each search, link or read goes through your own connection to the app, so you only reach files you can open there.

## Keep documents verified

1. On the Knowledge home, click **Needs review** to see documents that are flagged, stale, missing an owner or past their review date.
2. Open a document, check it, and click **Verify**.

Use **Archive** to retire a document and **Restore** to bring it back.

## Import collections and documents

Collections import as the `knowledge.collection` kind and documents as the `knowledge.document` kind, each matched on its `externalRef`: one imported before is skipped, never updated. In a run with both, collections go first, so a document can be filed in a collection the same run creates (`collectionRefs`). A collection is shared with the organization unless its record says `shared: false`.

An imported document follows the same rules as one you write: its sensitivity sets who in the organization can open it (**Confidential** and **Restricted** documents start shared with nobody), and you can only import a confidential or restricted document, or a team's, if you have access to that sensitivity or team. Tags are matched on their name; an existing tag is reused as it is. Attachments are copies of files you uploaded. A personal document can belong to another person (`ownerEmail`) when you can assign document owners.

Importing documents needs `knowledge:documents:create` (and `knowledge:tags:manage` to tag them), importing collections `knowledge:collections:manage`. Each import is a run you can undo from **Settings › Organization › Imports** (see [Undo an import](../admin/settings.md#undo-an-import)).

## Roles and scopes

Knowledge ships three roles. See [roles](../admin/roles.md).

| Role | Scopes |
|---|---|
| `member` | `knowledge:documents:read`, `knowledge:documents:create`, `knowledge:documents:update`, `knowledge:collections:manage`, `knowledge:links:create`, `knowledge:sources:read`, `knowledge:attachments:download`, `knowledge:attachments:upload` |
| `curator` | `knowledge:tags:manage`, `knowledge:documents:archive`, `knowledge:documents:assign-owner`, `knowledge:sources:manage` |
| `admin` | `knowledge:documents:admin`, `knowledge:cache:manage` |

`knowledge:approve` decides the approvals about documents the organization can read. When an agent asks to create a document for named people only, the person it acts for decides, and nobody else sees the request; if your organization requires two approvers for that tool, the request is refused. Full list: [scope reference](../reference/scopes.md).

## What agents can do

| Tool | What it does | Scope |
|---|---|---|
| `search` | Search Knowledge and enabled remote sources | `knowledge:documents:read` |
| `get` | Read a document or a remote source item, with the files its text shows and the documents it links to that you can read | `knowledge:documents:read` |
| `find_by_title` | Find a document by its exact title | `knowledge:documents:read` |
| `review_queue` | List items that need review | `knowledge:documents:read` |
| `create` | Create a document | `knowledge:documents:create` |
| `update` | Update a document. Images, files and page links in the text are kept exactly | `knowledge:documents:update` |
| `verify` | Mark a document verified | `knowledge:documents:update` |
| `archive`, `restore` | Archive or restore a document | `knowledge:documents:archive` |
| `collection_create`, `collection_update`, `collection_delete` | Create, change or delete a folder. A created folder is shared unless the user asks for a personal one | `knowledge:collections:manage` |
| `add_to_collection`, `remove_from_collection` | File a document in a folder or take it out | `knowledge:collections:manage` |
| `add_folder_source` | Import a Drive folder, a GitLab repository path or the database knowledge base, once or on a schedule | `knowledge:sources:manage` |
| `source_link_create` | Link one remote document so Knowledge always shows its current version | `knowledge:links:create` |
| `synced_sources.list`, `synced_sources.run_now`, `synced_sources.archive` | List synced sources, sync one now, stop syncing one | `knowledge:documents:read` |

See the [agent tool reference](../reference/agent-tools.md).
