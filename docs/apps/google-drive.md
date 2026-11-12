---
title: Google Drive
description: "Connect Google Drive so agents can search, read and attach your Drive files, sync folders into Knowledge, and save new reports to Drive."
---

Google Drive lets your agents find and read files in a connected Drive account, attach them to email and tickets, and save new files back to Drive. To make a Drive folder part of [Knowledge](knowledge.md), sync it as a source.

Google Drive is an app of the app catalog: an organization turns it on like any other app (`enable: true` in the config, or **Settings › Apps**). A server that ran it before it moved to the catalog installs it on its own at the next start, with every connection, picked file, chosen shared drive and synced folder kept.

## Connect Google Drive

1. Open **Settings › Apps › Google Drive**, section **Connection**. Anyone can connect their own Drive there; only holders of `google-drive:accounts:admin` see and manage the organization's connection.
2. Click **Connect**. You are sent to Google's consent screen.
3. Approve read access to Drive (`drive.readonly`) and per-file write access (`drive.file`). With a personal Google account on the server's Google client, Google asks only for per-file access: see [Choose the files Liaison sees](#choose-the-files-liaison-sees).

Drive connects through the workspace's own Google Drive client or, when this server provides one for every workspace, the server's. The workspace's own client always wins. If neither is set up yet, ask an admin to add one (see [Connect apps](../connecting-apps.md)). No password is stored. You can revoke access at any time by disconnecting here or in your Google account permissions.

## Share the organization's shared drives

A Drive the organization connects (not a person's own) shares the organization's files, never one person's Drive. It reads only the **shared drives** an admin picks: nothing in anyone's **My Drive**, and nothing in a shared drive nobody picked. Each person reaches their own files through their own Drive connection.

The Google account the organization connected can also be connected as one person's own Drive (for example with `liaison connect google-drive/drive --for <their email>`). The two connections stay separate: the organization's reads only the picked shared drives, the person's own reads their Drive, and each keeps its own sign-in. That person's agent reads through their own connection; everyone else's through the organization's. Another member cannot connect that account as their own. Disconnecting one removes only the Knowledge folders synced through it.

1. Connect Drive for the organization with a Google account that is a member of each shared drive the team should see (any role). Google lists only that account's shared drives.
2. In **Settings › Apps › Google Drive**, section **Shared drives**, each organization connection lists the shared drives its Google account is a member of. Tick the drives the team should see and click **Save**. The section and the choice need `google-drive:accounts:admin`.
3. Everyone who uses the organization's connection then sees the files in those drives, in agent searches and reads, Knowledge search and synced folders.

Until a shared drive is picked, the connection reads nothing and the section says **No shared drive chosen yet**. This includes a Drive the organization connected before shared drives were chosen: it stops reading until an admin picks, and never falls back to the connecting person's Drive. What the organization's Drive already put in Knowledge follows the same rule:

- While no shared drive is picked, the folders it syncs are hidden: their documents and links leave every Knowledge read and search, and the folder says why. Synced folders from a person's own Drive connection are never touched.
- When an admin changes the picked drives, those folders sync again at once, against the new choice. Every change is recorded in the audit log (the account's metadata change, with the keys changed).
- A synced folder in none of the picked drives is hidden from Knowledge at its next sync (its documents and links leave every read and search). Move it into a picked drive, pick its drive, or remove it.

You can also pick them by asking the agent (`shared_drives`, then `choose_shared_drives`, which asks for approval) or in the config for `liaison config apply`, by id or name:

```yaml
apps:
  - name: google-drive
    enable: true
    connection:
      name: drive
      ownerType: org
    provision:
      sharedDrives:
        - account: team@example.com
          drives: ["Team", "Support"]
```

`provision` runs once the connection is in place; `account` names the organization connection's Google account and can be left out when there is one. A drive the connecting account is not a member of fails the apply by name. The former `connection.sharedDrives` key is refused, with a message saying it moved to `provision.sharedDrives`.

## Choose the files Liaison sees

A personal Google account (for example a @gmail.com address) connected through the server's Google client, before Google has verified that client for full Drive access, connects in **picked** mode: Liaison sees only the files and folders you pick. A Google Workspace account, or the workspace's own Google client, reads the whole Drive (**full** mode). The mode follows the address being connected: the agent's Connect card carries it and Google's consent opens on that account; **Connect** in Settings uses the address you sign in to Liaison with. Unchecking the Drive read permission on Google's consent screen also gives picked mode. A reconnect keeps full mode only for the same address.

1. In picked mode, **Settings › Apps › Google Drive**, section **Connection**, lists each of your Drive accounts in picked mode with what is picked and a **Choose files** button. In a conversation, the agent shows an **Open** button (`drive_picker`) when a file you name is not picked yet.
2. Click **Choose files** (or **Open**). Google's file picker opens on the app's own page, in a window (in the desktop and phone apps, in your system browser). Pick files and folders from **My Drive**, shared files or shared drives, then confirm.
3. The section shows how many items are picked and the sync: **Syncing into Knowledge…**, then the count in Knowledge. A picked file with no text to import, such as a PDF or an image, is listed as having no text Knowledge can import: the agent can still attach it.
4. Tell the agent once you picked: it then finds the file in one search. What you pick stays visible to Liaison in every conversation.

The picked items sync into [Knowledge](knowledge.md) as one source, **Google Drive: <your address>**, personal to you (shared with the organization, as internal, for a Drive the organization connects). A picked folder brings the files Google shows inside it; a file added to it later may need picking too. Click **×** next to an item to remove it: its documents leave Knowledge at the next sync. A picked file you delete, trash or stop sharing in Drive leaves too. If another person connects the same Google account, your picks stay with you: they do not follow the account.

In picked mode, a Drive search always lists the files you picked, whatever words the agent searched for, so the agent finds a picked file in one search. When the file you name is not among them, the agent shows the card so you can pick it. In full mode it never asks you to pick.

The picker needs an API key of the Drive client's Google Cloud project with the Google Picker API on, and that project's number: the server settings `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER` (see [Environment variables](../reference/env.md)), or, for one organization, the app's config keys `pickerApiKey` and `pickerAppId` (`apps[].config` with `liaison config apply`, which win over the server settings). Without them the section says so instead of showing **Choose files**.

## Link a Drive file in Knowledge

Your agent can link one Drive file into Knowledge so it always shows the current version, instead of copying it. Knowledge search includes Drive only once an admin turns it on. See [Search and link files without syncing them](knowledge.md#search-and-link-files-without-syncing-them).

## What Liaison can and cannot change in Drive

- It reads your existing files and never changes or deletes them.
- It creates new files only inside a folder it owns, **Liaison Reports**, created on the first upload.
- Native Google Docs, Sheets and Slides cannot be imported as files, but agents can read their text.

## Work with Drive files through an agent

Ask your agent in plain words, for example:

- "Find the product manual in Drive and summarise it." The agent uses `search`, then `read`.
- "Attach the spec sheet from Drive to my reply." The agent imports the file with `import` and attaches it to the draft.
- "Save this analysis to Drive." The agent uses `upload` and gives you the file's link.

To bring a Drive folder into Knowledge, sync it as a source: ask the agent (`add_folder_source` with the folder's id), and the app syncs the folder and its subfolders, each subfolder a collection ([Knowledge](knowledge.md#sync-a-google-drive-folder)). Knowledge search finds what the synced folders hold; it does not query Drive live. Importing a file does not add it to Knowledge.

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
| `upload` | Create a new file in the **Liaison Reports** folder, from a Liaison file (`sourceFileId`, up to 25 MB) or base64 content (up to 5 MB) | `google-drive:files:write` |
| `shared_drives` | List the organization's Drive connections, the shared drives each shares and the ones its account can share | `google-drive:accounts:admin` |
| `choose_shared_drives` | Replace the shared drives the organization's Drive shares (asks for approval) | `google-drive:accounts:admin` |
| `drive_picker` | Say the Drive mode of the person's accounts and, in picked mode, show the **Open** button to Google's picker | `google-drive:accounts:read` |

A file outside the picked shared drives, or one that does not exist, is refused with `outside_shared_drives`, and an organization's Drive with none picked answers `shared_drives_not_chosen`. Uploads (`upload`) go only through a person's own Drive connection: through the organization's they answer `org_drive_upload_unsupported`.

See the [agent tool reference](../reference/agent-tools.md).
