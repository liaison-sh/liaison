// SPDX-License-Identifier: FSL-1.1-ALv2
// [Task 7][Task 8] Tickets account-event subscribers — onAccountConnected
// creates/refreshes an inbox row and onAccountDisconnected archives it.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import * as handlers from "~/apps/tickets/handlers"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string

type TicketAccountHandler = (event: { orgId: string; data: any }, ctx: any) => Promise<void>

beforeAll(async () => {
  const slug = `inbox-onb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("inbox-onb-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Inbox Onb', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

describe("tickets.inbox.onConnected.manifest", () => {
  it("manifest declares the connected_account event subscriptions", () => {
    const subs = (ticketsManifest as any).events.subscribes as Record<string, string>
    expect(subs["kernel/connected_account:create"]).toBe("ticketsOnAccountConnected")
    expect(subs["kernel/connected_account:disconnect"]).toBe("ticketsOnAccountDisconnected")
  })
})

describe("tickets.inbox.onConnected.creates-row", () => {
  it("invokes ticketsOnAccountConnected handler and adds an inbox row when ctx db_insert is wired", async () => {
    // Direct unit invocation of the handler with a mock ctx that mirrors the
    // sandbox bridge surface. We don't go through the event bus; we exercise
    // the handler's branching directly so its semantics are pinned.
    const fn = handlers.ticketsOnAccountConnected as unknown as TicketAccountHandler
    expect(typeof fn).toBe("function")

    const inserted: any[] = []
    const updates: any[] = []
    const enqueued: any[] = []
    const emitted: any[] = []
    const ctx = {
      db_findMany: async () => "[]",
      db_insert: async (_entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        inserted.push(data)
        return JSON.stringify({ id: crypto.randomUUID(), ...data })
      },
      db_update: async (_entity: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      enqueueJob: async (jobName: string, payloadJson: string) => {
        enqueued.push({ jobName, payload: JSON.parse(payloadJson) })
      },
      emit: async (eventJson: string) => {
        emitted.push(JSON.parse(eventJson))
      },
    }
    await fn(
      {
        orgId,
        data: {
          appName: "tickets",
          id: "ca_1",
          identifier: "support@example.com",
          connectionName: "gmail",
          ownerType: "org",
          ownerId: orgId,
        },
      },
      ctx,
    )
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      connectedAccountId: "ca_1",
      name: "support@example.com",
      emailAddress: "support@example.com",
      defaultSensitivity: "internal",
      isDefaultForCreate: true,
    })
    expect(emitted[0]).toMatchObject({ entity: "inbox", action: "create" })
    expect(enqueued[0]).toMatchObject({ jobName: "gmail-initial-sync" })
  })

  it("ignores connected_account:create when appName is not tickets", async () => {
    const fn = handlers.ticketsOnAccountConnected as unknown as TicketAccountHandler
    let called = 0
    const ctx = {
      db_findMany: async () => {
        called++
        return "[]"
      },
      db_insert: async () => "{}",
      db_update: async () => {},
      enqueueJob: async () => {},
      emit: async () => {},
    }
    await fn(
      {
        orgId,
        data: { appName: "mail", id: "x", identifier: "x@x.test", connectionName: "gmail" },
      },
      ctx,
    )
    expect(called).toBe(0)
  })

  it("enqueues imap-initial-sync when connectionName='imap'", async () => {
    const fn = handlers.ticketsOnAccountConnected as unknown as TicketAccountHandler
    const enqueued: any[] = []
    const ctx = {
      db_findMany: async () => "[]",
      db_insert: async (_e: string, d: string) =>
        JSON.stringify({ id: crypto.randomUUID(), ...JSON.parse(d) }),
      db_update: async () => {},
      enqueueJob: async (n: string, p: string) => enqueued.push({ name: n, p: JSON.parse(p) }),
      emit: async () => {},
    }
    await fn(
      {
        orgId,
        data: { appName: "tickets", id: "ca_2", identifier: "foo@bar", connectionName: "imap" },
      },
      ctx,
    )
    expect(enqueued[0]?.name).toBe("imap-initial-sync")
  })

  // Regression: a reconnect mints a NEW connected_account id (the old one is deactivated on the
  // OAuth callback), so an inbox that still points at the OLD id would be missed by an
  // account-id-only lookup and a DUPLICATE inbox created -- leaving the original orphaned on a
  // dead account (still "active") and sync never resuming on the inbox the user sees.
  it("rebinds the existing mailbox inbox by email on reconnect instead of creating a duplicate", async () => {
    const fn = handlers.ticketsOnAccountConnected as unknown as TicketAccountHandler
    const inserted: any[] = []
    const updates: any[] = []
    const enqueued: any[] = []
    const findQueries: any[] = []
    const ctx = {
      db_findMany: async (_entity: string, queryJson: string) => {
        const q = JSON.parse(queryJson)
        findQueries.push(q)
        // No inbox is bound to the NEW account id; one exists for the email address.
        if (q?.where?.emailAddress === "support@example.com") {
          return JSON.stringify([{ id: "inbox_existing", email_address: "support@example.com" }])
        }
        return "[]"
      },
      db_insert: async (_e: string, d: string) => {
        inserted.push(JSON.parse(d))
        return JSON.stringify({ id: crypto.randomUUID(), ...JSON.parse(d) })
      },
      db_update: async (_e: string, id: string, d: string) => {
        updates.push({ id, data: JSON.parse(d) })
      },
      enqueueJob: async (n: string, p: string) => enqueued.push({ name: n, p: JSON.parse(p) }),
      emit: async () => {},
    }
    await fn(
      {
        orgId,
        data: {
          appName: "tickets",
          id: "ca_new",
          identifier: "support@example.com",
          connectionName: "gmail",
        },
      },
      ctx,
    )
    // No duplicate inbox created.
    expect(inserted).toHaveLength(0)
    // The existing inbox is rebound to the NEW account id and un-archived.
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe("inbox_existing")
    expect(updates[0].data).toMatchObject({
      archivedAt: null,
      emailAddress: "support@example.com",
      connectedAccountId: "ca_new",
    })
    // Account-id lookup runs first, email lookup only as the reconnect fallback.
    expect(findQueries[0]?.where).toMatchObject({ connectedAccountId: "ca_new" })
    expect(findQueries[1]?.where).toMatchObject({ emailAddress: "support@example.com" })
    // Initial sync is enqueued so the rebound inbox starts pulling mail again.
    expect(enqueued[0]?.name).toBe("gmail-initial-sync")
  })
})

describe("tickets.inbox.onDisconnected.archives", () => {
  it("invokes ticketsOnAccountDisconnected handler and archives the matching inbox", async () => {
    const fn = handlers.ticketsOnAccountDisconnected as unknown as TicketAccountHandler
    expect(typeof fn).toBe("function")
    const updates: any[] = []
    const emitted: any[] = []
    const ctx = {
      db_findMany: async () => JSON.stringify([{ id: "inbox_1" }]),
      db_insert: async () => "{}",
      db_update: async (_e: string, id: string, d: string) => {
        updates.push({ id, data: JSON.parse(d) })
      },
      enqueueJob: async () => {},
      emit: async (e: string) => emitted.push(JSON.parse(e)),
    }
    await fn({ orgId, data: { appName: "tickets", id: "ca_disc" } }, ctx)
    expect(updates[0]).toMatchObject({ id: "inbox_1" })
    expect(updates[0].data.archivedAt).toBeTruthy()
    expect(emitted[0]).toMatchObject({ entity: "inbox", action: "disconnect" })
  })

  it("ignores connected_account:disconnect when appName is not tickets", async () => {
    const fn = handlers.ticketsOnAccountDisconnected as unknown as TicketAccountHandler
    let called = 0
    const ctx = {
      db_findMany: async () => {
        called++
        return "[]"
      },
      db_insert: async () => "{}",
      db_update: async () => {},
      enqueueJob: async () => {},
      emit: async () => {},
    }
    await fn({ orgId, data: { appName: "mail", id: "ignore" } }, ctx)
    expect(called).toBe(0)
  })
})
