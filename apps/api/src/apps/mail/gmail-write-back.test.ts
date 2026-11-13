// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { runMail } from "~/apps/mail/test-page-write-bridge"

// Archive, read state, star and trash done in Liaison are written back to
// Gmail by the `gmail-write-back` job, and the history echo of that write does
// not flip anything back. The Gmail HTTP boundary is the bridge's `fetch`.

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

interface Row extends Record<string, any> {
  id: string
}

interface World {
  accounts: Record<string, Row>
  conversations: Record<string, Row>
  messages: Record<string, Row>
}

interface Captured {
  deltas: any[]
  fetches: Array<{ url: string; method?: string; body: any }>
  updates: Array<{ entity: string; id: string; data: any }>
  jobs: Array<{ name: string; payload: any; opts: any }>
  emits: any[]
}

function gmailAccount(overrides: Partial<Row> = {}): Row {
  return {
    id: "acc-1",
    owner_type: "org",
    encryption_state: "none",
    owner_id: null,
    provider: "gmail",
    email_address: "support@example.test",
    sync_status: "active",
    sync_state: { historyId: "100" },
    last_sync_error: null,
    disconnected_at: null,
    ...overrides,
  }
}

function conversation(overrides: Partial<Row> = {}): Row {
  return {
    id: "conv-1",
    account_id: "acc-1",
    external_thread_id: "thread-1",
    status: "open",
    is_read: false,
    is_starred: false,
    labels: ["INBOX", "UNREAD"],
    ...overrides,
  }
}

function message(id: string, providerId: string, labels: string[], sentAt: string): Row {
  return {
    id,
    conversation_id: "conv-1",
    account_id: "acc-1",
    external_provider_id: providerId,
    labels,
    is_read: !labels.includes("UNREAD"),
    is_starred: labels.includes("STARRED"),
    sent_at: sentAt,
    snippet: null,
    enc_version: 0,
  }
}

function createBridge(
  world: World,
  respond: (url: string, init: any, world: World) => { status: number; body?: string },
) {
  const captured: Captured = { deltas: [], fetches: [], updates: [], jobs: [], emits: [] }
  const table = (entity: string): Record<string, Row> =>
    (world as unknown as Record<string, Record<string, Row>>)[entity] ?? {}
  const bridge: Record<string, any> = {
    getUserId: () => "system",
    getOrgId: () => "org-1",
    hasOnlineUsers: async () => "true",
    log_info: async () => {},
    log_warn: async () => {},
    log_error: async () => {},
    log_debug: async () => {},
    db_findOne: async (entity: string, id: string) => JSON.stringify(table(entity)[id] ?? null),
    db_findMany: async (entity: string, optsJson: string) => {
      const where = JSON.parse(optsJson)?.where ?? {}
      let rows = Object.values(table(entity))
      if (where.conversationId)
        rows = rows.filter((r) => r.conversation_id === where.conversationId)
      if (where.externalProviderId?.in) {
        rows = rows.filter((r) => where.externalProviderId.in.includes(r.external_provider_id))
      }
      if (entity === "messages") rows.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
      return JSON.stringify(rows)
    },
    db_insert: async (_e: string, dataJson: string) =>
      JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
    db_update: async (entity: string, id: string, dataJson: string) => {
      const data = JSON.parse(dataJson)
      captured.updates.push({ entity, id, data })
      const row = table(entity)[id]
      if (row) for (const [key, value] of Object.entries(data)) row[snake(key)] = value
    },
    db_updateMany: async () => JSON.stringify({ count: 0 }),
    db_delete: async () => {},
    db_count: async () => "0",
    emit: async (json: string) => {
      captured.emits.push(JSON.parse(json))
    },
    enqueueJob: async (name: string, payload: string, opts?: string) => {
      captured.jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : {} })
    },
    connections_getToken: async () => "token",
    connections_getAccounts: async () => "[]",
    connections_disconnect: async () => {},
    hasScope: async () => true,
    // The host applies the delta to the CURRENT stored labels, as the real
    // bridge does in one transaction.
    mail_applyLabelDelta: async (paramsJson: string) => {
      const delta = JSON.parse(paramsJson)
      captured.deltas.push(delta)
      const apply = (labels: unknown): string[] => {
        const kept = (Array.isArray(labels) ? labels : []).filter(
          (l: string) => !delta.remove.includes(l),
        )
        return [...new Set([...kept, ...delta.add])]
      }
      for (const row of Object.values(world.messages)) {
        if (row.conversation_id === delta.conversationId) row.labels = apply(row.labels)
      }
      const conv = world.conversations[delta.conversationId]
      if (conv) conv.labels = apply(conv.labels)
      return JSON.stringify({ labels: conv?.labels ?? null })
    },
    fetch: async (url: string, optsJson: string) => {
      const init = JSON.parse(optsJson || "{}")
      captured.fetches.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      })
      const res = respond(url, init, world)
      return JSON.stringify({ status: res.status, headers: {}, body: res.body ?? "{}" })
    },
  }
  return { bridge, captured }
}

const ok = () => ({ status: 200, body: "{}" })

describe("gmail-write-back job", () => {
  async function run(exportName: string, params: unknown, bridge: Record<string, any>) {
    await runMail({
      exportName,
      params,
      bridge,
      timeoutMs: 30000,
    })
  }

  function worldWith(conv: Row, messages: Row[], account: Row = gmailAccount()): World {
    return {
      accounts: { [account.id]: account },
      conversations: { [conv.id]: conv },
      messages: Object.fromEntries(messages.map((m) => [m.id, m])),
    }
  }

  const twoMessages = () => [
    message("m-1", "gm-1", ["INBOX", "UNREAD"], "2026-09-01T10:00:00.000Z"),
    message("m-2", "gm-2", ["INBOX", "UNREAD"], "2026-09-01T11:00:00.000Z"),
  ]

  it("archive removes INBOX from the Gmail thread in one call and mirrors it on the stored labels", async () => {
    const world = worldWith(conversation({ status: "archived" }), twoMessages())
    const { bridge, captured } = createBridge(world, ok)

    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "archived" },
      },
      bridge,
    )

    expect(captured.fetches).toEqual([
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/modify",
        method: "POST",
        body: { addLabelIds: [], removeLabelIds: ["INBOX"] },
      },
    ])
    expect(world.messages["m-1"]?.labels).toEqual(["UNREAD"])
    expect(world.messages["m-2"]?.labels).toEqual(["UNREAD"])
    expect(world.conversations["conv-1"]?.labels).toEqual(["UNREAD"])
    // Nothing the user set is rewritten by the job.
    expect(world.conversations["conv-1"]?.status).toBe("archived")
    expect(captured.jobs).toEqual([])
  })

  it("read, unread, star and unstar map to UNREAD and STARRED", async () => {
    const world = worldWith(conversation({ is_read: true, is_starred: true }), twoMessages())
    const { bridge, captured } = createBridge(world, ok)
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { isRead: true, isStarred: true },
      },
      bridge,
    )
    expect(captured.fetches[0]?.body).toEqual({
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    })
    expect(world.messages["m-1"]?.labels).toEqual(["INBOX", "STARRED"])

    const unworld = worldWith(
      conversation({ is_read: false, is_starred: false, labels: ["INBOX", "STARRED"] }),
      [message("m-1", "gm-1", ["INBOX", "STARRED"], "2026-09-01T10:00:00.000Z")],
    )
    const second = createBridge(unworld, ok)
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { isRead: false, isStarred: false },
      },
      second.bridge,
    )
    expect(second.captured.fetches[0]?.body).toEqual({
      addLabelIds: ["UNREAD"],
      removeLabelIds: ["STARRED"],
    })
  })

  it("trash moves the thread to Gmail's Trash; reopening a trashed thread untrashes it and puts it back in the inbox", async () => {
    const world = worldWith(conversation({ status: "trashed" }), twoMessages())
    const { bridge, captured } = createBridge(world, ok)
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "trashed" },
      },
      bridge,
    )
    expect(captured.fetches.map((f) => f.url)).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/trash",
    ])
    expect(world.messages["m-1"]?.labels).toContain("TRASH")

    world.conversations["conv-1"]!.status = "open"
    const back = createBridge(world, ok)
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "open" },
      },
      back.bridge,
    )
    expect(back.captured.fetches.map((f) => f.url)).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/untrash",
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/modify",
    ])
    expect(back.captured.fetches[1]?.body).toEqual({ addLabelIds: ["INBOX"], removeLabelIds: [] })
    expect(world.messages["m-1"]?.labels).not.toContain("TRASH")
  })

  it("a job a later change superseded writes nothing", async () => {
    // Archived, then moved back to the inbox before the archive job ran.
    const world = worldWith(conversation({ status: "open" }), twoMessages())
    const { bridge, captured } = createBridge(world, ok)
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "archived" },
      },
      bridge,
    )
    expect(captured.fetches).toEqual([])
  })

  it("a value that moved while the job was calling Gmail is pushed by a follow-up job", async () => {
    const world = worldWith(conversation({ status: "archived" }), twoMessages())
    const { bridge, captured } = createBridge(world, (_url, _init, w) => {
      // The user moves it back to the inbox while Gmail is archiving it.
      w.conversations["conv-1"]!.status = "open"
      return ok()
    })
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "archived" },
      },
      bridge,
    )
    expect(captured.jobs).toEqual([
      {
        name: "gmail-write-back",
        payload: {
          orgId: "org-1",
          accountId: "acc-1",
          conversationIds: ["conv-1"],
          fields: { status: "open" },
        },
        opts: {},
      },
    ])
  })

  it("never calls Gmail for an IMAP mailbox, nor anything for a disconnected one", async () => {
    for (const account of [
      gmailAccount({ provider: "imap" }),
      gmailAccount({ disconnected_at: "2026-09-01T00:00:00.000Z" }),
    ]) {
      const world = worldWith(conversation({ status: "archived" }), twoMessages(), account)
      const { bridge, captured } = createBridge(world, ok)
      await run(
        "gmailWriteBack",
        {
          orgId: "org-1",
          accountId: "acc-1",
          conversationIds: ["conv-1"],
          fields: { status: "archived" },
        },
        bridge,
      )
      expect(captured.fetches).toEqual([])
    }
  })

  it("a connection without the modify scope keeps the change and tells the mailbox, without retrying", async () => {
    const world = worldWith(conversation({ status: "archived" }), twoMessages())
    const { bridge, captured } = createBridge(world, () => ({
      status: 403,
      body: JSON.stringify({
        error: { message: "Request had insufficient authentication scopes." },
      }),
    }))
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "archived" },
      },
      bridge,
    )
    expect(captured.jobs).toEqual([])
    expect(world.conversations["conv-1"]?.status).toBe("archived")
    // Gmail did not take it, so the stored labels do not pretend it did.
    expect(world.messages["m-1"]?.labels).toEqual(["INBOX", "UNREAD"])
    // A code the web client renders in the viewer's language.
    expect(world.accounts["acc-1"]?.last_sync_error).toBe("gmail_write_back:scope")
    expect(captured.emits.some((e) => e.entity === "account")).toBe(true)
  })

  it("a rate limit retries later, a bounded number of times, then reports it", async () => {
    const world = worldWith(conversation({ status: "archived" }), twoMessages())
    const limited = () => ({ status: 429, body: "rate limited" })
    const first = createBridge(world, limited)
    const payload = {
      orgId: "org-1",
      accountId: "acc-1",
      conversationIds: ["conv-1"],
      fields: { status: "archived" },
    }
    await run("gmailWriteBack", payload, first.bridge)
    expect(first.captured.jobs).toHaveLength(1)
    expect(first.captured.jobs[0]?.payload.attempt).toBe(2)
    expect(first.captured.jobs[0]?.opts.delay).toBeGreaterThan(0)
    expect(world.accounts["acc-1"]?.last_sync_error).toBeNull()

    const last = createBridge(world, limited)
    await run("gmailWriteBack", { ...payload, attempt: 5 }, last.bridge)
    expect(last.captured.jobs).toEqual([])
    expect(world.accounts["acc-1"]?.last_sync_error).toBe("gmail_write_back:unavailable")

    // A job that writes nothing (superseded) leaves the error in place.
    world.conversations["conv-1"]!.status = "open"
    const superseded = createBridge(world, ok)
    await run("gmailWriteBack", payload, superseded.bridge)
    expect(superseded.captured.fetches).toEqual([])
    expect(world.accounts["acc-1"]?.last_sync_error).toBe("gmail_write_back:unavailable")

    // The next write Gmail accepts clears the write-back error it left.
    world.conversations["conv-1"]!.status = "archived"
    const later = createBridge(world, ok)
    await run("gmailWriteBack", payload, later.bridge)
    expect(world.accounts["acc-1"]?.last_sync_error).toBeNull()
  })

  it("a sync label change stored while Gmail was being called survives the mirror", async () => {
    const world = worldWith(conversation({ status: "archived" }), twoMessages())
    const { bridge, captured } = createBridge(world, (_url, _init, w) => {
      // The sync stores a star on m-2 meanwhile.
      w.messages["m-2"]!.labels = [...w.messages["m-2"]!.labels, "STARRED"]
      return ok()
    })
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "archived" },
      },
      bridge,
    )
    expect(captured.deltas).toEqual([
      { accountId: "acc-1", conversationId: "conv-1", add: [], remove: ["INBOX"] },
    ])
    expect(world.messages["m-2"]?.labels).toEqual(["UNREAD", "STARRED"])
  })

  it("an agent archive that has not committed yet is looked at once more, later", async () => {
    const world = worldWith(conversation({ status: "open" }), twoMessages())
    const { bridge, captured } = createBridge(world, ok)
    const payload = {
      orgId: "org-1",
      accountId: "acc-1",
      conversationIds: ["conv-1"],
      fields: { status: "archived" },
      awaitCommit: true,
    }
    await run("gmailWriteBack", payload, bridge)
    expect(captured.fetches).toEqual([])
    expect(captured.jobs).toHaveLength(1)
    expect(captured.jobs[0]?.payload).toMatchObject({
      conversationIds: ["conv-1"],
      awaitCommit: false,
    })
    expect(captured.jobs[0]?.opts.delay).toBeGreaterThan(0)

    // The re-check finds it committed and writes it.
    world.conversations["conv-1"]!.status = "archived"
    const recheck = createBridge(world, ok)
    await run("gmailWriteBack", captured.jobs[0]?.payload, recheck.bridge)
    expect(recheck.captured.fetches).toHaveLength(1)
    expect(recheck.captured.jobs).toEqual([])

    // Without the flag (or on the re-check), a superseded job just stops.
    const again = createBridge(world, ok)
    world.conversations["conv-1"]!.status = "open"
    await run("gmailWriteBack", captured.jobs[0]?.payload, again.bridge)
    expect(again.captured.jobs).toEqual([])
  })

  it("only Gmail ids and label ids leave Liaison for an encrypted mailbox", async () => {
    const sealed = conversation({
      status: "archived",
      enc_version: 1,
      subject: null,
      snippet: null,
      subject_ciphertext: "c2VhbGVk",
      snippet_ciphertext: "c2VhbGVk",
    })
    const world = worldWith(
      sealed,
      twoMessages(),
      gmailAccount({ owner_type: "user", owner_id: "user-1", encryption_state: "ready" }),
    )
    const { bridge, captured } = createBridge(world, ok)
    await run(
      "gmailWriteBack",
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        fields: { status: "archived" },
      },
      bridge,
    )
    expect(captured.fetches).toHaveLength(1)
    expect(JSON.stringify(captured.fetches)).not.toContain("c2VhbGVk")
    // The job writes labels only: no content column is touched.
    for (const update of captured.updates) {
      expect(Object.keys(update.data).every((k) => k === "labels" || k === "lastSyncError")).toBe(
        true,
      )
    }
  })
})

describe("incremental sync after a write-back (no loop, no flip)", () => {
  async function sync(world: World, history: any[]) {
    const { bridge, captured } = createBridge(world, (url) => {
      if (url.includes("/history")) {
        return { status: 200, body: JSON.stringify({ historyId: "200", history }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    await runMail({
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })
    return captured
  }

  function world(conv: Row, labels: string[][]): World {
    const messages = labels.map((l, i) =>
      message(`m-${i + 1}`, `gm-${i + 1}`, l, `2026-09-01T1${i}:00:00.000Z`),
    )
    return {
      accounts: { "acc-1": gmailAccount() },
      conversations: { [conv.id]: conv },
      messages: Object.fromEntries(messages.map((m) => [m.id, m])),
    }
  }

  it("the echo of Liaison's own archive leaves the conversation archived and writes nothing back", async () => {
    // State right after the write-back job: archived, INBOX already gone locally.
    const w = world(conversation({ status: "archived", is_read: true, labels: [] }), [[], []])
    const captured = await sync(w, [
      {
        id: "150",
        labelsRemoved: [
          { message: { id: "gm-1" }, labelIds: ["INBOX"] },
          { message: { id: "gm-2" }, labelIds: ["INBOX"] },
        ],
      },
    ])
    expect(w.conversations["conv-1"]?.status).toBe("archived")
    expect(captured.jobs.filter((j) => j.name === "gmail-write-back")).toEqual([])
  })

  it("reading in Gmail does not reopen a conversation archived in Liaison before its write-back ran", async () => {
    // Archived in Liaison, Gmail not yet told: the thread still has INBOX.
    const w = world(conversation({ status: "archived", labels: ["INBOX", "UNREAD"] }), [
      ["INBOX", "UNREAD"],
    ])
    await sync(w, [
      { id: "150", labelsRemoved: [{ message: { id: "gm-1" }, labelIds: ["UNREAD"] }] },
    ])
    expect(w.conversations["conv-1"]?.status).toBe("archived")
    expect(w.conversations["conv-1"]?.is_read).toBe(true)
  })

  it("archive and move-to-inbox done in Gmail reach Liaison", async () => {
    const w = world(conversation({ status: "open", labels: ["INBOX"] }), [["INBOX"]])
    await sync(w, [
      { id: "150", labelsRemoved: [{ message: { id: "gm-1" }, labelIds: ["INBOX"] }] },
    ])
    expect(w.conversations["conv-1"]?.status).toBe("archived")

    // A later tick (the 60 s guard skips a sync that just ran).
    w.accounts["acc-1"]!.last_sync_at = null
    await sync(w, [{ id: "160", labelsAdded: [{ message: { id: "gm-1" }, labelIds: ["INBOX"] }] }])
    expect(w.conversations["conv-1"]?.status).toBe("open")
  })

  it("a conversation escalated to a ticket stays escalated through a Gmail label change", async () => {
    const w = world(conversation({ status: "escalated", labels: ["INBOX", "UNREAD"] }), [
      ["INBOX", "UNREAD"],
    ])
    await sync(w, [
      { id: "150", labelsRemoved: [{ message: { id: "gm-1" }, labelIds: ["INBOX"] }] },
    ])
    expect(w.conversations["conv-1"]?.status).toBe("escalated")
  })
})

// The same job writes back an IMAP mailbox's changes over IMAP (imap_writeBack,
// the host side is modules/apps/sandbox/imap-mailbox.ts): the conversation's
// messages are named by Message-ID, the stored labels are mirrored like
// Gmail's, failures retry or land on the mailbox as `imap_write_back:<kind>`.
describe("gmail-write-back job, IMAP mailbox", () => {
  const imapAccount = (overrides: Partial<Row> = {}) =>
    gmailAccount({ provider: "imap", sync_state: { cursor: "9" }, ...overrides })

  function world(conv: Row, account: Row = imapAccount()): World {
    const messages = [
      {
        ...message("m-1", "4", ["INBOX", "UNREAD"], "2026-09-01T10:00:00.000Z"),
        external_message_id: "<one@x>",
      },
      {
        ...message("m-2", "sent:2", ["SENT"], "2026-09-01T11:00:00.000Z"),
        external_message_id: "<two@x>",
      },
    ]
    return {
      accounts: { [account.id]: account },
      conversations: { [conv.id]: conv },
      messages: Object.fromEntries(messages.map((m) => [m.id, m])),
    }
  }

  // `writeBack` answers one item of the batch; throwing fails the whole session
  // (a lost connection), as the host does.
  async function runImap(
    w: World,
    fields: Record<string, unknown>,
    writeBack: (input: any) => any,
    extra: Record<string, unknown> = {},
  ) {
    const { bridge, captured } = createBridge(w, ok)
    const calls: any[] = []
    bridge.imap_writeBack = async (connection: string, identifier: string, inputJson: string) => {
      const input = JSON.parse(inputJson)
      calls.push({ connection, identifier, input })
      const results = []
      for (const item of input.items) results.push(await writeBack(item))
      return JSON.stringify({ results })
    }
    await runMail({
      exportName: "gmailWriteBack",
      params: { orgId: "org-1", accountId: "acc-1", conversationIds: ["conv-1"], fields, ...extra },
      bridge,
      timeoutMs: 30000,
    })
    return { captured, calls }
  }

  const found = () => ({ found: 2, archiveUnsupported: false, trashUnsupported: false })

  it("archive and read go to the server by Message-ID and are mirrored on the stored labels", async () => {
    const w = world(conversation({ status: "archived", is_read: true }))
    const { captured, calls } = await runImap(w, { status: "archived", isRead: true }, found)
    expect(calls).toEqual([
      {
        connection: "imap",
        identifier: "support@example.test",
        input: {
          items: [{ messageIds: ["<two@x>", "<one@x>"], seen: true, location: "archive" }],
        },
      },
    ])
    expect(captured.fetches).toEqual([])
    expect(captured.deltas).toEqual([
      { accountId: "acc-1", conversationId: "conv-1", add: [], remove: ["UNREAD", "INBOX"] },
    ])
    expect(w.messages["m-1"]?.labels).toEqual([])
    expect(captured.jobs).toEqual([])
  })

  it("a server without an Archive folder keeps archive in Liaison and the INBOX label", async () => {
    const w = world(conversation({ status: "archived" }))
    const { captured } = await runImap(w, { status: "archived" }, () => ({
      ...found(),
      archiveUnsupported: true,
    }))
    expect(captured.deltas).toEqual([])
    expect(w.messages["m-1"]?.labels).toContain("INBOX")
  })

  it("only the value still current is written (a later change has its own job)", async () => {
    const w = world(conversation({ status: "open", is_starred: true }))
    const { calls } = await runImap(w, { status: "archived", isStarred: true }, found)
    expect(calls[0]?.input).toEqual({
      items: [{ messageIds: ["<two@x>", "<one@x>"], flagged: true }],
    })
  })

  it("a change the server refuses is reported; nothing is mirrored for it", async () => {
    const w = world(conversation({ status: "archived" }))
    const { captured } = await runImap(w, { status: "archived" }, () => ({
      error: "IMAP rejected: [CANNOT] no such folder",
    }))
    expect(w.accounts["acc-1"]?.last_sync_error).toBe("imap_write_back:rejected")
    expect(captured.deltas).toEqual([])
    expect(captured.jobs).toEqual([])
  })

  it("a bulk change is written in one session per 15 conversations; the rest chain", async () => {
    const w = world(conversation({ status: "archived" }))
    const ids = Array.from({ length: 17 }, (_, i) => `conv-${i + 1}`)
    for (const id of ids.slice(1)) {
      w.conversations[id] = conversation({ id, status: "archived" })
    }
    const { calls, captured } = await runImap(w, { status: "archived" }, found, {
      conversationIds: ids,
    })
    // conv-1 has messages on the server; the others are empty here.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input.items).toHaveLength(1)
    expect(captured.jobs).toEqual([
      {
        name: "gmail-write-back",
        payload: {
          orgId: "org-1",
          accountId: "acc-1",
          conversationIds: ["conv-16", "conv-17"],
          fields: { status: "archived" },
        },
        opts: {},
      },
    ])
  })

  it("a refused login is reported on the mailbox and not retried", async () => {
    const w = world(conversation({ status: "trashed" }))
    const { captured } = await runImap(w, { status: "trashed" }, () => {
      throw new Error("IMAP authentication failed: wrong_password")
    })
    expect(w.accounts["acc-1"]?.last_sync_error).toBe("imap_write_back:auth")
    expect(captured.jobs).toEqual([])
    expect(captured.deltas).toEqual([])
  })

  it("an unreachable server is retried, then reported as unavailable", async () => {
    const w = world(conversation({ status: "archived" }))
    const first = await runImap(w, { status: "archived" }, () => {
      throw new Error("IMAP timeout")
    })
    expect(first.captured.jobs).toEqual([
      {
        name: "gmail-write-back",
        payload: {
          orgId: "org-1",
          accountId: "acc-1",
          conversationIds: ["conv-1"],
          fields: { status: "archived" },
          attempt: 2,
        },
        opts: { delay: 30000 },
      },
    ])
    const last = await runImap(
      w,
      { status: "archived" },
      () => {
        throw new Error("IMAP timeout")
      },
      { attempt: 5 },
    )
    expect(last.captured.jobs).toEqual([])
    expect(w.accounts["acc-1"]?.last_sync_error).toBe("imap_write_back:unavailable")

    // A later write the server accepts clears it.
    await runImap(w, { status: "archived" }, found)
    expect(w.accounts["acc-1"]?.last_sync_error).toBeNull()
  })
})
