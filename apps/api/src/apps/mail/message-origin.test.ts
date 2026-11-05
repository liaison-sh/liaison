// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S16: every `message:create` the mail app emits names the sync path that
// stored the message (`origin`), and an inbound message carries the fields the
// kernel's new-email producer decides on (labels, isRead, Gmail internalDate).
// Only an `incremental` Gmail message may notify, so a wrong origin on the
// initial import is a 500-banner flood.
import { beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { executeInSandbox } from "~/apps/mail/test-page-write-bridge"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"

let bundleSource: string

beforeAll(async () => {
  await initSandboxPool()
  bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
})

const INTERNAL_DATE = "1737025200000"

function gmailMessage(id: string) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet: "s",
    payload: {
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "Subject", value: "Quarterly figures" },
        { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
        { name: "Message-ID", value: `<${id}@m>` },
      ],
      parts: [{ mimeType: "text/plain", body: { data: btoa("body") } }],
    },
    internalDate: INTERNAL_DATE,
  }
}

function makeBridge(account: Record<string, unknown>, extra: Record<string, any> = {}) {
  const emits: any[] = []
  let inserted = 0
  const bridge: Record<string, any> = {
    getUserId: () => "system",
    getOrgId: () => "org-1",
    db_findOne: async () => JSON.stringify(account),
    db_findMany: async (entity: string, optsJson: string) => {
      if (entity === "accounts") {
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== account.sync_status) return "[]"
        return JSON.stringify([account])
      }
      return "[]"
    },
    mailbox_sealAndInsert: async (paramsJson: string) => {
      const params = JSON.parse(paramsJson)
      inserted++
      return JSON.stringify({ id: `sealed-${inserted}`, ...params.row })
    },
    db_insert: async (_entity: string, dataJson: string) => {
      inserted++
      return JSON.stringify({ id: `gen-${inserted}`, ...JSON.parse(dataJson) })
    },
    db_update: async () => {},
    db_updateMany: async () => JSON.stringify({ count: 0 }),
    db_delete: async () => {},
    db_count: async () => "0",
    emit: async (eventJson: string) => {
      emits.push(JSON.parse(eventJson))
    },
    enqueueJob: async () => {},
    connections_getToken: async () => "token",
    connections_getAccounts: async () => "[]",
    connections_disconnect: async () => {},
    hasScope: async () => true,
    resolveContact: async (p: string) => JSON.stringify({ id: "c1", email: JSON.parse(p).email }),
    fetch: async (url: string) => {
      if (url.includes("/history")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            historyId: "1001",
            history: [{ id: "1000", messagesAdded: [{ message: { id: "gm-new" } }] }],
          }),
        })
      }
      if (url.includes("messages?")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ messages: [{ id: "gm-old", threadId: "t-gm-old" }] }),
        })
      }
      const m = url.match(/messages\/([^?/]+)/)
      if (m) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify(gmailMessage(m[1])),
        })
      }
      if (url.includes("/watch") || url.includes("/profile")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
        })
      }
      return JSON.stringify({ status: 404, headers: {}, body: "" })
    },
    imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
    smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
    hasOnlineUsers: async () => JSON.stringify(true),
    config_get: async () => null,
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
    log_debug: () => {},
    ...extra,
  }
  return { bridge, emits }
}

const personalGmail = (syncStatus: string, syncState: unknown) => ({
  id: "acc-1",
  owner_type: "user",
  encryption_state: "ready",
  owner_id: "user-1",
  provider: "gmail",
  email_address: "me@example.com",
  sync_status: syncStatus,
  sync_state: syncState,
  disconnected_at: null,
  updated_at: new Date().toISOString(),
})

function messageCreates(emits: any[]) {
  return emits.filter((e) => e.entity === "message" && e.action === "create")
}

describe("message:create carries its sync origin (S16)", () => {
  it("the Gmail initial import emits origin initial", async () => {
    const { bridge, emits } = makeBridge(personalGmail("pre-sync", null))
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 15000,
    })
    const created = messageCreates(emits)
    expect(created.length).toBe(1)
    expect(created[0].data.origin).toBe("initial")
  })

  it("a Gmail incremental message emits origin incremental with labels, isRead and internalDate, also mid-backfill", async () => {
    for (const status of ["active", "syncing"]) {
      const { bridge, emits } = makeBridge(
        personalGmail(status, {
          historyId: "123",
          cursor: status === "syncing" ? "page-5" : undefined,
          pageSavedAt: new Date().toISOString(),
        }),
      )
      await executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: "gmailIncrementalSync",
        params: { orgId: "org-1", accountId: "acc-1" },
        bridge,
        timeoutMs: 15000,
      })
      const created = messageCreates(emits)
      expect(created.length).toBe(1)
      expect(created[0].data).toMatchObject({
        origin: "incremental",
        labels: ["INBOX", "UNREAD"],
        isRead: false,
        internalDate: Number(INTERNAL_DATE),
        direction: "inbound",
      })
      // The event never carries the subject (sealed, D2).
      expect(JSON.stringify(created[0])).not.toContain("Quarterly figures")
    }
  })

  it("an IMAP message emits origin imap", async () => {
    let calls = 0
    const { bridge, emits } = makeBridge(
      { ...personalGmail("pre-sync", null), provider: "imap" },
      {
        imap_fetch: async () => {
          calls++
          if (calls > 1) return JSON.stringify({ messages: [], done: true, uidValidity: 7 })
          return JSON.stringify({
            messages: [
              {
                externalMessageId: "<imap1@test>",
                externalProviderId: "1",
                externalThreadId: "<imap1@test>",
                from: { email: "sender@test.com" },
                to: [],
                subject: "IMAP",
                textBody: "b",
                labels: ["INBOX"],
                isRead: false,
                sentAt: "2026-01-15T10:00:00Z",
              },
            ],
            nextCursor: null,
            done: true,
            uidValidity: 7,
          })
        },
      },
    )
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "imapInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 15000,
    })
    const created = messageCreates(emits)
    expect(created.length).toBe(1)
    expect(created[0].data.origin).toBe("imap")
  })
})
