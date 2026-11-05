// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { executeInSandbox } from "~/apps/mail/test-page-write-bridge"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"

// An IMAP mailbox's sync beyond new INBOX mail: the Sent folder joins the
// conversations, a message moved back into the INBOX elsewhere reopens its
// conversation instead of being imported twice, and what another client
// changed (read, starred, archived) reaches Liaison. The IMAP server is the
// bridge's `imap_fetch`; the rows live in an in-memory world.

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
type Row = Record<string, any>

const CAPS = {
  gmail: false,
  idle: true,
  condstore: false,
  folders: { all: null, archive: "Archive", trash: "Trash", sent: "Sent" },
}

function makeWorld(account: Row) {
  const tables: Record<string, Map<string, Row>> = {
    accounts: new Map([[account.id, account]]),
    conversations: new Map(),
    messages: new Map(),
  }
  let seq = 0
  const jobs: Array<{ name: string; payload: any; opts: any }> = []
  const fetches: any[] = []
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (value !== null && typeof value === "object") return true
      const actual = row[snake(key)]
      return value === null ? actual === null || actual === undefined : actual === value
    })
  const bridgeFor = (imapFetch: (opts: any) => any): Row => ({
    getUserId: () => "system:mail:sync",
    getOrgId: () => "org-1",
    db_findOne: async (entity: string, id: string) =>
      JSON.stringify(tables[entity]?.get(id) ?? null),
    db_findMany: async (entity: string, optsJson: string) => {
      const opts = JSON.parse(optsJson)
      const rows = [...(tables[entity]?.values() ?? [])].filter((r) => matches(r, opts.where ?? {}))
      if (entity === "messages") rows.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
      return JSON.stringify(rows)
    },
    db_insert: async (entity: string, dataJson: string) => {
      const row: Row = { id: `${entity}-${++seq}` }
      for (const [k, v] of Object.entries(JSON.parse(dataJson))) row[snake(k)] = v
      tables[entity]?.set(row.id, row)
      return JSON.stringify(row)
    },
    db_update: async (entity: string, id: string, dataJson: string) => {
      const row = tables[entity]?.get(id)
      if (row) for (const [k, v] of Object.entries(JSON.parse(dataJson))) row[snake(k)] = v
    },
    db_updateMany: async (entity: string, optsJson: string) => {
      const { where, data } = JSON.parse(optsJson)
      let count = 0
      for (const row of tables[entity]?.values() ?? []) {
        if (!matches(row, where)) continue
        for (const [k, v] of Object.entries(data)) row[snake(k)] = v
        count++
      }
      return JSON.stringify({ count })
    },
    db_delete: async () => {},
    db_count: async () => "0",
    emit: async () => {},
    enqueueJob: async (name: string, payload: string, opts?: string) => {
      jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
    },
    imap_fetch: async (_c: string, _id: string, optsJson: string) => {
      const opts = JSON.parse(optsJson)
      fetches.push(opts)
      return JSON.stringify(imapFetch(opts))
    },
    mail_completeIngest: async () => "{}",
    resolveContact: async () => JSON.stringify({ id: "c1" }),
    hasOnlineUsers: async () => "true",
    hasScope: async () => true,
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    log_debug: () => {},
  })
  return { tables, jobs, fetches, bridgeFor, account: () => tables.accounts.get(account.id) as Row }
}

function inbound(uid: number, id: string, extra: Row = {}): Row {
  return {
    externalMessageId: id,
    externalProviderId: String(uid),
    externalThreadId: id,
    from: { email: "customer@example.test" },
    to: [{ email: "support@example.test" }],
    cc: [],
    bcc: [],
    subject: "Question",
    textBody: "body",
    htmlBody: "",
    snippet: "body",
    headers: {},
    inReplyTo: null,
    references: [],
    labels: ["UNREAD", "INBOX"],
    isRead: false,
    isStarred: false,
    sentAt: "2026-10-01T10:00:00.000Z",
    ...extra,
  }
}

function sentReply(uid: number, id: string, root: string): Row {
  return inbound(uid, id, {
    externalProviderId: `sent:${uid}`,
    externalThreadId: root,
    from: { email: "support@example.test" },
    to: [{ email: "customer@example.test" }],
    inReplyTo: root,
    references: [root],
    labels: ["SENT"],
    isRead: true,
    sentAt: "2026-10-01T11:00:00.000Z",
  })
}

// A last page; for a newest-first walk the folder's top UID is `cursor` too.
const page = (messages: Row[], cursor: string | null, extra: Row = {}) => ({
  messages,
  nextCursor: null,
  cursor,
  highest: cursor,
  nextBefore: null,
  done: true,
  uidValidity: 7,
  capabilities: CAPS,
  ...extra,
})

const ACCOUNT: Row = {
  id: "acc-1",
  owner_type: "org",
  owner_id: null,
  encryption_state: "none",
  provider: "imap",
  email_address: "support@example.test",
  sync_status: "pre-sync",
  sync_state: null,
  disconnected_at: null,
}

describe("IMAP sync: Sent folder and INBOX read-back", () => {
  let bundleSource: string
  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })
  const run = (
    exportName: string,
    bridge: Row,
    params: Row = { orgId: "org-1", accountId: "acc-1" },
  ) =>
    executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName,
      params,
      bridge,
      timeoutMs: 20000,
    })

  it("the first sync imports the INBOX, then Sent into the same conversation", async () => {
    const w = makeWorld({ ...ACCOUNT })
    const bridge = w.bridgeFor((opts) =>
      opts.folder === "sent"
        ? page([sentReply(1, "<reply@x>", "<q@x>")], "1")
        : page([inbound(1, "<q@x>")], "1"),
    )
    // The INBOX (the first import), then Sent: the incremental sync's, newest
    // first, once the INBOX is in.
    await run("imapInitialSync", bridge)
    expect(w.account().sync_status).toBe("active")
    expect(w.jobs).toEqual([])
    await run("imapIncrementalSync", bridge)

    expect(w.fetches.map((f) => f.folder ?? "inbox")).toEqual(["inbox", "inbox", "sent"])
    const messages = [...w.tables.messages.values()]
    expect(messages.map((m) => [m.external_message_id, m.direction])).toEqual([
      ["<q@x>", "inbound"],
      ["<reply@x>", "outbound"],
    ])
    expect(new Set(messages.map((m) => m.conversation_id)).size).toBe(1)
    const account = w.account()
    expect(account.sync_status).toBe("active")
    expect(account.sync_state.inboxDone).toBe(true)
    expect(account.sync_state.sent).toMatchObject({ cursor: "1", done: true })
    expect(account.sync_state.capabilities).toEqual(CAPS)
  })

  it("mail sent from Liaison is not imported a second time from Sent", async () => {
    const w = makeWorld({
      ...ACCOUNT,
      sync_status: "active",
      sync_state: {
        cursor: "1",
        uidValidity: 7,
        inboxDone: true,
        capabilities: CAPS,
        sent: { cursor: "0", done: true, uidValidity: 7 },
      },
    })
    w.tables.messages.set("m-sent", {
      id: "m-sent",
      account_id: "acc-1",
      conversation_id: "conv-x",
      external_message_id: "<liaison@x>",
      external_provider_id: "<liaison@x>",
      direction: "outbound",
      labels: ["SENT"],
    })
    const bridge = w.bridgeFor((opts) =>
      opts.folder === "sent" ? page([sentReply(1, "<liaison@x>", "<q@x>")], "1") : page([], "1"),
    )
    await run("imapIncrementalSync", bridge)
    expect(
      [...w.tables.messages.values()].filter((m) => m.external_message_id === "<liaison@x>"),
    ).toHaveLength(1)
    expect(w.account().sync_state.sent.cursor).toBe("1")
  })

  it("what another client changed reaches Liaison: archived, read, starred", async () => {
    const w = makeWorld({ ...ACCOUNT })
    let inboxNow = [inbound(1, "<a@x>"), inbound(2, "<b@x>")]
    let reconcile: Row | undefined
    const bridge = w.bridgeFor((opts) => {
      if (opts.folder === "sent") return page([], null)
      const after = opts.cursor ? Number(opts.cursor) : 0
      return page(
        inboxNow.filter((m) => Number(m.externalProviderId) > after),
        "2",
        reconcile ? { reconcile } : {},
      )
    })
    await run("imapInitialSync", bridge)
    const convOf = (id: string) =>
      w.tables.conversations.get(
        [...w.tables.messages.values()].find((m) => m.external_message_id === id)?.conversation_id,
      ) as Row
    expect(convOf("<a@x>").status).toBe("open")

    // First read-back only records the flags it sees.
    reconcile = {
      removedUids: [],
      uidSet: "1:2",
      modseq: null,
      flags: [
        { uid: 1, seen: false, flagged: false },
        { uid: 2, seen: false, flagged: false },
      ],
      flagsAreChanges: false,
    }
    await run("imapIncrementalSync", bridge)
    expect(w.account().sync_state.inboxUids).toBe("1:2")
    expect(w.account().sync_state.flagSnapshot).toEqual({ "1": "00", "2": "00" })

    // Elsewhere: <a@x> archived, <b@x> read and starred.
    inboxNow = [inboxNow[1] as Row]
    reconcile = {
      removedUids: [1],
      uidSet: "2",
      modseq: null,
      flags: [{ uid: 2, seen: true, flagged: true }],
      flagsAreChanges: false,
    }
    await run("imapIncrementalSync", bridge)
    expect(convOf("<a@x>").status).toBe("archived")
    const b = [...w.tables.messages.values()].find((m) => m.external_message_id === "<b@x>") as Row
    expect(b.is_read).toBe(true)
    expect(b.is_starred).toBe(true)
    expect(convOf("<b@x>").is_read).toBe(true)
    expect(convOf("<b@x>").is_starred).toBe(true)
    expect(convOf("<b@x>").status).toBe("open")
  })

  it("a message moved back into the INBOX reopens its conversation instead of importing it again", async () => {
    const w = makeWorld({
      ...ACCOUNT,
      sync_status: "active",
      sync_state: {
        cursor: "3",
        uidValidity: 7,
        inboxDone: true,
        capabilities: CAPS,
        sent: { done: true, cursor: null, uidValidity: 7 },
      },
    })
    w.tables.conversations.set("conv-1", {
      id: "conv-1",
      account_id: "acc-1",
      external_thread_id: "<a@x>",
      status: "archived",
      labels: [],
    })
    w.tables.messages.set("m-1", {
      id: "m-1",
      account_id: "acc-1",
      conversation_id: "conv-1",
      external_message_id: "<a@x>",
      external_provider_id: "3",
      direction: "inbound",
      labels: [],
      is_read: true,
      sent_at: "2026-10-01T10:00:00.000Z",
    })
    const bridge = w.bridgeFor((opts) =>
      opts.folder === "sent" ? page([], null) : page([inbound(9, "<a@x>")], "9"),
    )
    await run("imapIncrementalSync", bridge)
    expect(w.tables.messages.size).toBe(1)
    expect(w.tables.messages.get("m-1")).toMatchObject({
      external_provider_id: "9",
      labels: ["INBOX"],
    })
    expect(w.tables.conversations.get("conv-1")?.status).toBe("open")
  })

  it("a mailbox imported before Sent was synced walks Sent newest first, staying active", async () => {
    const w = makeWorld({
      ...ACCOUNT,
      sync_status: "active",
      sync_state: { cursor: "5", uidValidity: 7, messagesSynced: 5 },
    })
    const bridge = w.bridgeFor((opts) =>
      opts.folder === "sent"
        ? page([], opts.before ? null : "40", { done: false, nextBefore: "25" })
        : page([], "5"),
    )
    await run("imapIncrementalSync", bridge)
    // The INBOX catch-up, then the first Sent page in the same run, newest first.
    expect(w.fetches.map((f) => [f.folder ?? "inbox", f.order, f.before ?? null])).toEqual([
      ["inbox", "newest", null],
      ["sent", "newest", null],
    ])
    expect(w.account().sync_status).toBe("active")
    expect(w.account().sync_state.inboxDone).toBe(true)
    expect(w.account().sync_state.sent).toMatchObject({
      cursor: "40",
      before: "25",
      walk: true,
      done: false,
    })
    // The rest of Sent is a paced chain of the incremental sync.
    expect(w.jobs.map((j) => [j.name, j.payload.chain])).toEqual([["imap-incremental-sync", true]])

    w.fetches.length = 0
    await run("imapIncrementalSync", bridge, { orgId: "org-1", accountId: "acc-1", chain: true })
    expect(w.fetches.at(-1)).toMatchObject({ folder: "sent", order: "newest", before: "25" })
    expect(w.account().sync_state.sent).toMatchObject({ cursor: "40" })
  })

  it("a Sent folder of several pages: active once the INBOX is in, Sent carries on newest first", async () => {
    const w = makeWorld({ ...ACCOUNT })
    const bridge = w.bridgeFor((opts) => {
      if (opts.folder !== "sent") return page([inbound(1, "<q@x>")], "1")
      // Newest first. Page 1: the reply to the INBOX thread. Page 2: an old
      // thread whose inbound half left the INBOX before the mailbox was connected.
      return opts.before
        ? page([sentReply(1, "<old-reply@x>", "<old@x>")], null)
        : page([sentReply(30, "<reply@x>", "<q@x>")], "30", { done: false, nextBefore: "30" })
    })
    await run("imapInitialSync", bridge)
    expect(w.account().sync_status).toBe("active")
    expect(w.account().sync_state.inboxDone).toBe(true)
    expect(w.jobs).toEqual([])

    w.fetches.length = 0
    await run("imapIncrementalSync", bridge)
    expect(w.fetches.map((f) => f.folder ?? "inbox")).toEqual(["inbox", "sent"])
    expect(w.account().sync_state.sent).toMatchObject({ cursor: "30", before: "30", done: false })

    w.fetches.length = 0
    await run("imapIncrementalSync", bridge, { orgId: "org-1", accountId: "acc-1", chain: true })
    expect(w.fetches.map((f) => [f.folder ?? "inbox", f.before ?? null])).toEqual([
      ["inbox", null],
      ["sent", "30"],
    ])
    expect(w.account().sync_status).toBe("active")
    expect(w.account().sync_state.sent).toMatchObject({ cursor: "30", done: true })

    const statusOf = (id: string) =>
      w.tables.conversations.get(
        [...w.tables.messages.values()].find((m) => m.external_message_id === id)?.conversation_id,
      )?.status
    // The reply joins its open INBOX conversation; the outbound-only thread is history.
    expect(statusOf("<reply@x>")).toBe("open")
    expect(statusOf("<old-reply@x>")).toBe("archived")
  })

  it("a conversation trashed in Liaison stays trashed when the server reports a change", async () => {
    const w = makeWorld({
      ...ACCOUNT,
      sync_status: "active",
      sync_state: {
        cursor: "3",
        uidValidity: 7,
        inboxDone: true,
        capabilities: CAPS,
        inboxUids: "3",
        flagSnapshot: { "3": "00" },
        sent: { done: true, cursor: null, uidValidity: 7 },
      },
    })
    w.tables.conversations.set("conv-1", {
      id: "conv-1",
      account_id: "acc-1",
      external_thread_id: "<a@x>",
      status: "trashed",
      labels: ["INBOX", "UNREAD"],
    })
    w.tables.messages.set("m-1", {
      id: "m-1",
      account_id: "acc-1",
      conversation_id: "conv-1",
      external_message_id: "<a@x>",
      external_provider_id: "3",
      direction: "inbound",
      // The write-back has not confirmed the move yet: no TRASH label.
      labels: ["INBOX", "UNREAD"],
      is_read: false,
      sent_at: "2026-10-01T10:00:00.000Z",
    })
    const bridge = w.bridgeFor((opts) =>
      opts.folder === "sent"
        ? page([], null)
        : page([], "3", {
            reconcile: {
              removedUids: [],
              uidSet: "3",
              modseq: null,
              flags: [{ uid: 3, seen: true, flagged: false }],
              flagsAreChanges: false,
            },
          }),
    )
    await run("imapIncrementalSync", bridge)
    expect(w.tables.messages.get("m-1")?.is_read).toBe(true)
    expect(w.tables.conversations.get("conv-1")?.status).toBe("trashed")
  })

  it("a UIDVALIDITY change forgets the stored UIDs and re-walks the mailbox", async () => {
    const w = makeWorld({
      ...ACCOUNT,
      sync_status: "active",
      sync_state: { cursor: "3", uidValidity: 7, inboxDone: true, capabilities: CAPS },
    })
    w.tables.messages.set("m-1", {
      id: "m-1",
      account_id: "acc-1",
      conversation_id: "conv-1",
      external_message_id: "<a@x>",
      external_provider_id: "3",
      direction: "inbound",
      labels: [],
    })
    const bridge = w.bridgeFor(() => page([], "1", { uidValidity: 8 }))
    await run("imapIncrementalSync", bridge)
    expect(w.tables.messages.get("m-1")?.external_provider_id).toBeNull()
    expect(w.account().sync_state).toEqual({})
    expect(w.jobs.map((j) => j.name)).toEqual(["imap-initial-sync"])
  })
})
