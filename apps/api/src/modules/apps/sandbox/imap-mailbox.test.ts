// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  appendSentCopy,
  compressUidSet,
  expandUidSet,
  hostFilesSentItself,
  type ImapCapabilities,
  type ImapClientLike,
  probeImapCapabilities,
  reconcileInbox,
  resolveImapFolders,
  writeBackToImap,
} from "~/modules/apps/sandbox/imap-mailbox"

interface FakeMessage {
  uid: number
  messageId: string
  flags: Set<string>
  labels: Set<string>
}

/**
 * A small in-memory IMAP server: folders of messages with per-folder UIDs, the
 * subset of ImapFlow the mailbox operations use, and a log of what changed.
 */
function fakeServer(opts: {
  capabilities?: string[]
  folders: Record<string, { specialUse?: string; source?: string; messages?: FakeMessage[] }>
  highestModseq?: bigint
}) {
  const folders = new Map<
    string,
    { specialUse?: string; source?: string; messages: FakeMessage[]; next: number }
  >()
  for (const [path, f] of Object.entries(opts.folders)) {
    const messages = f.messages ?? []
    folders.set(path, {
      specialUse: f.specialUse,
      source: f.source,
      messages,
      next: Math.max(0, ...messages.map((m) => m.uid)) + 1,
    })
  }
  const log: string[] = []
  let current = "INBOX"
  const box = () => {
    const f = folders.get(current)
    if (!f) throw new Error(`no folder ${current}`)
    return f
  }
  const pick = (uids: number[]) => box().messages.filter((m) => uids.includes(m.uid))
  const matches = (m: FakeMessage, q: Record<string, any>): boolean => {
    if (q.all) return true
    if (q.header) return m.messageId === q.header["message-id"]
    if (q.or) return (q.or as Array<Record<string, any>>).some((sub) => matches(m, sub))
    return false
  }
  const client: ImapClientLike = {
    capabilities: new Map((opts.capabilities ?? []).map((c) => [c, true])),
    get mailbox() {
      return { highestModseq: opts.highestModseq }
    },
    async list() {
      return [...folders.entries()].map(([path, f]) => ({
        path,
        specialUse: f.specialUse,
        specialUseSource: f.source ?? (f.specialUse ? "extension" : undefined),
      }))
    },
    async getMailboxLock(path: string) {
      current = path
      return { release() {} }
    },
    async search(query) {
      return box()
        .messages.filter((m) => matches(m, query))
        .map((m) => m.uid)
    },
    async *fetch(range, _query, options) {
      const uids = typeof range === "string" ? expandUidSet(range) : range
      for (const m of pick(uids)) {
        if (options?.changedSince !== undefined && !m.flags.has("$changed")) continue
        yield { uid: m.uid, flags: m.flags }
      }
    },
    async messageFlagsAdd(uids, flags, options) {
      for (const m of pick(uids))
        for (const f of flags) (options?.useLabels ? m.labels : m.flags).add(f)
      log.push(
        `${current} +${options?.useLabels ? "label" : "flag"} ${flags.join(" ")} ${uids.join(",")}`,
      )
      return true
    },
    async messageFlagsRemove(uids, flags, options) {
      for (const m of pick(uids))
        for (const f of flags) (options?.useLabels ? m.labels : m.flags).delete(f)
      log.push(
        `${current} -${options?.useLabels ? "label" : "flag"} ${flags.join(" ")} ${uids.join(",")}`,
      )
      return true
    },
    async messageMove(uids, destination) {
      const from = box()
      const to = folders.get(destination)
      if (!to) throw new Error(`no folder ${destination}`)
      for (const m of pick(uids)) {
        from.messages = from.messages.filter((x) => x !== m)
        to.messages.push({ ...m, uid: to.next++ })
      }
      log.push(`move ${current} -> ${destination} ${uids.join(",")}`)
      return {}
    },
    async append(path, content, flags) {
      const f = folders.get(path)
      if (!f) throw new Error(`no folder ${path}`)
      const id = /Message-ID: (<[^>]+>)/i.exec(content.toString())?.[1] ?? "<none>"
      f.messages.push({ uid: f.next++, messageId: id, flags: new Set(flags), labels: new Set() })
      log.push(`append ${path} ${id}`)
      return {}
    },
  }
  return { client, folders, log }
}

const msg = (uid: number, id: string, flags: string[] = []): FakeMessage => ({
  uid,
  messageId: id,
  flags: new Set(flags),
  labels: new Set(),
})

const GENERIC_FOLDERS = {
  INBOX: { messages: [msg(1, "<a@x>"), msg(2, "<b@x>"), msg(3, "<other@x>")] },
  Archive: { specialUse: "\\Archive", messages: [] },
  Trash: { specialUse: "\\Trash", messages: [] },
  Sent: { specialUse: "\\Sent", messages: [msg(1, "<reply@x>", ["\\Seen"])] },
}

async function caps(client: ImapClientLike): Promise<ImapCapabilities> {
  return probeImapCapabilities(client)
}

describe("special folders", () => {
  it("trusts SPECIAL-USE flags and ignores folders that only look like one", () => {
    const folders = resolveImapFolders([
      { path: "INBOX" },
      { path: "Papierkorb", specialUse: "\\Trash", specialUseSource: "extension" },
      { path: "Trash", specialUse: "\\Trash", specialUseSource: "name" },
      { path: "Gesendet", specialUse: "\\Sent", specialUseSource: "extension" },
    ])
    expect(folders).toEqual({ all: null, archive: null, trash: "Papierkorb", sent: "Gesendet" })
  })

  it("reads the SPECIAL-USE attributes a listOnly LIST carries as flags (Gmail)", () => {
    // What ImapFlow's list({ listOnly: true }) returns for a Gmail mailbox: the
    // attributes as flags, no `specialUse` (it is filled only by a full listing).
    const folders = resolveImapFolders([
      { path: "INBOX", flags: new Set(["\\HasNoChildren"]) },
      { path: "Sent Messages", flags: new Set(["\\HasNoChildren"]) },
      { path: "[Gmail]/All Mail", flags: new Set(["\\All", "\\HasNoChildren"]) },
      { path: "[Gmail]/Sent Mail", flags: new Set(["\\HasNoChildren", "\\Sent"]) },
      { path: "[Gmail]/Trash", flags: new Set(["\\HasNoChildren", "\\Trash"]) },
    ])
    expect(folders).toEqual({
      all: "[Gmail]/All Mail",
      archive: null,
      trash: "[Gmail]/Trash",
      sent: "[Gmail]/Sent Mail",
    })
  })

  it("falls back to well-known names only when the server reports no SPECIAL-USE", () => {
    const folders = resolveImapFolders([
      { path: "INBOX" },
      { path: "Sent Items", specialUse: "\\Sent", specialUseSource: "name" },
      { path: "Deleted Items", specialUse: "\\Trash", specialUseSource: "name" },
    ])
    expect(folders).toEqual({
      all: null,
      archive: null,
      trash: "Deleted Items",
      sent: "Sent Items",
    })
  })

  it("reads Gmail, IDLE and CONDSTORE from the capabilities", async () => {
    const { client } = fakeServer({
      capabilities: ["X-GM-EXT-1", "IDLE", "CONDSTORE"],
      folders: { INBOX: {}, "[Gmail]/All Mail": { specialUse: "\\All" } },
    })
    const c = await caps(client)
    expect(c.gmail).toBe(true)
    expect(c.idle).toBe(true)
    expect(c.condstore).toBe(true)
    expect(c.folders.all).toBe("[Gmail]/All Mail")
  })
})

describe("UID sets", () => {
  it("round-trips through the compact form", () => {
    expect(compressUidSet([5, 1, 2, 3, 8, 10, 11, 3])).toBe("1:3,5,8,10:11")
    expect(expandUidSet("1:3,5,8,10:11")).toEqual([1, 2, 3, 5, 8, 10, 11])
    expect(expandUidSet(null)).toEqual([])
  })
})

describe("write-back on a generic IMAP server", () => {
  it("archives by moving the conversation's INBOX messages to Archive, with its flags", async () => {
    const server = fakeServer({ folders: structuredClone(GENERIC_FOLDERS) })
    const result = await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>", "<b@x>", "<reply@x>"],
      seen: true,
      location: "archive",
    })
    expect(result).toEqual({ found: 3, archiveUnsupported: false, trashUnsupported: false })
    expect(server.folders.get("INBOX")?.messages.map((m) => m.messageId)).toEqual(["<other@x>"])
    const archived = server.folders.get("Archive")?.messages ?? []
    expect(archived.map((m) => m.messageId)).toEqual(["<a@x>", "<b@x>"])
    expect(archived.every((m) => m.flags.has("\\Seen"))).toBe(true)
    // Sent mail is flagged but never moved.
    expect(server.folders.get("Sent")?.messages.map((m) => m.messageId)).toEqual(["<reply@x>"])
  })

  it("brings a conversation back from Archive and Trash into the INBOX", async () => {
    const server = fakeServer({
      folders: {
        ...structuredClone(GENERIC_FOLDERS),
        INBOX: { messages: [] },
        Archive: { specialUse: "\\Archive", messages: [msg(7, "<a@x>")] },
        Trash: { specialUse: "\\Trash", messages: [msg(4, "<b@x>")] },
      },
    })
    await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>", "<b@x>"],
      location: "inbox",
    })
    expect(
      server.folders
        .get("INBOX")
        ?.messages.map((m) => m.messageId)
        .sort(),
    ).toEqual(["<a@x>", "<b@x>"])
  })

  it("trashes, stars and un-reads", async () => {
    const server = fakeServer({ folders: structuredClone(GENERIC_FOLDERS) })
    await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>"],
      seen: false,
      flagged: true,
      location: "trash",
    })
    const trashed = server.folders.get("Trash")?.messages ?? []
    expect(trashed.map((m) => m.messageId)).toEqual(["<a@x>"])
    expect(trashed[0]?.flags.has("\\Flagged")).toBe(true)
    expect(trashed[0]?.flags.has("\\Seen")).toBe(false)
  })

  it("keeps archive local when the server has no Archive folder, and says so", async () => {
    const { Archive: _none, ...noArchive } = structuredClone(GENERIC_FOLDERS)
    const server = fakeServer({ folders: noArchive })
    const result = await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>"],
      location: "archive",
    })
    expect(result.archiveUnsupported).toBe(true)
    expect(server.folders.get("INBOX")?.messages.map((m) => m.messageId)).toContain("<a@x>")
    expect(server.log.filter((l) => l.startsWith("move"))).toEqual([])
  })

  it("reports a conversation the server no longer has", async () => {
    const server = fakeServer({ folders: structuredClone(GENERIC_FOLDERS) })
    const result = await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<gone@x>", "not-a-message-id"],
      seen: true,
    })
    expect(result.found).toBe(0)
    expect(server.log).toEqual([])
  })
})

describe("write-back on Gmail", () => {
  const gmail = () =>
    fakeServer({
      capabilities: ["X-GM-EXT-1"],
      folders: {
        INBOX: { messages: [] },
        "[Gmail]/All Mail": {
          specialUse: "\\All",
          messages: [msg(10, "<a@x>"), msg(11, "<b@x>")],
        },
        "[Gmail]/Trash": { specialUse: "\\Trash", messages: [msg(3, "<t@x>")] },
        "[Gmail]/Sent Mail": { specialUse: "\\Sent", messages: [] },
      },
    })

  it("archives by removing the \\Inbox label in All Mail", async () => {
    const server = gmail()
    await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>", "<b@x>"],
      location: "archive",
      flagged: true,
    })
    expect(server.log).toEqual([
      "[Gmail]/All Mail +flag \\Flagged 10,11",
      "[Gmail]/All Mail -label \\Inbox 10,11",
    ])
  })

  it("moves back to the inbox with the label, and out of Trash", async () => {
    const server = gmail()
    await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>", "<t@x>"],
      location: "inbox",
    })
    expect(server.log).toEqual([
      "[Gmail]/All Mail +label \\Inbox 10",
      "move [Gmail]/Trash -> INBOX 3",
    ])
  })

  it("trashes by moving to Trash", async () => {
    const server = gmail()
    await writeBackToImap(server.client, await caps(server.client), {
      messageIds: ["<a@x>"],
      location: "trash",
    })
    expect(server.log).toEqual(["move [Gmail]/All Mail -> [Gmail]/Trash 10"])
  })
})

describe("reading the INBOX state back", () => {
  it("reports the known messages that left the INBOX and records the set", async () => {
    const server = fakeServer({
      folders: { INBOX: { messages: [msg(1, "<a@x>"), msg(4, "<d@x>")] } },
    })
    const c = await caps(server.client)
    await server.client.getMailboxLock("INBOX")
    const first = await reconcileInbox(server.client, { uidSet: null, cursor: "4" }, c)
    expect(first.removedUids).toEqual([])
    expect(first.uidSet).toBe("1,4")
    const next = await reconcileInbox(server.client, { uidSet: "1:4", cursor: "4" }, c)
    expect(next.removedUids).toEqual([2, 3])
    // Without CONDSTORE the newest messages' flags are read for comparison.
    expect(next.flagsAreChanges).toBe(false)
    expect(next.flags.map((f) => f.uid).sort()).toEqual([1, 4])
  })

  it("UIDs above the cursor are the fetch's, not the read-back's", async () => {
    const server = fakeServer({
      folders: { INBOX: { messages: [msg(1, "<a@x>"), msg(9, "<n@x>")] } },
    })
    await server.client.getMailboxLock("INBOX")
    const result = await reconcileInbox(
      server.client,
      { uidSet: "1", cursor: "1" },
      await caps(server.client),
    )
    expect(result.uidSet).toBe("1")
    expect(result.flags.map((f) => f.uid)).toEqual([1])
  })

  it("with CONDSTORE reads only what changed since the last modseq", async () => {
    const server = fakeServer({
      capabilities: ["CONDSTORE"],
      highestModseq: 42n,
      folders: {
        INBOX: { messages: [msg(1, "<a@x>", ["\\Seen", "$changed"]), msg(2, "<b@x>")] },
      },
    })
    await server.client.getMailboxLock("INBOX")
    const c = await caps(server.client)
    const unchanged = await reconcileInbox(
      server.client,
      { uidSet: "1:2", modseq: "42", cursor: "2" },
      c,
    )
    expect(unchanged.flags).toEqual([])
    const changed = await reconcileInbox(
      server.client,
      { uidSet: "1:2", modseq: "40", cursor: "2" },
      c,
    )
    expect(changed.flagsAreChanges).toBe(true)
    expect(changed.flags).toEqual([{ uid: 1, seen: true, flagged: false }])
    expect(changed.modseq).toBe("42")
  })
})

describe("the Sent copy of an SMTP send", () => {
  const raw = Buffer.from("Message-ID: <s@x>\r\nSubject: hi\r\n\r\nbody")

  it("is appended to Sent on a server that does not file it", async () => {
    const server = fakeServer({ folders: structuredClone(GENERIC_FOLDERS) })
    expect(await appendSentCopy(server.client, await caps(server.client), raw, "<s@x>")).toBe(
      "appended",
    )
    const copy = server.folders.get("Sent")?.messages.find((m) => m.messageId === "<s@x>")
    expect(copy?.flags.has("\\Seen")).toBe(true)
  })

  it("is not appended on Gmail, nor when Sent already holds it", async () => {
    const gmail = fakeServer({
      capabilities: ["X-GM-EXT-1"],
      folders: { INBOX: {}, "[Gmail]/Sent Mail": { specialUse: "\\Sent" } },
    })
    expect(await appendSentCopy(gmail.client, await caps(gmail.client), raw, "<s@x>")).toBe(
      "server_files_sent",
    )
    const filed = fakeServer({
      folders: {
        ...structuredClone(GENERIC_FOLDERS),
        Sent: { specialUse: "\\Sent", messages: [msg(1, "<s@x>")] },
      },
    })
    expect(await appendSentCopy(filed.client, await caps(filed.client), raw, "<s@x>")).toBe(
      "already_there",
    )
    expect(filed.log).toEqual([])
  })
})

describe("hostFilesSentItself", () => {
  it("knows the hosts that file SMTP-sent mail in Sent themselves", () => {
    for (const host of [
      "imap.gmail.com",
      "outlook.office365.com",
      "imap-mail.outlook.com",
      "imap.mail.yahoo.com",
      "imap.aol.com",
    ]) {
      expect(hostFilesSentItself(host)).toBe(true)
    }
    for (const host of ["imap.fastmail.com", "mail.example.test", "imap.mail.me.com"]) {
      expect(hostFilesSentItself(host)).toBe(false)
    }
  })
})
