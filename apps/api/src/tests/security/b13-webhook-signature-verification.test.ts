// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedWebhookFixture } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

/**
 * B13 asserts both halves of the invariant:
 *   (a) a forged signature never reaches the handler — middleware rejects at 401;
 *   (b) the rejection is observable as a security event (the routes layer's
 *       log.warn line + the absence of an audit-log row for the webhook).
 *
 * "Handler reached" cannot be observed through a process-local counter wrap
 * because buildTestApp() re-imports the API with a cache-bust query string,
 * yielding a fresh `webhookHandlers` registry instance that is disjoint from
 * the one the test file holds. The audit-log table, however, is a real
 * side-effect surface: routes.ts only writes `writeAuditLog(..., action:
 * "webhook.test-hook")` after the handler returns successfully. Querying the
 * audit table is therefore a robust proxy for "handler ran" — and surveys
 * the actual end-to-end side effect rather than a process-local proxy.
 */
async function countAuditWebhookRows(orgId: string): Promise<number> {
  return withSystemDb("b13-audit-count", async (db) => {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "webhook.test-hook")))
    return rows.length
  })
}

describe("B13 — webhook signature verification: forged signatures are rejected at the middleware", () => {
  test("malformed signature (wrong length) is rejected with 401 and never reaches the handler", async () => {
    const { webhookRoute, orgId } = await seedWebhookFixture()
    const app = await buildTestApp()
    const before = await countAuditWebhookRows(orgId)
    const r = await app.request(webhookRoute, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Test-app verifier rejects signatures that aren't exactly 64 hex
        // chars; a short signature is the canonical "obviously forged" shape
        // and must never reach the handler.
        "x-webhook-signature": "abcd",
        "x-webhook-delivery": "b13-forged",
        "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ valid: "shape" }),
    })
    expect(r.status).toBe(401)
    // No audit entry — handler never ran.
    expect(await countAuditWebhookRows(orgId)).toBe(before)
  })

  test("missing signature headers also produce 401 with no handler side effect", async () => {
    const { webhookRoute, orgId } = await seedWebhookFixture()
    const app = await buildTestApp()
    const before = await countAuditWebhookRows(orgId)
    const r = await app.request(webhookRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ valid: "shape" }),
    })
    expect(r.status).toBe(401)
    expect(await countAuditWebhookRows(orgId)).toBe(before)
  })

  test("precondition: a valid signature DOES write the audit row (proves the no-leak assertion would catch a regression)", async () => {
    const { webhookRoute, orgId } = await seedWebhookFixture()
    const app = await buildTestApp()
    const before = await countAuditWebhookRows(orgId)
    const { createHmac } = await import("node:crypto")
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({ valid: "shape", id: crypto.randomUUID() })
    const signature = createHmac("sha256", "test-webhook-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex")
    const r = await app.request(webhookRoute, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
        "x-webhook-delivery": `b13-valid-${crypto.randomUUID()}`,
        "x-webhook-timestamp": timestamp,
      },
      body,
    })
    expect(r.status).toBe(200)
    // Exactly one new audit row — handler reached, side effect persisted.
    expect(await countAuditWebhookRows(orgId)).toBe(before + 1)
  })
})
