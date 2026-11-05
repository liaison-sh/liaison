// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/mailbox-keys/integrity-alarm-cleared, against the real audit table.
//
// The browser clears its own downgrade alarm after the owner proves the mailbox
// secret; this route only RECORDS that it happened. Pinned here:
//   * an unauthenticated call is refused by the real app's auth layer,
//   * an authenticated call writes one audit row, actor = the caller, carrying
//     the cleared finding kinds, subject ids and a timestamp,
//   * a body with no findings is refused, so an empty clear leaves no row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { type AppEnv, app as fullApp } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { errorHandler } from "~/middleware/error-handler"
import { mailboxKeysRoutes } from "~/modules/mailbox-keys/routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const PATH = "/api/mailbox-keys/integrity-alarm-cleared"

const FINDINGS = [
  {
    kind: "unopenable-seal",
    subject: "11111111-1111-4111-8111-111111111111",
    detectedAt: "2026-09-24T10:00:00.000Z",
  },
  {
    kind: "ledger-chain-broken",
    subject: "ledger",
    detectedAt: "2026-09-24T10:00:01.000Z",
  },
]

function appFor(user: minimal.Person): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    // Every mailbox-keys route needs the mail read scope (MAILBOX_KEYS_SCOPE).
    c.set("scopes", ["mail:*"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox-keys", mailboxKeysRoutes)
  app.onError(errorHandler)
  return app
}

function post(app: Hono<AppEnv>, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

async function auditRows(userId: string) {
  return withSystemDb(
    "alarm-cleared-test-audit",
    async (tx) =>
      (await tx.execute(drizzleSql`
      SELECT actor_id::text AS actor_id, actor_type, entity_type, entity_id::text AS entity_id,
             metadata
        FROM kernel.audit_log
       WHERE action = 'mailbox_integrity_alarm_cleared' AND actor_id = ${userId}::uuid`)) as Array<{
        actor_id: string
        actor_type: string
        entity_type: string
        entity_id: string
        metadata: {
          clearedAt: string
          count: number
          kinds: string[]
          findings: Array<{ kind: string; subject: string; detectedAt: string | null }>
        }
      }>,
  )
}

describe("POST /api/mailbox-keys/integrity-alarm-cleared", () => {
  test("refuses an unauthenticated call", async () => {
    const res = await fullApp.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ findings: FINDINGS }),
    })
    expect(res.status).toBe(401)
  })

  test("records the cleared findings in the audit trail, actor = the caller", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const before = Date.now()
    const res = await post(appFor(user), { findings: FINDINGS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { recorded: boolean; clearedAt: string } }
    expect(body.data.recorded).toBe(true)

    const rows = await auditRows(user.id)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.actor_id).toBe(user.id)
    expect(row.actor_type).toBe("user")
    expect(row.entity_type).toBe("mailbox")
    expect(row.entity_id).toBe(user.id)
    expect(row.metadata.count).toBe(2)
    expect(row.metadata.kinds.sort()).toEqual(["ledger-chain-broken", "unopenable-seal"])
    expect(row.metadata.findings).toEqual(FINDINGS)
    expect(Date.parse(row.metadata.clearedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(row.metadata.clearedAt).toBe(body.data.clearedAt)
  })

  test("refuses a clear with no findings and writes nothing", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const res = await post(appFor(user), { findings: [] })
    expect(res.status).toBe(400)
    expect(await auditRows(user.id)).toHaveLength(0)
  })
})
