---
title: Google Drive
description: "Connect Google Drive so agents can search, read and attach your Drive files, sync folders into Knowledge, and save new reports to Drive."
---

Google Drive lets your agents find and read files in a connected Drive account, attach them to email and tickets, and save new files back to Drive. To make a Drive folder part of [Knowledge](knowledge.md), sync it as a source.

## Connect Google Drive

1. Open **Settings › Apps › Google Drive**, section **Connection**. Managing the connection needs `google-drive:accounts:admin`.
2. Click **Connect**. You are sent to Google's consent screen.
3. Approve read access to Drive (`drive.readonly`) and per-file write access (`drive.file`). With a personal Google account on the server's Google client, Google asks only for per-file access: see [Choose the files Liaison sees](#choose-the-files-liaison-sees).

Drive connects through the workspace's own Google Drive client or, when this server provides one for every workspace, the server's. The workspace's own client always wins. If neither is set up yet, ask an admin to add one (see [Connect apps](../connecting-apps.md)). No password is stored. You can revoke access at any time by disconnecting here or in your Google account permissions.

## Share the organization's shared drives

A Drive the organization connects (not a person's own) shares the organization's files, never one person's Drive. It reads only the **shared drives** an admin picks: nothing in anyone's **My Drive**, and nothing in a shared drive nobody picked. Each person reaches their own files through their own Drive connection.

The Google account the organization connected can also be connected as one person's own Drive (for example with `liaison connect google-drive/drive --for <their email>`). The two connections stay separate: the organization's reads only the picked shared drives, the person's own reads their Drive, and each keeps its own sign-in. That person's agent reads through their own connection; everyone else's through the organization's. Another member cannot connect that account as their own. Disconnecting one removes only the Knowledge folders synced through it.

1. Connect Drive for the organization with a Google account that is a member of each shared drive the team should see (any role). Google lists only that account's shared drives.
2. On the organization's Drive connection in **Settings › Apps › Google Drive**, the **Shared drives the team sees** card lists what it shares. Click **Choose shared drives**, tick the drives and click **Save**. Choosing needs `google-drive:accounts:admin`.
3. Everyone who uses the organization's connection then sees the files in those drives, in agent searches and reads, Knowledge search and synced folders.

Until a shared drive is picked, the connection reads nothing and the card says **Pick the shared drives the team should see**. This includes a Drive the organization connected before shared drives were chosen: it stops reading until an admin picks, and never falls back to the connecting person's Drive. What the organization's Drive already put in Knowledge follows the same rule:

- While no shared drive is picked, the folders it syncs are hidden: their documents and links leave every Knowledge read and search, and the folder says why. Synced folders from a person's own Drive connection are never touched.
- When an admin changes the picked drives, those folders are hidden and sync again at once, which brings back what the picked drives hold. Every change is recorded in the audit log (`google-drive.shared_drives.changed`, with the drives before and after).
- A synced folder in none of the picked drives is deleted from Knowledge at its next sync (its documents, links and the subcollections the sync made). The folder stays in error saying why: move it into a picked drive, pick its drive, or remove it.

You can also pick them by asking the agent (`shared_drives`, then `choose_shared_drives`, which asks for approval) or in the config for `liaison config apply`, by id or name:

```yaml
apps:
  - name: google-drive
    enable: true
    connection:
      name: drive
      sharedDrives: ["Team", "Support"]
```

Until the organization's Drive is connected, `config apply` lists the shared drives as pending; the next apply sets them. A drive the connecting account is not a member of fails the apply by name.

## Choose the files Liaison sees

A personal Google account (for example a @gmail.com address) connected through the server's Google client, before Google has verified that client for full Drive access, connects in **picked** mode: Liaison sees only the files and folders you pick. A Google Workspace account, or the workspace's own Google client, reads the whole Drive (**full** mode). The mode follows the address being connected: the agent's Connect card carries it and Google's consent opens on that account; **Connect** in Settings uses the address you sign in to Liaison with. Unchecking the Drive read permission on Google's consent screen also gives picked mode. A reconnect keeps full mode only for the same address.

1. In picked mode, the **Choose files for Liaison** card shows on the Connect card once Drive is connected, in the conversation when the agent offers it, on the Drive account in **Settings › Apps › Google Drive**, and in **Settings › Apps › Knowledge**, above **Add source**.
2. Click **Choose files**. Google's file picker opens in a window (in the desktop and phone apps, in your system browser). Pick files and folders from **My Drive**, shared files or shared drives, then confirm.
3. The card shows how many items are picked and the sync: **Syncing 12 files…**, then the count in Knowledge. A picked file with no text to import, such as a PDF or an image, is marked **not in Knowledge**: the agent can still attach it.
4. When you pick from the card the agent showed in a conversation, the agent is told what you picked and carries on in that conversation, for example reading the file you asked about. Picks made in Settings post nothing.
5. In a conversation, the card lists first what you picked from it, under **Picked here**, then one line for the files picked elsewhere (**2 other files already visible**) with **Manage** to see and remove them. What you pick stays visible to Liaison in every conversation; Settings and Knowledge list every picked file.

The picked items sync into [Knowledge](knowledge.md) as one source, **Google Drive: <your address>**, personal to you (shared with the organization, as internal, for a Drive the organization connects). A picked folder brings the files Google shows inside it; a file added to it later may need picking too. Click **×** next to an item to remove it: its documents leave Knowledge at the next sync. A picked file you delete, trash or stop sharing in Drive leaves too. If another person connects the same Google account, your picks stay with you: they do not follow the account.

In picked mode, a Drive search always lists the files you picked, whatever words the agent searched for, so the agent finds a picked file in one search. When the file you name is not among them, the agent shows the card so you can pick it. In full mode it never asks you to pick.

The picker needs two server settings, `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER` (see [Environment variables](../reference/env.md)). Without them the card says so instead of showing **Choose files**.

## What Liaison can and cannot change in Drive

- It reads your existing files and never changes or deletes them.
- It creates new files only inside a folder it owns, **Liaison Reports**, created on the first upload.
- Native Google Docs, Sheets and Slides cannot be imported as files, but agents can read their text.

## Work with Drive files through an agent

Ask your agent in plain words, for example:

- "Find the product manual in Drive and summarise it." The agent uses `search`, then `read`.
- "Attach the spec sheet from Drive to my reply." The agent imports the file with `import` and attaches it to the draft.
- "Save this analysis to Drive." The agent uses `upload` and gives you the file's link.

Drive is also a search source for Knowledge, so Knowledge search can return Drive files. To bring a Drive document or folder into Knowledge itself, sync the folder from **Settings › Apps › Knowledge** ([Knowledge](knowledge.md#sync-a-google-drive-folder)). Importing a file does not add it to Knowledge.

## Disconnect Drive

Click **Disconnect** on the connection. The Drive folders synced into Knowledge from this account are deleted from Liaison, with the documents and links made from them. Files you imported and documents you wrote stay. Your files stay in Google Drive.

## Roles and scopes

| Role | Scopes |
|---|---|
| `member` | `google-drive:accounts:read`, `google-drive:files:write` |
| `admin` | `member` plus `google-drive:accounts:admin` |

`google-drive:approve` decides any Google Drive approvals. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

| Tool | What it does | Scope |
|---|---|---|
| `search` | Search Drive by name or content and return file ids | `google-drive:accounts:read` |
| `read` | Read a file's text. Google Sheets and Excel workbooks (.xlsx, each sheet in turn) come back as CSV, Docs and Slides as plain text. PDFs and images are not readable. | `google-drive:accounts:read` |
| `import` | Bring a file into Liaison as an attachable file | `google-drive:accounts:read` |
| `upload` | Create a new file (up to 5 MB) in the **Liaison Reports** folder | `google-drive:files:write` |
| `shared_drives` | List the organization's Drive connections, the shared drives each shares and the ones its account can share | `google-drive:accounts:admin` |
| `choose_shared_drives` | Replace the shared drives the organization's Drive shares (asks for approval) | `google-drive:accounts:admin` |

A file outside the picked shared drives, or one that does not exist, is refused with `outside_shared_drives`, and an organization's Drive with none picked answers `shared_drives_not_chosen`. Uploads (`upload`) go only through a person's own Drive connection: through the organization's they answer `org_drive_upload_unsupported`.

See the [agent tool reference](../reference/agent-tools.md).
