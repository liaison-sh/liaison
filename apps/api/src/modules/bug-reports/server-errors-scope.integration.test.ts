// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bug report filed by an org that is not the instance operator's must not
// carry the instance-wide server error signatures into its local ticket: on a
// multi-tenant server those errors come from every org. The forward snapshot
// already follows this rule (liaison-team/snapshot.ts); the local ticket body
// must follow it too.

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import * as realObjectStorage from "~/infra/storage/object-storage"
import { createTestOrg } from "~/tests/helpers/org"

const realObjectStorageModule = { ...realObjectStorage }
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async () => {},
}))

const { randomUUID } = await import("node:crypto")
const { app } = await import("~/app")
const { sql } = await import("~/db")
const { env } = await import("~/lib/env")
const { ErrorTrackerTestAccess, trackError } = await import("~/lib/error-tracker")
const { resetOperatorOrgCache } = await import("~/modules/apps/operator-org")
const minimal = await import("~/seed/tiers/minimal")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

const mutableEnv = env as unknown as Record<string, string | undefined>
const savedOperator = env.LIAISON_OPERATOR_ORG_ID

describe("bug report ticket: server errors stay with the operator org", () => {
  let token: string
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    const session = await minimal.session((await createTestOrg()).id)
    token = session.bearer
    orgId = session.orgId
    // Another org runs the instance: the reporter's org is a tenant.
    mutableEnv.LIAISON_OPERATOR_ORG_ID = randomUUID()
  }, 60_000)

  afterAll(async () => {
    mutableEnv.LIAISON_OPERATOR_ORG_ID = savedOperator
    resetOperatorOrgCache()
    mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
    await releaseTestLock()
  })

  it("a tenant's report does not include another tenant's server error", async () => {
    ErrorTrackerTestAccess.reset()
    // An error raised while serving a different org (its words survive the normaliser).
    trackError(new Error("invoice export failed for customer Brightwater Holdings"))

    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: "The page is blank" }),
    })
    expect(res.status).toBe(200)
    const ticketId = ((await res.json()) as { data: { ticketId: string } }).data.ticketId
    const [message] = await sql<{ text_body: string }[]>`
      SELECT text_body FROM app_tickets.messages
       WHERE ticket_id = ${ticketId}::uuid ORDER BY created_at ASC LIMIT 1`
    expect(message?.text_body).toContain("The page is blank")
    expect(message?.text_body).not.toContain("Brightwater Holdings")
    expect(message?.text_body).not.toContain("Server error signatures")
  })

  it("the operator org's report still carries the server errors", async () => {
    mutableEnv.LIAISON_OPERATOR_ORG_ID = orgId
    resetOperatorOrgCache()
    ErrorTrackerTestAccess.reset()
    trackError(new Error("nightly sync failed for mailbox Harbourline"))

    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: "Sync looks stuck" }),
    })
    expect(res.status).toBe(200)
    const ticketId = ((await res.json()) as { data: { ticketId: string } }).data.ticketId
    const [message] = await sql<{ text_body: string }[]>`
      SELECT text_body FROM app_tickets.messages
       WHERE ticket_id = ${ticketId}::uuid ORDER BY created_at ASC LIMIT 1`
    expect(message?.text_body).toContain("Server error signatures")
    expect(message?.text_body).toContain("Harbourline")
  })
})
