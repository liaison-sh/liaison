// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { runMail } from "~/apps/mail/test-page-write-bridge"
import { fakeImapServer } from "~/modules/apps/sandbox/__test-helpers__/fake-imap-server"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { ImapBridgeTestAccess } from "~/modules/apps/sandbox/imap-bridge"

/**
 * A synthetic stand-in for the host's `mailbox_sealAndInsert`, for the sync
 * tests whose subject is paging, pacing and dedup rather than encryption.
 *
 * It mimics the real contract: the plaintext never reaches the row, and the
 * caller gets back key material plus one ciphertext column per sealed field.
 * It deliberately produces FAKE ciphertext, so nothing here can be mistaken for
 * a test of the crypto. The real bridge, against a real enrolled identity, is
 * exercised by T-INT-1 in `src/tests/integration/mail-sync.test.ts`.
 */
async function stubSealAndInsert(bridge: Record<string, any>, paramsJson: string): Promise<string> {
  const params = JSON.parse(paramsJson)
  // Record the plaintext the caller HANDED to the seal, under `data`, so a test
  // asserting "the right subject reached the writer" still can. The row itself
  // never carries it, which is the point of the whole phase.
  const inserted = JSON.parse(
    await bridge.db_insert(
      params.entity,
      JSON.stringify({ ...params.row, __sealedPlaintext: params.plaintext ?? {} }),
    ),
  )
  delete inserted.__sealedPlaintext
  const sealed: Record<string, string> = {}
  for (const [field, value] of Object.entries(params.plaintext ?? {})) {
    if (typeof value !== "string" || value === "") continue
    const column = `${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_ciphertext`
    sealed[column] = Buffer.from(`sealed:${value}`).toString("base64")
  }
  return JSON.stringify({
    ...inserted,
    subject: null,
    text_body: null,
    html_body: null,
    snippet: null,
    ...sealed,
    content_key_wrapped: Buffer.from("wrapped").toString("base64"),
    content_key_epk: Buffer.from("epk").toString("base64"),
    enc_key_id: 1,
    enc_version: 1,
  })
}

describe("imapInitialSync handler", () => {
  it("syncs messages via imap_fetch and sets status to active", async () => {
    const updates: any[] = []
    const inserts: any[] = []
    let imapFetchCalls = 0

    const bridge: Record<string, any> = {
      getUserId: () => "system:mail:imapInitialSync",
      getOrgId: () => "org-1",
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-1",
          owner_type: "user",
          // Enrolled personal mailbox. Sync is suspended for a personal account
          // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
          // must say which side of that line it is on.
          encryption_state: "ready",
          owner_id: "user-1",
          provider: "imap",
          email_address: "user@imap.test",
          sync_status: "pre-sync",
          sync_state: null,
          disconnected_at: null,
        }),
      db_findMany: async () => JSON.stringify([]),
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (entity: string, dataJson: string) => {
        inserts.push({ entity, data: JSON.parse(dataJson) })
        return JSON.stringify({ id: `gen-${inserts.length}`, ...JSON.parse(dataJson) })
      },
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (paramsJson: string) =>
        JSON.stringify({ id: "c1", email: JSON.parse(paramsJson).email }),
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => {
        imapFetchCalls++
        if (imapFetchCalls === 1) {
          return JSON.stringify({
            messages: [
              {
                externalMessageId: "<imap1@test.com>",
                externalProviderId: "1",
                externalThreadId: "<imap1@test.com>",
                from: { email: "sender@test.com" },
                to: [{ email: "user@imap.test" }],
                cc: [],
                bcc: [],
                subject: "IMAP Test",
                textBody: "IMAP body",
                htmlBody: "",
                snippet: "IMAP body",
                headers: {},
                inReplyTo: null,
                references: [],
                labels: ["INBOX"],
                isRead: false,
                isStarred: false,
                sentAt: "2026-01-15T10:00:00Z",
              },
            ],
            nextCursor: null,
            done: true,
            uidValidity: 12345,
          })
        }
        return JSON.stringify({ messages: [], done: true, uidValidity: 12345 })
      },
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await runMail({
      exportName: "imapInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 15000,
    })

    expect(updates.some((update) => update.data.syncStatus === "active")).toBe(true)
    expect(inserts.some((insert) => insert.entity === "conversations")).toBe(true)
    expect(inserts.some((insert) => insert.entity === "messages")).toBe(true)
  })
})

describe("imapIncrementalSync handler", () => {
  it("detects uidValidity change and triggers full re-sync", async () => {
    const jobs: any[] = []
    const updates: any[] = []

    const bridge: Record<string, any> = {
      getUserId: () => "system:mail:imapIncrementalSync",
      getOrgId: () => "org-1",
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-1",
          owner_type: "user",
          // Enrolled personal mailbox. Sync is suspended for a personal account
          // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
          // must say which side of that line it is on.
          encryption_state: "ready",
          owner_id: "user-1",
          provider: "imap",
          email_address: "user@imap.test",
          sync_status: "active",
          disconnected_at: null,
          sync_state: { cursor: "50", uidValidity: 12345, messagesSynced: 50 },
          last_sync_at: "2026-01-01T00:00:00Z",
        }),
      db_findMany: async () => JSON.stringify([]),
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_entity: string, dataJson: string) =>
        JSON.stringify({ id: "x", ...JSON.parse(dataJson) }),
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 99999 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await runMail({
      exportName: "imapIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 10000,
    })

    expect(jobs.some((job) => job.name === "imap-initial-sync")).toBe(true)
    expect(updates.some((update) => update.data.syncState && !update.data.syncState.cursor)).toBe(
      true,
    )
  })
})

// The first sync of a new IMAP mailbox, through the REAL bridge `imap_fetch`.
// The handler starts with no cursor and sends `cursor: null` (JSON has no
// undefined); the bridge refused every first sync as "invalid options" before
// it ever connected, and the account stayed "syncing" with no error to show.
// The IMAP host here is a private address, so the bridge refuses it at host
// validation: the point is that the call gets PAST the option parsing, and
// that a failed sync leaves an error the Mail settings show.
describe("imapInitialSync through the real bridge", () => {
  it("starts without a cursor and records a failed first sync on the account", async () => {
    const previous = process.env.ALLOW_PRIVATE_MAIL_HOSTS
    process.env.ALLOW_PRIVATE_MAIL_HOSTS = "false"
    const updates: Array<{ id: string; data: Record<string, unknown> }> = []
    const emitted: unknown[] = []
    const egress = createEgressMethods({
      orgId: "00000000-0000-0000-0000-00000000a1b2",
      userId: "system:mail:imapInitialSync",
      appName: "mail",
      actorType: "system",
      egress: async () => ({ allowedDomains: [], manifest: { name: "mail" } }),
      callerScopes: [],
      inheritedActor: { actorType: "system" as const },
      manifest: { name: "mail" },
      txDb: null,
      resolveCredentials: async () => ({
        imapHost: "10.20.30.40",
        imapPort: "993",
        username: "support@northwind.test",
        password: "not-a-real-password",
      }),
    } as unknown as BridgeContext)
    const bridge: Record<string, any> = {
      getUserId: () => "system:mail:imapInitialSync",
      getOrgId: () => "org-1",
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-new",
          owner_type: "org",
          owner_id: null,
          encryption_state: "ready",
          provider: "imap",
          email_address: "support@northwind.test",
          sync_status: "pre-sync",
          sync_state: null,
          disconnected_at: null,
        }),
      db_findMany: async () => JSON.stringify([]),
      db_update: async (_entity: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      emit: async (eventJson: string) => {
        emitted.push(JSON.parse(eventJson))
      },
      enqueueJob: async () => {},
      imap_fetch: egress.imap_fetch,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }
    let thrown: unknown = null
    try {
      await runMail({
        exportName: "imapInitialSync",
        params: { orgId: "org-1", accountId: "acc-new" },
        bridge,
        timeoutMs: 15000,
      })
    } catch (err) {
      thrown = err
    } finally {
      if (previous === undefined) delete process.env.ALLOW_PRIVATE_MAIL_HOSTS
      else process.env.ALLOW_PRIVATE_MAIL_HOSTS = previous
    }

    // The call got past the option parsing; the job ends, and the account
    // says why, where the Mail settings read it, with when it is tried again.
    expect(thrown).toBeNull()
    const failed = updates.find((u) => u.data.syncStatus === "error")
    expect(failed?.id).toBe("acc-new")
    expect(String(failed?.data.lastSyncError)).toContain(
      "IMAP host must not point to a private network",
    )
    expect(String(failed?.data.lastSyncError)).not.toContain("invalid options")
    const state = (failed?.data.syncState ?? {}) as Record<string, unknown>
    expect(state.nextRetryAt).toBeString()
    expect(emitted).toContainEqual(
      expect.objectContaining({
        entity: "account",
        action: "update",
        entityId: "acc-new",
        data: expect.objectContaining({ syncStatus: "error" }),
      }),
    )
  })
})

// A mailbox account as the database holds it, updated as the handlers write it.
function mailboxRecord(initial: Record<string, any>) {
  const account: Record<string, any> = { ...initial }
  const jobs: Array<{ name: string; payload: any; opts: any }> = []
  const fetches: Array<{
    mode: string
    cursor?: unknown
    before?: unknown
    above?: unknown
    folder?: unknown
  }> = []
  const snake: Record<string, string> = {
    syncStatus: "sync_status",
    syncState: "sync_state",
    lastSyncError: "last_sync_error",
    lastSyncAt: "last_sync_at",
  }
  const bridge = (imapFetch: (opts: any) => Promise<any>): Record<string, any> => ({
    getUserId: () => "system:mail:sync",
    getOrgId: () => "org-1",
    db_findOne: async () => JSON.stringify(account),
    db_findMany: async (entity: string, optsJson: string) => {
      // No message or conversation is stored yet.
      if (entity !== "accounts") return "[]"
      const where = JSON.parse(optsJson).where ?? {}
      const match =
        (!where.provider || where.provider === account.provider) &&
        (!where.syncStatus || where.syncStatus === account.sync_status)
      return JSON.stringify(match ? [account] : [])
    },
    db_update: async (_entity: string, _id: string, dataJson: string) => {
      for (const [k, v] of Object.entries(JSON.parse(dataJson))) account[snake[k] ?? k] = v
    },
    db_updateMany: async () => JSON.stringify({ count: 0 }),
    db_insert: async (_e: string, dataJson: string) =>
      JSON.stringify({ id: crypto.randomUUID(), ...JSON.parse(dataJson) }),
    mailbox_sealAndInsert: async (paramsJson: string) =>
      JSON.stringify({ id: crypto.randomUUID(), ...JSON.parse(paramsJson).row }),
    db_delete: async () => {},
    db_count: async () => "0",
    emit: async () => {},
    enqueueJob: async (name: string, payload: string, opts?: string) => {
      jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
    },
    imap_fetch: async (_c: string, _id: string, optsJson: string) => {
      const opts = JSON.parse(optsJson)
      fetches.push(
        opts.order === "newest"
          ? {
              mode: opts.mode,
              before: opts.before ?? null,
              ...(opts.above != null ? { above: opts.above } : {}),
              ...(opts.folder ? { folder: opts.folder } : {}),
            }
          : { mode: opts.mode, cursor: opts.cursor ?? null },
      )
      return JSON.stringify(await imapFetch(opts))
    },
    resolveContact: async () => JSON.stringify({ id: "c1" }),
    hasOnlineUsers: async () => JSON.stringify(true),
    hasScope: async () => true,
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    log_debug: () => {},
  })
  return { account, jobs, fetches, bridge }
}

/**
 * The bridge's paging over a folder of `uids`, as `fetchImapPage` does it:
 * newest first below `before` (the first page also gives `highest`), or the
 * oldest above `cursor`; at most `batchSize` per page.
 */
function fakeImapBridge(uids: number[], opts: any) {
  const sorted = [...uids].sort((a, b) => a - b)
  if (opts.order === "newest") {
    const before = opts.before ? Number(opts.before) : null
    const above = opts.above ? Number(opts.above) : 0
    const below = sorted.filter((u) => u > above && (before === null || u < before))
    const page = below.slice(-opts.batchSize).reverse()
    const done = page.length === below.length
    const highest = below.length > 0 ? String(below[below.length - 1]) : null
    return {
      messages: page.map(imapMessage),
      nextCursor: null,
      cursor: before === null ? highest : null,
      nextBefore: done ? null : String(page[page.length - 1]),
      ...(before === null ? { highest } : {}),
      done,
      uidValidity: 7,
    }
  }
  const after = opts.cursor ? Number(opts.cursor) : 0
  const above = sorted.filter((u) => u > after)
  const page = above.slice(0, opts.batchSize)
  const done = page.length === above.length
  const top = Math.max(after, ...page)
  return {
    messages: page.map(imapMessage),
    nextCursor: done ? null : String(top),
    cursor: top > 0 ? String(top) : null,
    done,
    uidValidity: 7,
  }
}

function imapMessage(uid: number) {
  return {
    externalMessageId: `<uid${uid}@imap.test>`,
    externalProviderId: String(uid),
    externalThreadId: `<uid${uid}@imap.test>`,
    from: { email: "sender@test.com" },
    to: [{ email: "support@northwind.test" }],
    cc: [],
    bcc: [],
    subject: `Message ${uid}`,
    textBody: "body",
    htmlBody: "",
    snippet: "body",
    headers: {},
    inReplyTo: null,
    references: [],
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    sentAt: "2026-01-15T10:00:00Z",
  }
}

const ORG_MAILBOX = {
  id: "acc-r",
  owner_type: "org",
  owner_id: null,
  encryption_state: "ready",
  provider: "imap",
  email_address: "support@northwind.test",
  sync_status: "pre-sync",
  sync_state: null,
  disconnected_at: null,
}

const SENT_CAPS = {
  gmail: true,
  idle: true,
  condstore: true,
  folders: {
    all: "[Gmail]/All Mail",
    archive: null,
    trash: "[Gmail]/Trash",
    sent: "[Gmail]/Sent Mail",
  },
}

/**
 * A mailbox over fake folders, run through the handlers: `imported` lists the
 * provider ids of the messages stored, in the order they were stored.
 */
function mailWorld(
  account: Record<string, any>,
  folders: { inbox: number[]; sent?: number[]; caps?: unknown; failSent?: () => boolean },
) {
  const box = mailboxRecord(account)
  const imported: string[] = []
  let down: Error | null = null
  const base = box.bridge(async (opts) => {
    if (down) throw down
    if (opts.folder === "sent" && folders.failSent?.()) throw new Error("IMAP timeout")
    return {
      ...fakeImapBridge(opts.folder === "sent" ? (folders.sent ?? []) : folders.inbox, opts),
      ...(folders.caps ? { capabilities: folders.caps } : {}),
    }
  })
  const bridge = {
    ...base,
    // An org mailbox: its messages are written unsealed.
    db_insert: async (entity: string, dataJson: string) => {
      if (entity === "messages") imported.push(String(JSON.parse(dataJson).externalProviderId))
      return base.db_insert(entity, dataJson)
    },
  }
  const run = (exportName: string, params: Record<string, unknown>) =>
    runMail({
      exportName,
      params,
      bridge,
      timeoutMs: 15000,
    })
  return {
    ...box,
    imported,
    run,
    initial: () => run("imapInitialSync", { orgId: "org-1", accountId: "acc-r" }),
    tick: () => run("imapIncrementalSync", { orgId: "org-1" }),
    syncNow: () => run("imapIncrementalSync", { orgId: "org-1", accountId: "acc-r" }),
    chain: () => run("imapIncrementalSync", { orgId: "org-1", accountId: "acc-r", chain: true }),
    setDown: (err: Error | null) => {
      down = err
    },
  }
}

const desc = (from: number, to: number) => {
  const out: string[] = []
  for (let uid = from; uid >= to; uid--) out.push(String(uid))
  return out
}

describe("IMAP mail syncs MOST RECENT FIRST, on every path", () => {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)

  it("first import: newest page first, new mail caught up first on each later run, finalized in one write", async () => {
    const inbox = range(1, 60)
    const w = mailWorld(ORG_MAILBOX, { inbox })

    await w.initial()
    expect(w.fetches).toEqual([{ mode: "full", before: null }])
    expect(w.imported).toEqual(desc(60, 36))
    expect(w.account.sync_status).toBe("syncing")
    expect(w.account.sync_state.cursor).toBe("60")
    expect(w.account.sync_state.inboxWalk).toEqual({ before: "36" })
    expect(w.jobs.at(-1)).toMatchObject({
      name: "imap-initial-sync",
      opts: { jobId: "imap-initial-sync:acc-r:36" },
    })

    // While the walk runs, the schedule's tick leaves the mailbox to it, and
    // "Sync now" does not start a second writer.
    w.fetches.length = 0
    w.jobs.length = 0
    await w.tick()
    await w.syncNow()
    expect(w.fetches).toEqual([])
    expect(w.jobs).toEqual([])

    // Run 2: new mail first (none), then the walk page below.
    await w.initial()
    expect(w.fetches).toEqual([
      { mode: "incremental", before: null, above: "60" },
      { mode: "full", before: "36" },
    ])
    expect(w.imported).toEqual(desc(60, 11))

    // Mail arrives: run 3 stores it BEFORE the last walk page.
    inbox.push(61, 62)
    w.fetches.length = 0
    await w.initial()
    expect(w.imported).toEqual([...desc(60, 11), "62", "61", ...desc(10, 1)])
    // Finalized in the same write as the last page.
    expect(w.account.sync_status).toBe("active")
    expect(w.account.sync_state.inboxDone).toBe(true)
    expect(w.account.sync_state.inboxWalk).toBeUndefined()
    expect(w.account.sync_state.cursor).toBe("62")
  })

  it("catch-up after a gap: the newest page first, then the gap filled backwards; the tick leaves a running chain alone", async () => {
    const inbox = range(1, 100)
    const w = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "active",
        sync_state: { cursor: "100", uidValidity: 7, inboxDone: true },
      },
      { inbox },
    )
    // Downtime: 60 messages arrived.
    inbox.push(...range(101, 160))

    await w.tick()
    expect(w.fetches).toEqual([{ mode: "incremental", before: null, above: "100" }])
    expect(w.imported).toEqual(desc(160, 136))
    expect(w.account.sync_state.cursor).toBe("160")
    expect(w.account.sync_state.gaps).toEqual([{ above: "100", before: "136" }])
    const hop = w.jobs.at(-1)
    expect(hop?.payload).toEqual({ orgId: "org-1", accountId: "acc-r", chain: true })

    // The chain is the writer: the tick skips the mailbox meanwhile.
    w.fetches.length = 0
    await w.tick()
    expect(w.fetches).toEqual([])

    await w.chain()
    await w.chain()
    expect(w.imported).toEqual(desc(160, 101))
    expect(w.account.sync_state.gaps).toBeUndefined()
    expect(w.account.sync_state.cursor).toBe("160")
  })

  it("Sent: walked newest first once the INBOX is in, then caught up newest first", async () => {
    const sent = range(1, 30)
    const w = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "active",
        sync_state: { cursor: "5", uidValidity: 7, inboxDone: true },
      },
      { inbox: range(1, 5), sent, caps: SENT_CAPS },
    )
    await w.tick()
    expect(w.fetches).toEqual([
      { mode: "incremental", before: null, above: "5" },
      { mode: "full", before: null, folder: "sent" },
    ])
    expect(w.imported).toEqual(desc(30, 6))
    expect(w.account.sync_state.sent).toMatchObject({ cursor: "30", before: "6", done: false })

    w.fetches.length = 0
    await w.chain()
    expect(w.fetches.at(-1)).toEqual({ mode: "full", before: "6", folder: "sent" })
    expect(w.account.sync_state.sent).toMatchObject({ cursor: "30", done: true })

    // New sent mail: newest first above the Sent cursor.
    sent.push(31, 32)
    w.fetches.length = 0
    await w.tick()
    expect(w.fetches.at(-1)).toEqual({
      mode: "incremental",
      before: null,
      above: "30",
      folder: "sent",
    })
    expect(w.imported.slice(-2)).toEqual(["32", "31"])
    expect(w.account.sync_state.sent.cursor).toBe("32")
  })

  it("a Sent folder that fails backs off on its own and never holds the INBOX", async () => {
    const inbox = range(1, 5)
    let sentFails = true
    const w = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "active",
        sync_state: { cursor: "5", uidValidity: 7, inboxDone: true },
      },
      { inbox, sent: [1], caps: SENT_CAPS, failSent: () => sentFails },
    )
    await w.tick()
    expect(w.account.sync_state.sent.failedAttempts).toBe(1)
    expect(Date.parse(w.account.sync_state.sent.nextRetryAt)).toBeGreaterThan(Date.now())
    expect(w.account.sync_state.failedAttempts).toBeUndefined()
    // While Sent waits, the INBOX syncs and Sent is not asked.
    inbox.push(6)
    w.fetches.length = 0
    await w.tick()
    expect(w.fetches).toEqual([{ mode: "incremental", before: null, above: "5" }])
    expect(w.imported).toContain("6")
    expect(w.account.sync_state.sent.failedAttempts).toBe(1)
    // Due: Sent is tried again and clears.
    sentFails = false
    w.account.sync_state.sent.nextRetryAt = new Date(Date.now() - 1000).toISOString()
    await w.tick()
    expect(w.account.sync_state.sent.failedAttempts).toBeUndefined()
    expect(w.account.sync_state.sent.done).toBe(true)
  })

  it("a UIDVALIDITY reset during the walk restarts it from the newest", async () => {
    const w = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "syncing",
        sync_state: { cursor: "60", inboxWalk: { before: "36" }, uidValidity: 6 },
      },
      { inbox: range(1, 60) },
    )
    await w.initial()
    expect(w.imported).toEqual([])
    expect(w.account.sync_state.inboxWalk).toBeUndefined()
    expect(w.account.sync_state.uidValidity).toBe(7)
    w.fetches.length = 0
    await w.initial()
    expect(w.fetches).toEqual([{ mode: "full", before: null }])
    expect(w.imported).toEqual(desc(60, 36))
  })

  it("legacy states: a part-way oldest-first import restarts newest first; an imported one catches up newest first", async () => {
    const midway = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "syncing",
        sync_state: { cursor: "17", uidValidity: 7, messagesSynced: 17 },
      },
      { inbox: range(1, 60) },
    )
    await midway.tick()
    await midway.syncNow()
    expect(midway.fetches).toEqual([])
    expect(midway.jobs.map((j) => j.opts?.jobId)).toContain("imap-initial-sync:acc-r")
    await midway.initial()
    expect(midway.fetches).toEqual([{ mode: "full", before: null }])
    expect(midway.imported).toEqual(desc(60, 36))
    expect(midway.account.sync_state.cursor).toBe("60")

    const inbox = range(1, 40)
    const imported = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "active",
        sync_state: { cursor: "10", uidValidity: 7, messagesSynced: 10 },
      },
      { inbox },
    )
    await imported.tick()
    // Never forward from the old cursor: the newest 25 above it first.
    expect(imported.fetches).toEqual([{ mode: "incremental", before: null, above: "10" }])
    expect(imported.imported).toEqual(desc(40, 16))
    expect(imported.account.sync_state.inboxDone).toBe(true)
    expect(imported.account.sync_state.gaps).toEqual([{ above: "10", before: "16" }])
  })

  it("a fresh mailbox: 'Sync now' before the import starts the import, not an oldest-first read", async () => {
    const w = mailWorld(ORG_MAILBOX, { inbox: range(14_019, 14_100) })
    await w.syncNow()
    expect(w.fetches).toEqual([])
    expect(w.jobs).toEqual([
      {
        name: "imap-initial-sync",
        payload: { orgId: "org-1", accountId: "acc-r" },
        opts: { jobId: "imap-initial-sync:acc-r" },
      },
    ])
    await w.initial()
    expect(w.imported).toEqual(desc(14_100, 14_076))
  })
})

describe("a failing incremental sync backs off; the schedule never hammers a slow server", () => {
  const ACTIVE = {
    ...ORG_MAILBOX,
    sync_status: "active",
    sync_state: { cursor: "10", uidValidity: 7, inboxDone: true },
  }

  it("waits 2, then 4 minutes; 'Sync now' tries at once; a success clears it", async () => {
    const w = mailWorld(ACTIVE, { inbox: [10, 11] })
    w.setDown(new Error("IMAP connection refused: ECONNREFUSED"))

    await w.tick()
    expect(w.fetches).toHaveLength(1)
    expect(w.account.sync_status).toBe("active")
    expect(w.account.last_sync_error).toContain("ECONNREFUSED")
    expect(w.account.sync_state.failedAttempts).toBe(1)
    let wait = Date.parse(w.account.sync_state.nextRetryAt) - Date.now()
    expect(wait).toBeGreaterThan(1.9 * 60_000)
    expect(wait).toBeLessThanOrEqual(2 * 60_000)

    await w.tick()
    await w.tick()
    expect(w.fetches).toHaveLength(1)

    w.account.sync_state.nextRetryAt = new Date(Date.now() - 1000).toISOString()
    await w.tick()
    expect(w.fetches).toHaveLength(2)
    expect(w.account.sync_state.failedAttempts).toBe(2)
    wait = Date.parse(w.account.sync_state.nextRetryAt) - Date.now()
    expect(wait).toBeGreaterThan(3.9 * 60_000)
    expect(wait).toBeLessThanOrEqual(4 * 60_000)

    w.setDown(null)
    await w.syncNow()
    expect(w.fetches).toHaveLength(3)
    expect(w.account.sync_state.failedAttempts).toBeUndefined()
    expect(w.account.sync_state.nextRetryAt).toBeUndefined()
    expect(w.account.last_sync_error).toBeNull()
    expect(w.account.sync_state.cursor).toBe("11")
  })

  it("a refused login retries on the six-hour cap, never 'never'", async () => {
    const w = mailWorld(ACTIVE, { inbox: [10] })
    w.setDown(new Error("IMAP authentication failed: wrong_password"))
    await w.tick()
    const wait = Date.parse(w.account.sync_state.nextRetryAt) - Date.now()
    expect(wait).toBeGreaterThan(5.9 * 60 * 60_000)
    expect(wait).toBeLessThanOrEqual(6 * 60 * 60_000)
  })

  it("a row an older release left with failedAttempts and no retry time still syncs", async () => {
    const w = mailWorld(
      { ...ACTIVE, sync_state: { ...ACTIVE.sync_state, failedAttempts: 3, nextRetryAt: null } },
      { inbox: [10, 11] },
    )
    await w.tick()
    expect(w.fetches).toHaveLength(1)
    expect(w.account.sync_state.failedAttempts).toBeUndefined()
    expect(w.account.sync_state.nextRetryAt).toBeUndefined()
  })

  describe("a scheduled poll while nobody is online", () => {
    const tickAlone = async (account: any, others: any[] = []) => {
      const w = mailWorld(account, { inbox: [10, 11] })
      const findMany = async (entity: string, optsJson: string) => {
        const where = JSON.parse(optsJson).where ?? {}
        if (entity !== "accounts" || where.syncStatus !== "active") return "[]"
        return JSON.stringify([w.account, ...others])
      }
      await runMail({
        exportName: "imapIncrementalSync",
        params: { orgId: "org-1" },
        bridge: {
          ...w.bridge(async (opts) => fakeImapBridge([10, 11], opts)),
          db_findMany: findMany,
          hasOnlineUsers: async () => JSON.stringify(false),
        },
        timeoutMs: 15000,
      })
      return w
    }
    const personal = {
      ...ACTIVE,
      owner_type: "user",
      owner_id: "user-1",
      encryption_state: "ready",
    }

    it("an org's mailbox is polled: IMAP has no push, and nobody has to be signed in for its mail", async () => {
      const w = await tickAlone({ ...ACTIVE, owner_type: "org", owner_id: null })
      expect(w.fetches).toHaveLength(1)
    })

    it("a person's own mailbox waits for them, as before", async () => {
      const w = await tickAlone(personal)
      expect(w.fetches).toEqual([])
    })

    it("of several mailboxes, only the org's get a job", async () => {
      const w = await tickAlone({ ...ACTIVE, owner_type: "org", owner_id: null }, [
        { ...personal, id: "acc-p", email_address: "me@northwind.test" },
      ])
      expect(w.fetches).toEqual([])
      expect(w.jobs.map((j: any) => j.payload.accountId)).toEqual(["acc-r"])
    })
  })

  it("a tick with several mailboxes runs each in a job of its own", async () => {
    const w = mailWorld(ACTIVE, { inbox: [10] })
    const second = { ...ACTIVE, id: "acc-s", email_address: "sales@northwind.test" }
    const findMany = async (entity: string, optsJson: string) => {
      const where = JSON.parse(optsJson).where ?? {}
      if (entity !== "accounts" || where.syncStatus !== "active") return "[]"
      return JSON.stringify([w.account, second])
    }
    await runMail({
      exportName: "imapIncrementalSync",
      params: { orgId: "org-1" },
      bridge: { ...w.bridge(async (opts) => fakeImapBridge([10], opts)), db_findMany: findMany },
      timeoutMs: 15000,
    })
    expect(w.fetches).toEqual([])
    expect(w.jobs).toEqual([
      {
        name: "imap-incremental-sync",
        payload: { orgId: "org-1", accountId: "acc-r", tick: true },
        opts: { jobId: "imap-incremental-sync:acc-r" },
      },
      {
        name: "imap-incremental-sync",
        payload: { orgId: "org-1", accountId: "acc-s", tick: true },
        opts: { jobId: "imap-incremental-sync:acc-s" },
      },
    ])
  })

  it("a first import that failed retries later from its page; 'Sync now' tries it at once", async () => {
    const w = mailWorld(
      {
        ...ORG_MAILBOX,
        sync_status: "syncing",
        sync_state: {
          cursor: "60",
          inboxWalk: { before: "36" },
          uidValidity: 7,
          pageSavedAt: new Date().toISOString(),
        },
      },
      { inbox: [10, 20, 35, 60] },
    )
    w.setDown(new Error("IMAP timeout"))
    await w.initial()
    expect(w.account.sync_status).toBe("error")
    expect(w.account.sync_state.inboxWalk).toEqual({ before: "36" })
    const wait = Date.parse(w.account.sync_state.nextRetryAt) - Date.now()
    expect(wait).toBeGreaterThan(14 * 60_000)
    expect(wait).toBeLessThanOrEqual(15 * 60_000)

    await w.tick()
    expect(w.jobs.filter((j) => j.name === "imap-initial-sync")).toEqual([])
    await w.syncNow()
    expect(w.jobs.at(-1)).toMatchObject({
      name: "imap-initial-sync",
      opts: { jobId: "imap-initial-sync:acc-r" },
    })

    w.setDown(null)
    w.fetches.length = 0
    await w.initial()
    expect(w.fetches).toEqual([
      { mode: "incremental", before: null, above: "60" },
      { mode: "full", before: "36" },
    ])
    expect(w.imported).toEqual(["35", "20", "10"])
    expect(w.account.sync_status).toBe("active")
    expect(w.account.sync_state.failedAttempts).toBeUndefined()
  })
})

// The whole path: the bundle, the REAL bridge `imap_fetch` (its option
// parsing included), `imapFetch` and the page, down to a fake IMAP server.
describe("IMAP sync through the real bridge to a fake server", () => {
  it("imports newest first, catches up new mail first, then walks Sent newest first", async () => {
    const inbox = Array.from({ length: 60 }, (_, i) => 14_019 + i * 3)
    const top = inbox[inbox.length - 1]
    const server = fakeImapServer({ uids: inbox, sentUids: [3, 4, 5] })
    ImapBridgeTestAccess.setOpener(async () => server.client)
    const egress = createEgressMethods({
      orgId: "00000000-0000-0000-0000-00000000a1b2",
      userId: "system:mail:imapInitialSync",
      appName: "mail",
      actorType: "system",
      egress: async () => ({ allowedDomains: [], manifest: { name: "mail" } }),
      callerScopes: [],
      inheritedActor: { actorType: "system" as const },
      manifest: { name: "mail" },
      txDb: null,
      resolveCredentials: async () => ({
        imapHost: "imap.example.test",
        imapPort: "993",
        username: "support@northwind.test",
        password: "not-a-real-password",
      }),
    } as unknown as BridgeContext)
    const box = mailboxRecord(ORG_MAILBOX)
    const imported: string[] = []
    const base = box.bridge(async () => ({}))
    const bridge = {
      ...base,
      imap_fetch: egress.imap_fetch,
      db_insert: async (entity: string, dataJson: string) => {
        if (entity === "messages") imported.push(String(JSON.parse(dataJson).externalProviderId))
        return base.db_insert(entity, dataJson)
      },
    }
    const run = (exportName: string, params: Record<string, unknown>) =>
      runMail({
        exportName,
        params,
        bridge,
        timeoutMs: 15000,
      })
    const params = { orgId: "org-1", accountId: "acc-r" }
    try {
      await run("imapInitialSync", params)
      expect(imported).toEqual(inbox.slice(-25).reverse().map(String))
      expect(box.account.sync_state.cursor).toBe(String(top))
      expect(box.account.sync_state.inboxWalk).toEqual({ before: String(inbox[35]) })

      inbox.push(top + 10)
      await run("imapInitialSync", params)
      // The new message before the next walk page.
      expect(imported.slice(25)).toEqual([
        String(top + 10),
        ...inbox.slice(10, 35).reverse().map(String),
      ])
      await run("imapInitialSync", params)
      expect(box.account.sync_status).toBe("active")
      expect(box.account.sync_state.inboxDone).toBe(true)
      expect(new Set(imported).size).toBe(61)
      // Sent found from the LIST flags (\Sent), walked newest first.
      expect(box.account.sync_state.capabilities.folders.sent).toBe("Sent")
      await run("imapIncrementalSync", params)
      expect(imported.slice(-3)).toEqual(["sent:5", "sent:4", "sent:3"])
      expect(box.account.sync_state.sent).toMatchObject({ cursor: "5", done: true })
      // A sync never writes to the mailbox and always opens it read-only.
      expect(server.stats.lockedReadOnly.every(Boolean)).toBe(true)
    } finally {
      ImapBridgeTestAccess.setOpener(null)
    }
  })
})
