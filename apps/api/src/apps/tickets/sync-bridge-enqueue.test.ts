// SPDX-License-Identifier: FSL-1.1-ALv2
// Pins the tickets_runSync bridge ctx's enqueueJob to a REAL enqueue.
//
// gmailIncrementalSync self-heals a missing history cursor by enqueueing
// `gmail-initial-sync` (the designed poll-only fallback when GMAIL_PUBSUB_TOPIC
// is unset and users.watch never seeds a cursor). The bridge ctx used to pass
// `enqueueJob: async () => {}`, so that fallback silently enqueued nothing and
// a reconnected mailbox never ingested again (prod support mailbox outage,
// 2026-07-10). This test drives the REAL bridge (createRpcBridge ->
// tickets_runSync) against a cursorless account and asserts the initial-sync
// job actually reaches the app-tickets queue worker.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { JobsTestAccess, registerJobWorker } from "~/infra/jobs/jobs"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

let orgId: string
let userId: string
let accountId: string

beforeAll(async () => {
  const slug = `sync-enq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("sync-bridge-enqueue-fixture", async (tx) => {
    const rows = (r: unknown): any[] => extractRows<any>(r as never)
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Sync Enqueue Test', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h') RETURNING id`),
    )[0].id
    // Active gmail account with NO gmail.historyId cursor in metadata --
    // exactly the post-reconnect state when users.watch failed to seed one.
    accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type,
           identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2',
                ${`support-${slug}@x.test`}, 'active', ${userId},
                ${encryptSecret("tok", env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)})
        RETURNING id`),
    )[0].id
  })
})

afterAll(async () => {
  JobsTestAccess.setOrgEnsure(undefined)
  await withSystemDb("sync-bridge-enqueue-cleanup", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
  })
})

describe("tickets_runSync bridge ctx enqueueJob", () => {
  it("no-cursor incremental sync enqueues a REAL gmail-initial-sync job (not a no-op)", async () => {
    // Capture the job through the real BullMQ worker path. registerJobWorker
    // also satisfies enqueueAppJob's registered-handler guard.
    const captured: Array<Record<string, unknown>> = []
    // The dispatcher sets the job's org up before it looks the handler up
    // (on-demand org setup), and registering the org's tickets app would put
    // the app's own gmail-initial-sync handler back in place of this one.
    JobsTestAccess.setOrgEnsure(async () => {})
    registerJobWorker<Record<string, unknown>>("tickets", "gmail-initial-sync", async (payload) => {
      captured.push(payload)
    })

    const result = await withRlsContext(
      {
        actorType: "user",
        userId,
        orgId,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        const bridge = createRpcBridge(
          "tickets",
          "system:test",
          orgId,
          tx,
          ticketsManifest as never,
          ["*"],
          "system",
        ) as unknown as {
          tickets_runSync: (jobName: string, connectedAccountId: string) => Promise<string>
        }
        return JSON.parse(await bridge.tickets_runSync("gmail-incremental-sync", accountId))
      },
    )

    // The sync itself reports the missing cursor...
    expect(result).toMatchObject({
      processed: 0,
      dropped: [{ reason: "no_cursor", count: 1 }],
    })

    // ...and the self-heal job must ACTUALLY arrive at the worker with the
    // trusted orgId pinned. A no-op enqueueJob leaves `captured` empty forever.
    const deadline = Date.now() + 10_000
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[0]).toMatchObject({ orgId, connectedAccountId: accountId })
  }, 30_000)
})
