// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What an IMAP mailbox can do beyond reading its INBOX, and the operations that
 * give it parity with a Gmail-API mailbox: folders found by RFC 6154
 * SPECIAL-USE, changes made in Liaison written back (read, star, archive,
 * trash), the INBOX state read back (flags, membership), and a copy of mail
 * sent over SMTP filed in Sent on servers that do not do it themselves.
 *
 * A message is found on the server again by its Message-ID header: its UID
 * changes with every move, its Message-ID never does. Every function here takes
 * an open client, so the tests drive them with a fake server.
 */
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "imap-mailbox" })

/** The parts of an ImapFlow client these operations use. */
export interface ImapClientLike {
  capabilities: Map<string, boolean | number>
  mailbox?: unknown
  list(options?: {
    listOnly?: boolean
  }): Promise<
    Array<{ path: string; specialUse?: string; specialUseSource?: string; flags?: Set<string> }>
  >
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ release(): void }>
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<unknown>
  fetch(
    range: string | number[],
    query: Record<string, unknown>,
    options?: { uid?: boolean; changedSince?: bigint | number },
  ): AsyncIterable<{ uid: number; flags?: Set<string> }>
  messageFlagsAdd(
    range: number[],
    flags: string[],
    options?: { uid?: boolean; useLabels?: boolean },
  ): Promise<boolean>
  messageFlagsRemove(
    range: number[],
    flags: string[],
    options?: { uid?: boolean; useLabels?: boolean },
  ): Promise<boolean>
  messageMove(range: number[], destination: string, options?: { uid?: boolean }): Promise<unknown>
  append(path: string, content: Buffer, flags?: string[], idate?: Date): Promise<unknown>
}

/** The special folders of a mailbox, by path; null when the server has none. */
export interface ImapFolders {
  all: string | null
  archive: string | null
  trash: string | null
  sent: string | null
}

/** What a mailbox's server supports, recorded on the account at each sync. */
export interface ImapCapabilities {
  /** Gmail (X-GM-EXT-1): archive is a label change, Sent is filed by Gmail itself. */
  gmail: boolean
  /** IMAP IDLE: the server can push new mail (not used yet, see the mail README). */
  idle: boolean
  /** CONDSTORE: flag changes can be read since the last sync instead of re-read. */
  condstore: boolean
  folders: ImapFolders
}

/**
 * The special folders from a LIST answer. A server that reports SPECIAL-USE
 * flags is trusted on them alone: a folder whose name only looks like "Trash"
 * is not taken. Only when the server reports none are the well-known names the
 * client recognised used.
 */
const SPECIAL_USE_FLAGS = ["\\All", "\\Archive", "\\Trash", "\\Sent", "\\Junk", "\\Drafts"]

export function resolveImapFolders(
  listed: Array<{
    path: string
    specialUse?: string
    specialUseSource?: string
    flags?: Set<string>
  }>,
): ImapFolders {
  // A LIST read with `listOnly` (all a probe needs) carries the server's
  // SPECIAL-USE attributes as flags only; ImapFlow fills `specialUse` later in
  // the full listing. A flag the server sent is the extension's word.
  const entries = listed.map((e) => {
    if (e.specialUse || !(e.flags instanceof Set)) return e
    const flag = SPECIAL_USE_FLAGS.find((f) => e.flags?.has(f))
    return flag ? { ...e, specialUse: flag, specialUseSource: "extension" } : e
  })
  const flagged = entries.some((e) => e.specialUse && e.specialUseSource === "extension")
  const pick = (use: string): string | null => {
    const match = entries.find(
      (e) =>
        e.specialUse === use &&
        (flagged ? e.specialUseSource === "extension" : e.specialUseSource !== "user"),
    )
    return match?.path ?? null
  }
  return {
    all: pick("\\All"),
    archive: pick("\\Archive"),
    trash: pick("\\Trash"),
    sent: pick("\\Sent"),
  }
}

export async function probeImapCapabilities(client: ImapClientLike): Promise<ImapCapabilities> {
  const caps = client.capabilities
  let folders: ImapFolders = { all: null, archive: null, trash: null, sent: null }
  try {
    folders = resolveImapFolders(await client.list({ listOnly: true }))
  } catch (err) {
    log.warn({ err: (err as Error).message }, "IMAP LIST failed; special folders unknown")
  }
  return {
    gmail: caps.has("X-GM-EXT-1"),
    idle: caps.has("IDLE"),
    condstore: caps.has("CONDSTORE") || caps.has("QRESYNC"),
    folders,
  }
}

// --- UID sets -----------------------------------------------------------------

/** Compact a list of UIDs as an IMAP sequence set ("1:5,8,10:12"). */
export function compressUidSet(uids: number[]): string {
  const sorted = [...new Set(uids)]
    .filter((u) => Number.isInteger(u) && u > 0)
    .sort((a, b) => a - b)
  const parts: string[] = []
  let start = -1
  let prev = -1
  for (const uid of sorted) {
    if (start === -1) {
      start = uid
    } else if (uid !== prev + 1) {
      parts.push(start === prev ? String(start) : `${start}:${prev}`)
      start = uid
    }
    prev = uid
  }
  if (start !== -1) parts.push(start === prev ? String(start) : `${start}:${prev}`)
  return parts.join(",")
}

/** The UIDs of a sequence set written by `compressUidSet`. */
export function expandUidSet(set: string | null | undefined): number[] {
  if (!set) return []
  const out: number[] = []
  for (const part of set.split(",")) {
    const [a, b] = part.split(":").map((n) => Number(n))
    if (!Number.isInteger(a) || a <= 0) continue
    const end = Number.isInteger(b) && b >= a ? b : a
    for (let uid = a; uid <= end; uid++) out.push(uid)
  }
  return out
}

/** Above this many INBOX messages the membership is not compared each sync. */
export const IMAP_MEMBERSHIP_MAX_UIDS = 20_000
/** Without CONDSTORE, the flags of this many newest INBOX messages are read each sync. */
export const IMAP_FLAG_WINDOW = 300

/**
 * Conversations one write-back session takes (the mail app's job sends at most
 * this many per run and chains the rest), so a bulk archive stays well inside
 * the job's 60 s budget.
 */
export const IMAP_WRITE_BACK_MAX_ITEMS = 15

export interface ImapReconcileInput {
  /** The INBOX UID set the last sync saw (compressUidSet), null on the first. */
  uidSet?: string | null
  /** The INBOX HIGHESTMODSEQ the last sync saw (CONDSTORE servers). */
  modseq?: string | null
  /** Only UIDs at or below this were imported; newer ones are the fetch's job. */
  cursor?: string | null
}

export interface ImapReconcileResult {
  /** UIDs that were in the INBOX at the last sync and are not any more. */
  removedUids: number[]
  /** The INBOX UID set now, for the next sync (null when too large to track). */
  uidSet: string | null
  modseq: string | null
  /**
   * Current flags of the INBOX messages that changed since `modseq` (CONDSTORE),
   * or of the newest IMAP_FLAG_WINDOW messages otherwise (`complete: false`: the
   * caller compares them with what it saw last time).
   */
  flags: Array<{ uid: number; seen: boolean; flagged: boolean }>
  flagsAreChanges: boolean
}

/**
 * Read back the state of the INBOX (already open and locked by the caller):
 * which known messages left it, and the read and star flags that changed.
 */
export async function reconcileInbox(
  client: ImapClientLike,
  input: ImapReconcileInput,
  capabilities: ImapCapabilities,
): Promise<ImapReconcileResult> {
  const cursor = input.cursor ? Number(input.cursor) : 0
  const found = await client.search({ all: true }, { uid: true })
  const current = Array.isArray(found) ? (found as number[]).filter((u) => u <= cursor) : []
  const tracked = current.length <= IMAP_MEMBERSHIP_MAX_UIDS
  let removedUids: number[] = []
  if (tracked && input.uidSet) {
    const now = new Set(current)
    removedUids = expandUidSet(input.uidSet).filter((uid) => !now.has(uid))
  }
  const mailbox = client.mailbox as { highestModseq?: bigint } | undefined
  const modseqNow = mailbox?.highestModseq !== undefined ? String(mailbox.highestModseq) : null

  const flags: ImapReconcileResult["flags"] = []
  let flagsAreChanges = false
  if (cursor > 0 && current.length > 0) {
    let range: number[] | null = null
    let changedSince: bigint | undefined
    if (capabilities.condstore && input.modseq && modseqNow) {
      if (input.modseq !== modseqNow) {
        changedSince = BigInt(input.modseq)
        range = current
        flagsAreChanges = true
      }
    } else {
      range = [...current].sort((a, b) => b - a).slice(0, IMAP_FLAG_WINDOW)
    }
    if (range && range.length > 0) {
      const options: { uid: boolean; changedSince?: bigint } = { uid: true }
      if (changedSince !== undefined) options.changedSince = changedSince
      for await (const message of client.fetch(
        compressUidSet(range),
        { uid: true, flags: true },
        options,
      )) {
        const set = message.flags instanceof Set ? message.flags : new Set<string>()
        flags.push({
          uid: Number(message.uid),
          seen: set.has("\\Seen"),
          flagged: set.has("\\Flagged"),
        })
      }
    }
  }
  return {
    removedUids,
    uidSet: tracked ? compressUidSet(current) : null,
    modseq: modseqNow,
    flags,
    flagsAreChanges,
  }
}

// --- Write-back ---------------------------------------------------------------

export interface ImapWriteBackInput {
  /** The Message-ID headers of the conversation's messages. */
  messageIds: string[]
  seen?: boolean
  flagged?: boolean
  /** Where the conversation goes: out of the INBOX, back into it, or to Trash. */
  location?: "archive" | "inbox" | "trash"
}

export interface ImapWriteBackResult {
  /** Messages found on the server. Zero: the conversation is gone there. */
  found: number
  /** The server has no Archive folder: archive stays in Liaison only. */
  archiveUnsupported: boolean
  /** The server has no Trash folder: trash stays in Liaison only. */
  trashUnsupported: boolean
}

const MESSAGE_ID_RE = /^<[^<>\s]{1,995}>$/

async function findByMessageId(client: ImapClientLike, messageIds: string[]): Promise<number[]> {
  const uids: number[] = []
  for (let i = 0; i < messageIds.length; i += 25) {
    const chunk = messageIds.slice(i, i + 25)
    const query =
      chunk.length === 1
        ? { header: { "message-id": chunk[0] } }
        : { or: chunk.map((id) => ({ header: { "message-id": id } })) }
    const result = await client.search(query, { uid: true })
    if (Array.isArray(result)) uids.push(...(result as number[]))
  }
  return [...new Set(uids)]
}

async function inFolder<T>(client: ImapClientLike, path: string, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path)
  try {
    return await fn()
  } finally {
    lock.release()
  }
}

async function applyFlags(
  client: ImapClientLike,
  uids: number[],
  input: ImapWriteBackInput,
): Promise<void> {
  if (uids.length === 0) return
  const add: string[] = []
  const remove: string[] = []
  if (input.seen === true) add.push("\\Seen")
  if (input.seen === false) remove.push("\\Seen")
  if (input.flagged === true) add.push("\\Flagged")
  if (input.flagged === false) remove.push("\\Flagged")
  if (add.length > 0) await client.messageFlagsAdd(uids, add, { uid: true })
  if (remove.length > 0) await client.messageFlagsRemove(uids, remove, { uid: true })
}

/**
 * Make the server match a conversation's state in Liaison.
 *
 * Gmail: the conversation's messages are found in All Mail; read and star are
 * flags, archive removes the `\Inbox` label (X-GM-LABELS), moving back adds it
 * (or moves the messages out of Trash), trash moves them to Trash.
 * Any other server: messages are found in INBOX, Archive and Trash (and Sent,
 * for flags); archive moves INBOX → Archive, back moves Archive / Trash → INBOX,
 * trash moves INBOX / Archive → Trash. A server without an Archive (or Trash)
 * folder keeps that change in Liaison only and says so.
 */
export async function writeBackToImap(
  client: ImapClientLike,
  capabilities: ImapCapabilities,
  input: ImapWriteBackInput,
): Promise<ImapWriteBackResult> {
  const ids = input.messageIds.filter((id) => MESSAGE_ID_RE.test(id))
  const result: ImapWriteBackResult = {
    found: 0,
    archiveUnsupported: false,
    trashUnsupported: false,
  }
  if (ids.length === 0) return result
  const { folders } = capabilities

  if (capabilities.gmail && folders.all) {
    const all = folders.all
    await inFolder(client, all, async () => {
      const uids = await findByMessageId(client, ids)
      result.found += uids.length
      if (uids.length === 0) return
      await applyFlags(client, uids, input)
      if (input.location === "archive") {
        await client.messageFlagsRemove(uids, ["\\Inbox"], { uid: true, useLabels: true })
      } else if (input.location === "inbox") {
        await client.messageFlagsAdd(uids, ["\\Inbox"], { uid: true, useLabels: true })
      } else if (input.location === "trash") {
        if (folders.trash) await client.messageMove(uids, folders.trash, { uid: true })
        else result.trashUnsupported = true
      }
    })
    // Trash is not in All Mail: a conversation brought back from Trash is moved out.
    if (folders.trash && (input.location === "inbox" || result.found === 0)) {
      const trash = folders.trash
      await inFolder(client, trash, async () => {
        const uids = await findByMessageId(client, ids)
        result.found += uids.length
        if (uids.length === 0) return
        await applyFlags(client, uids, input)
        if (input.location === "inbox") await client.messageMove(uids, "INBOX", { uid: true })
      })
    }
    return result
  }

  if (input.location === "archive" && !folders.archive) result.archiveUnsupported = true
  if (input.location === "trash" && !folders.trash) result.trashUnsupported = true

  const places: Array<{ path: string; role: "inbox" | "archive" | "trash" | "sent" }> = [
    { path: "INBOX", role: "inbox" },
  ]
  if (folders.archive) places.push({ path: folders.archive, role: "archive" })
  if (folders.trash) places.push({ path: folders.trash, role: "trash" })
  if (folders.sent) places.push({ path: folders.sent, role: "sent" })

  // Find first, then act: a message moved into a later folder of the list
  // must not be found (and counted, or moved) a second time.
  const hits: Array<{ place: (typeof places)[number]; uids: number[] }> = []
  for (const place of places) {
    const uids = await inFolder(client, place.path, () => findByMessageId(client, ids))
    if (uids.length > 0) hits.push({ place, uids })
    result.found += uids.length
  }
  for (const { place, uids } of hits) {
    await inFolder(client, place.path, async () => {
      await applyFlags(client, uids, input)
      // Sent mail stays in Sent whatever happens to the conversation.
      if (place.role === "sent") return
      let destination: string | null = null
      if (input.location === "archive" && place.role === "inbox") destination = folders.archive
      if (input.location === "inbox" && place.role !== "inbox") destination = "INBOX"
      if (input.location === "trash" && place.role !== "trash") destination = folders.trash
      if (destination) await client.messageMove(uids, destination, { uid: true })
    })
  }
  return result
}

/**
 * Mail hosts known to file every message sent through their SMTP server in
 * Sent themselves (Gmail, Outlook.com and Microsoft 365, Yahoo, AOL): an APPEND
 * there would show the message twice in the person's other clients.
 */
const SERVER_FILES_SENT_HOSTS = [
  /^imap\.(gmail|googlemail)\.com$/,
  /(^|\.)office365\.com$/,
  /^imap-mail\.outlook\.com$/,
  /(^|\.)mail\.yahoo\.com$/,
  /(^|\.)aol\.com$/,
]

export function hostFilesSentItself(imapHost: string): boolean {
  const host = imapHost.trim().toLowerCase()
  return SERVER_FILES_SENT_HOSTS.some((pattern) => pattern.test(host))
}

/**
 * How long after a send the Sent copy waits: a server that files SMTP mail
 * itself does it within seconds, so the Message-ID check made after this finds
 * its copy instead of racing it.
 */
export const SENT_COPY_DELAY_MS = 30_000

/**
 * File a copy of a message sent over SMTP in the Sent folder, unless the server
 * does it itself: Gmail files every SMTP-sent message, and a server that already
 * holds the Message-ID in Sent did too. Returns what it did.
 */
export async function appendSentCopy(
  client: ImapClientLike,
  capabilities: ImapCapabilities,
  raw: Buffer,
  messageId: string,
): Promise<"appended" | "server_files_sent" | "already_there" | "no_sent_folder"> {
  if (capabilities.gmail) return "server_files_sent"
  const sent = capabilities.folders.sent
  if (!sent) return "no_sent_folder"
  if (MESSAGE_ID_RE.test(messageId)) {
    const existing = await inFolder(client, sent, () => findByMessageId(client, [messageId]))
    if (existing.length > 0) return "already_there"
  }
  await client.append(sent, raw, ["\\Seen"], new Date())
  return "appended"
}
