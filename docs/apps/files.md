---
title: Files
description: "Attach files to email, tickets, chat and Knowledge documents, open and download them, and let agents find, merge and attach files."
---

Files are the attachments that live on your email, tickets, chat messages and Knowledge documents. There is no separate file browser: a file belongs to the conversation, ticket or document it was attached to, and people see it when they can see that item. A data-subject export is the exception: it belongs to no item, and only the person who ran the export can open it.

## Attach a file

1. In a mail reply, a ticket reply or note, or a chat message, click **Attach**.
2. Pick one or more files. Each file shows as a chip while it uploads. Click the remove button on a chip to drop it.
3. Send as usual. If you press send while a file is still uploading, the message waits (**Queued**) and goes out once every file is uploaded.

Knowledge documents and tickets also list their files, under **Attachments** on a document and in the ticket's details.

Whoever runs the server can give the organization a storage limit (**Settings › Organization › Usage and limits** shows it). An upload that would go past it is refused with **STORAGE_QUOTA_EXCEEDED**, and so are a file an agent creates by merging PDFs or exporting a person's data, a file an import attaches to a record, an attachment an app saves for a person or an agent, and a PDF an app renders for them; with no limit, storage is unlimited.

Two kinds of file are kept even at the limit, and still count toward it: attachments of incoming mail that Liaison syncs on its own, and legal records such as an issued invoice's original PDF. Admins get a notification once when storage passes 80 % of the limit, asking them to upgrade or free space, and again at 100 %; they are told again only after use has dropped back under 80 %.

Some file types are refused everywhere: executables and scripts such as `.exe`, `.bat`, `.cmd`, `.msi` or `.jar`. Liaison checks every part of the name, so `payload.exe.pdf` is refused too.

## Open and download a file

1. Click an image to open it full size. Use **Download** or **Close**.
2. For any other file, click **Download** on its card.

Attachments are downloaded, not displayed as web pages, so an HTML or SVG file cannot run in Liaison.

Where each org has its own address, a download link works on that address only.

An attachment of a transparent personal mailbox opens for the mailbox's owner only, like the mail itself. See [Mail](mail.md#choose-how-your-mailbox-is-encrypted).

## Remove a file

Removing a file attached to an item takes write access to that item. Some items also limit it to the person who added the file and an administrator of the app: on a project task, that is the uploader or a holder of `projects:settings:admin`. See [Projects](projects.md#work-on-a-task).

## Have an agent work with files

Ask, for example, "Attach the signed quote to my reply to orders@resonantaudiolabs.example" or "Merge these three invoice PDFs into one". The agent lists the files on the item, then passes the file to the send tool so it is really attached. When the send is gated, the approval card shows the attachment. A file an earlier step of the same request makes, such as a quote's PDF, reads as that step ("[quote PDF from step 2]") and is attached once that step has run. One agent call attaches at most 10 files and 25 MB in total.

An attached file is a copy, and the copy keeps who attached it. A copy made by an app's webhook or background job, with no person behind it, records no uploader.

With `kernel:files:analyze`, an agent can also analyze an image, video or PDF attachment, for example to read the line items of a supplier invoice. On a managed instance the file is analyzed in one request of at most 60 MB; a larger video is refused with "This file is too large to analyse here (max 60 MB)."

## Scopes

| Scope | What it allows |
|---|---|
| `kernel:files:read` | Read files attached to items |
| `kernel:files:analyze` | Analyze image and video files with the media-analysis tool |

You also need access to the item a file is attached to. See the [scope reference](../reference/scopes.md).

## What agents can do

| Tool | What it does | Scope |
|---|---|---|
| `files_list` | List the files attached to one item | `kernel:files:read` |
| `files_read` | Get a short-lived download link and the file's details | `kernel:files:read` |
| `files_upload_url`, `files_upload_confirm` | Put a local file into Liaison so a send tool can attach it | `kernel:files:read` |
| `files_merge_pdfs` | Merge stored PDFs into one new PDF | `kernel:files:read` |
| `analyze_media` | Summarise an image, video or PDF attachment | `kernel:files:analyze` |
| `mail_attachment_read` | Read one email attachment (PDF, Word, Excel, PowerPoint, image, video), private mailboxes included | `mail:conversations:read`, `kernel:files:analyze` |

Drive files come in through [Google Drive](google-drive.md). See the [agent tool reference](../reference/agent-tools.md).
