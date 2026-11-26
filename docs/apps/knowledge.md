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
3. Give it a title and write the body. There is no Save button: a page saves itself.

A page you may edit is edited in place: click in its text and write. It is saved about a second after you stop typing, and at least every few seconds while you type. The header says **Saving…**, **Saved**, or **Not saved** with the reason. People who may only read a page see its text without an editor.

Text that is not saved yet is kept in this browser, per person, page and tab, until the page has it. If you close the tab, reload, lose the connection or your session ends, the text is back when you open the page again. A page over 1,000,000 characters, or with a title over 240 characters, is not saved until it is shortened; a page moved to the trash or no longer yours to edit while you type keeps your text on screen with **Copy text**.

When you sign out with text that could not be saved, Liaison first tries to save it, or to put it in the page's history. What is left is listed with **Copy** for each page: **Stay signed in** keeps it, **Sign out and discard** drops it.

You can also click **Create knowledge from…** on the Knowledge home to ask your agent to write documents from material you give it.

If someone else saves the page while you write, or you do in another tab, Liaison tells you and keeps your text. Click **Choose what to keep**: **Keep mine** makes your text the page, **Take theirs** shows the other text, and **See both** compares them first. Whatever you choose, the other text stays in **Page history**. If you leave without choosing, the other text is shown and yours goes to **Page history**. If only the title changed elsewhere (someone renamed the page) and you did not edit the title, Liaison takes the new title and saves your text, without asking.

## Organise documents and folders

The sidebar has two trees: **Personal** for your own notes and **Shared with org** for team documents. Any member can make, rename, move and delete the folders they see, and rename and move the documents they can edit.

- **New page in a folder**: point at the folder and click its **+**. A page made in one of your personal folders is yours alone until you share it.
- **Row menu**: every folder and document has a **…** button (or right click it). A folder offers **New page**, **New folder**, **Rename**, **Move to…** and **Delete folder**; a document offers **Rename**, **Move to…** and **Copy link**, and **Move to trash** (with **Undo** for 10 seconds) if you hold `knowledge:documents:archive`; a synced document has no **Move to trash**. A document you can only read offers **Copy link** alone, and the folder actions and **+** buttons show only if your role lets you organise folders and make pages. The menu works with the mouse, the keyboard (Enter opens it, Escape closes it) and on touch.
- **Move to…** opens a list of folders you can search. Moving between **Personal** and **Shared with org** asks first and says who will see it. You can also drag a row onto a folder.
- **New personal folder** and **New shared folder** (the **+** next to each tree's name) make a top folder.

The open document is marked in the tree, its folders open, and a breadcrumb above its title says where it is (for example **Shared with org / Policies**). When someone else adds, renames, moves or deletes something you can see, your tree follows within a few seconds. If an action is refused, a message says why; nothing is changed.

Documents in no folder you can see are under **Unfiled**. Click **Unfiled** at the bottom of the sidebar to list them, and click it again, or **Knowledge** above the list, to go back. Press Enter in the sidebar's search box to see every result.

A personal folder is yours alone: nobody else sees it, admins included. It does not change who can read a document: one you share from a personal folder is under **Unfiled** for the others. A subfolder is seen by whoever sees the folder it is in. A shared folder that holds something of another person stays shared.

Deleting a folder moves its documents and subfolders to the folder above it. At the top, its documents become unfiled. No document is deleted. When a person's account is erased, their personal folders are archived without their names.

Moving a document, or taking it out of a folder, needs the right to edit it, and happens in one step: if it is refused, the document stays where it was. A folder synced from another app is changed in that app only, and its rows have no rename, move or delete. You can still take one of your own documents out of it. When the sync is stopped, its folders become ordinary ones; syncing again takes them back.

### Add a block with /

Type **/** at the start of a line, or after a space, to open **Add a block**: **Text**, **Heading 1** to **Heading 3**, **Checklist**, **Bulleted list**, **Numbered list**, **Quote**, **Code block**, **Table** and **Divider**, plus **Image**, **File** and **Link to a page** where the page takes them. Type a few letters to narrow the list (in your language: "todo", "to-do" or "tâche" finds **Checklist**, "callout" finds **Quote**), move with the arrow keys and press Enter, or click one. After a word ("50 km /h"), Enter stays a new line unless you first chose a block with the arrow keys. Escape closes it and leaves the slash as text. An empty page says **Write, or type / for blocks**. A slash inside a word, an address or code never opens it. Every block is stored as plain markdown, so agents and other apps read the page as you see it.

Tick a checklist item by clicking its box, or press Ctrl+Enter (Cmd+Enter on a Mac) with the caret in the item. This shortcut ticks only in a page: in a task discussion or a ticket note, Ctrl+Enter still sends. The page saves the change like any other edit. People who may only read the page see which items are done and cannot tick them.

## See and restore a page's history

1. Open the page and click the **...** menu, then **Page history**.
2. Pick a version on the right: who wrote it, when, and what changed since is marked.
3. Click **Restore this version** to give the page that text back. The text it replaces stays in the history.

Every change by a person or an agent is kept with its author and time. One person's edits in one tab within 10 minutes form one version; an agent's write is always its own. A page keeps its versions for a year and at most 200 of them, oldest first out, but each author's newest version and every text kept aside from a conflict are never removed to make room, and texts kept aside from a conflict are kept past a year too. Pages synced from another app have no history. Anyone who may edit a page sees its history.

## A folder's own page

Click a folder's name in the sidebar to open it as a page; the arrow next to it only shows or hides what is inside. The folder page has the folder's own text, then **In this folder**: the folders and documents directly inside that you can open, each opening in its own tab. An empty folder says **Nothing here yet.**; **New page** makes a document in the folder (private, in a personal folder). **New page** shows only if your role lets you make pages. The folders above it are links at the top.

To write the folder's text, click under its name (**Write about this folder**) and type: the page is made as you start, and saves itself like any page. Until the page exists, what you type is kept in this browser like any unsaved page text: signing out asks about it, and it comes back if you close the tab and open the folder again. If the page cannot be made, a message says so, with **Try again** and **Copy text**; nothing is sent again until you click **Try again**. If someone else made the folder's page while you typed, your text never replaces theirs: the page opens with your text and asks you what to keep, as when two people edit one page.

A folder can have a page of its own: text about what the folder holds, shown above the list of what is inside. The folder has no page until someone writes in it. The first text makes an ordinary document, titled as the folder and filed in it. In a shared folder everyone in the organization can edit it; in a personal folder only you can see it. After that you share it like any other document.

Writing the first text needs the right to manage folders and to create documents. A folder synced from another app has no page.

The list under the page shows the folders and documents directly inside that you can open. Someone who cannot read the folder's page still sees the list, and nothing of the page.

Renaming the folder renames its page, when you can edit the page; a verified page stays verified, as its text did not change. Renaming the page renames the folder, when you can manage folders; otherwise only the page is renamed. The page stops being the folder's page when it moves to Trash or leaves the folder; the folder then has none until someone writes in it again. Deleting the folder keeps a page that has text: it goes where the folder's documents go, to the folder above it or to **Unfiled**. An empty page goes to Trash, when the person deleting the folder can move it there.

Agents read and update a folder's page like any other document.

## Images and files in a document

### Add an image or a file

- Paste an image or a file into the text, or drop it on the text. It is uploaded and shows where the cursor was.
- Or click **Image** or **File** in the toolbar and pick one or more files.
- To add a file without putting it in the text, click **Add a file** under **Attachments**. On a phone, open **Sources** first.

An image shows as the picture. Any other file, an SVG image included, shows as a card with its name and size; click it to download the file. While a file uploads, the text shows **Uploading** and its name. A file that is too large, or that does not fit in your organization's storage, is not added, and Liaison says why.

When you remove an image or a file from the text, the file stays listed under **Attachments**. It is deleted with the document.

A pasted image from a website is never loaded: the text keeps its address and shows **Image from another site, not loaded**. Upload the image instead. An image or a file of another document you cannot open is not added when you paste it, and Liaison tells you.

A document's images and files are read by the people who can read the document, and by nobody else. When someone loses access to the document, they lose access to its files too. Adding or removing a file needs the right to edit the document.

A document shows only images stored in Liaison. When you save a document that shows an image or a file of another document, Liaison stores its own copy on this document, so it stays when the other document is deleted. A file you cannot read is not copied: its place in the text is kept, and readers see that it is not available. Only images and files of other documents, and files you have just uploaded, are copied: an email or ticket attachment, a template's file or an encrypted file is never copied onto a document, and readers see it as not available. A copy made by a save that then failed, which no version of the document names, is removed by an hourly cleanup. When your organization's storage is full, the document is still saved and the copy is made at a later save, once there is room.

## Links between documents

To link a document while you write, type `@` or `[[` at the start of a word, then a few letters of its title. The list shows only documents you can read; pick one with the arrow keys and Enter, or click it. Escape closes the list. Pasting the address of a document from this workspace also makes a link. A link shows the document's title; click it to open the document.

A link to another document stores that document's id, never its title. Each reader sees the title only if they can read the linked document; anyone else sees that they cannot open it, and receives no title, in the app or through the API. A link to a document in the archive shows nothing until it is restored. When the linked document is renamed, every link to it shows the new name.

Each document lists the documents that link to it, limited to the ones you can read, beside the conversations that mention it: open **references** in the document's header to see them under **Linked from** and **Conversations**, and click one to open it.

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

Admins have no bypass: a restricted document is editable only by its owner or someone with an **Editor** share. Search follows the same sharing rules, so a document not shared with you does not appear in your results or your agent's. When an agent reads a restricted document, what it writes next can be read only by the people the document is shared with.

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

To retire a document, open its **…** menu and click **Move to trash**.

## Trash

**Move to trash** (in a page's **…** menu) moves a document to Trash. It leaves the knowledge base and search at once, and it is deleted for good 30 days later, with its history, its files, its links, its sharing and its place in folders. For 10 seconds a message offers **Undo**. An agent's `archive` does the same and starts the same 30 days.

1. In the Knowledge sidebar, click **Trash**, under **Unfiled**. The number beside it counts the documents you can restore.
2. Each document shows who moved it and when, and how many days are left. **Kept** means it was archived before Trash existed.
3. Click **Restore** to bring a document back. A link to a document in Trash opens the same card, with **Restore**.
4. An administrator also sees **Delete for good**, and confirms before the document is removed.

- Anyone who can edit a document can see it in Trash and restore it until then. A restored document goes back to its folders, or to Unfiled when none of them is left.
- Documents archived before Trash existed are listed as kept, with no date: they are never deleted automatically.
- Synced documents (Google Drive, GitLab, a database) cannot be moved to Trash. Manage them in their source.
- An administrator (`knowledge:documents:admin`) who can edit a document in Trash can delete it for good at once. A document archived before Trash is restored and moved to Trash first.
- Links to a deleted document and images from its files stay in other documents' text and show as unavailable.

Through the API: `GET /api/knowledge/trash` lists what you can restore, with `daysLeft` (null when kept); `POST /api/knowledge/documents/:id/trash` moves a document to Trash; `POST /api/knowledge/documents/:id/restore` restores it; `DELETE /api/knowledge/documents/:id` deletes it for good.

Stored versions of a document are kept for a year.

## Import from Notion

You can bring a Notion workspace into Knowledge yourself, from a Notion export.

1. In Notion, open **Settings**, then **Export all workspace content**. Choose **Markdown & CSV**, with subpages and files. Notion emails you a link to a zip.
2. In Knowledge, click **Import from Notion** (on the Knowledge home, or at the bottom of the sidebar). It opens its own tab.
3. Click **Choose the zip** (or drop it on the tab) and pick the zip as it is, without unzipping it. One zip, or a zip of zips, up to 1 GB.
4. Read the preview. Nothing is created yet. It shows how many folders, pages and files the import makes, how many are already here, the storage your organization has left (for administrators), and every item that will not come across, by kind: images on other websites, embeds, links to pages not in the export, files missing from the export, pages over 1 MB, database rows past the first 200, and so on.
5. Under **Who can see these pages**, keep **Only me** (the default), or choose **Everyone can view** or **Everyone can edit**. The choice covers the pages and their folders. Changing it checks the export again, because what is already here differs: pages only you can see are matched against your own earlier imports, shared pages against everyone's.
6. Click **Import N pages**. You can close the tab and work elsewhere: the import keeps going, and **Import from Notion** shows where it is when you come back.
7. Read the report: what was made, then every item that did not come across, with a search box and **Copy the list**. Items past the first 20,000 are counted, never left out of the total.

A page with subpages becomes a folder with its own folder page, links between exported pages become page links, images and files become files of their page, and a database becomes a folder page holding a table of its first 200 rows, with its row pages inside. Importing the same export again creates nothing twice: every page already here is named in the preview.

The import refuses, with the reason, a PDF or a web page instead of the zip, an HTML export (export again as **Markdown & CSV**), a zip with no Notion pages, a password-protected zip, a zip that expands far more than its size, and zips nested more than one level deep.

### Undo a Notion import

At the end of the report, click **Undo the import**, then **Remove them**. It removes the pages, folders and files the import made. A page someone changed since the import is kept, and so is the folder that holds it: the result names each page or folder kept and why.

Importing needs the **Imports** permissions (`kernel:imports:run` and `kernel:imports:read`) and the right to create pages and folders; undoing needs `kernel:imports:undo`. Without the **Imports** permissions, **Import from Notion** is not shown; a link to the tab says so: ask an administrator. The run also appears under **Settings › Organization › Imports**.

## Import collections and documents

Collections import as the `knowledge.collection` kind and documents as the `knowledge.document` kind, each matched on its `externalRef`: one imported before is skipped, never updated. In a run with both, collections go first, so a document can be filed in a collection the same run creates (`collectionRefs`). A collection is shared with the organization unless its record says `shared: false`.

An imported document follows the same rules as one you write: its sensitivity sets who in the organization can open it (**Confidential** and **Restricted** documents start shared with nobody), and you can only import a confidential or restricted document, or a team's, if you have access to that sensitivity or team. Tags are matched on their name; an existing tag is reused as it is. Attachments are copies of files you uploaded. A personal document can belong to another person (`ownerEmail`) when you can assign document owners.

Importing documents needs `knowledge:documents:create` (and `knowledge:tags:manage` to tag them), importing collections `knowledge:collections:manage`. Each import is a run you can undo from **Settings › Organization › Imports** (see [Undo an import](../admin/settings.md#undo-an-import)).

## Roles and scopes

Knowledge ships three roles. See [roles](../admin/roles.md).

| Role | Scopes |
|---|---|
| `member` | `knowledge:documents:read`, `knowledge:documents:create`, `knowledge:documents:update`, `knowledge:collections:manage`, `knowledge:documents:archive`, `knowledge:links:create`, `knowledge:sources:read`, `knowledge:attachments:download`, `knowledge:attachments:upload` |
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
| `archive`, `restore` | Move a document to Trash (deleted after 30 days) or restore it | `knowledge:documents:archive` |
| `collection_create`, `collection_update`, `collection_delete` | Create, change or delete a folder. A created folder is shared unless the user asks for a personal one | `knowledge:collections:manage` |
| `add_to_collection`, `remove_from_collection` | File a document in a folder or take it out | `knowledge:collections:manage` |
| `add_folder_source` | Import a Drive folder, a GitLab repository path or the database knowledge base, once or on a schedule | `knowledge:sources:manage` |
| `source_link_create` | Link one remote document so Knowledge always shows its current version | `knowledge:links:create` |
| `synced_sources.list`, `synced_sources.run_now`, `synced_sources.archive` | List synced sources, sync one now, stop syncing one | `knowledge:documents:read` |

See the [agent tool reference](../reference/agent-tools.md).
