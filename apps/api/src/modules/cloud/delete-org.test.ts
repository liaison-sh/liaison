// SPDX-License-Identifier: FSL-1.1-ALv2
// `DELETE /api/cloud/orgs/:id` (S26) and the `PUT /orgs/:id/mail-sender`
// route, signed as Control signs them, against the real database:
//  - fences: active → 409 not_closed; closed < 25 days → closed_too_recently;
//    the operator org → operator_org; a running export → export_running;
//  - closed ≥ 25 days → `queued`, a ledger row with both waivers, the org marked
//    deleting; the same timerId again → the same deletion, no second row; the
//    deletion core run to completion → `done` and no residue;
//  - a closed org's DELETE via the cell host is accepted (outside the gate);
//  - 401 for an unsigned or mis-signed request on both endpoints.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { deriveControlToCellKey, signControlRequest } from "@liaison/control-plane-contract/node"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import { MANAGED_DELETION_WAIVER_REASONS } from "~/modules/cloud/delete-org"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { processOrgDeleteJob } from "~/modules/org/delete/job"
import { residueScan } from "~/modules/org/purge/residue"
import { seedOrgExport } from "~/seed/factories/org/platform-rows"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const INSTANCE_KEY = "f6".repeat(32)
const CONTROL_KEY = deriveControlToCellKey(INSTANCE_KEY)
const WRONG_KEY = deriveControlToCellKey("a7".repeat(32))
const TEMPLATE = "https://{slug}.cells.test"
const CELL = "https://cell-4-origin.cells.test"

const mutableEnv = env as {
  LIAISON_EDITION?: string
  LIAISON_ORG_HOST_TEMPLATE?: string
  LIAISON_OPERATOR_ORG_ID?: string
}
const saved = { ...mutableEnv }

const nowSec = () => Math.floor(Date.now() / 1000)
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

async function send(
  method: "POST" | "DELETE" | "PUT",
  path: string,
  body: unknown,
  opts: { key?: string; unsigned?: boolean } = {},
) {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (!opts.unsigned) {
    Object.assign(
      headers,
      signControlRequest(opts.key ?? CONTROL_KEY, {
        method,
        path,
        body: raw,
        messageId: randomUUID(),
        ts: nowSec(),
      }),
    )
  }
  return app.request(`${CELL}${path}`, { method, headers, body: raw })
}

async function createOrg(slug: string) {
  const res = await send("POST", "/api/cloud/orgs", {
    slug,
    name: `Org ${slug}`,
    ownerEmail: `owner@${slug}.test`,
    ownerName: "Owner",
    plan: "base",
    locale: "en",
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { orgId: string }).orgId
}

let version = 1
async function push(orgId: string, status: string, closedAt: string | null = null) {
  const res = await send("POST", `/api/cloud/orgs/${orgId}/billing`, {
    orgId,
    version: version++,
    plan: "base",
    status,
    periodEnd: "2026-12-01T00:00:00.000Z",
    includedCredits: "100",
    caps: {},
    previewEndsAt: null,
    autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
    accessUntil: null,
    closedAt,
    billingContact: "billing@control.test",
  })
  expect(res.status).toBe(200)
}

const del = (orgId: string, timerId: string, opts: { key?: string; unsigned?: boolean } = {}) =>
  send("DELETE", `/api/cloud/orgs/${orgId}`, { orgId, timerId }, opts)

async function ledgerRows(orgId: string) {
  return sql`SELECT id, status, operator, waivers FROM kernel.org_deletions
    WHERE deleted_org_id = ${orgId} ORDER BY created_at`
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  _setEdition(null)
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  const identity = {
    ...mintIdentity(),
    keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
    state: "registered" as const,
    registeredAt: new Date().toISOString(),
  }
  await withSystemDb("test-cloud-identity", (db) => writeIdentity(db, identity))
})

afterAll(async () => {
  mutableEnv.LIAISON_EDITION = saved.LIAISON_EDITION
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = saved.LIAISON_ORG_HOST_TEMPLATE
  mutableEnv.LIAISON_OPERATOR_ORG_ID = saved.LIAISON_OPERATOR_ORG_ID
  _setEdition(null)
  clearOrgBillingStatusCache()
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  await withSystemDb("test-cloud-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(async () => {
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_OPERATOR_ORG_ID = saved.LIAISON_OPERATOR_ORG_ID
  _setEdition(null)
  clearOrgBillingStatusCache()
  await clearRedisPatterns(["cloud:*"])
})

describe("401 matrix: the cloud endpoints", () => {
  test("unsigned or mis-signed DELETE and mail-sender PUT: 401, nothing changes", async () => {
    const orgId = await createOrg("del-matrix")
    for (const opts of [{ unsigned: true }, { key: WRONG_KEY }]) {
      expect((await del(orgId, "t-matrix", opts)).status).toBe(401)
      const put = await send(
        "PUT",
        `/api/cloud/orgs/${orgId}/mail-sender`,
        { orgId, version: 1, sender: null },
        opts,
      )
      expect(put.status).toBe(401)
    }
    expect(await ledgerRows(orgId)).toHaveLength(0)
  })

  test("mail-sender: validated, then applied (mail-sender.test.ts covers the rest)", async () => {
    const orgId = await createOrg("del-mailsender")
    const bad = await send("PUT", `/api/cloud/orgs/${orgId}/mail-sender`, { orgId, version: 0 })
    expect(bad.status).toBe(400)
    const ok = await send("PUT", `/api/cloud/orgs/${orgId}/mail-sender`, {
      orgId,
      version: 1,
      sender: null,
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, applied: true, version: 1 })
  })
})

describe("DELETE /orgs/:id fences", () => {
  test("active → 409 not_closed", async () => {
    const orgId = await createOrg("del-active")
    await push(orgId, "active")
    const res = await del(orgId, "t-active")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, code: "not_closed" })
    expect(await ledgerRows(orgId)).toHaveLength(0)
  })

  test("closed less than 25 days ago → 409 closed_too_recently", async () => {
    const orgId = await createOrg("del-recent")
    await push(orgId, "closed", daysAgo(24))
    const res = await del(orgId, "t-recent")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, code: "closed_too_recently" })
  })

  test("the operator org → 409 operator_org", async () => {
    const orgId = await createOrg("del-operator")
    await push(orgId, "closed", daysAgo(40))
    mutableEnv.LIAISON_OPERATOR_ORG_ID = orgId
    const res = await del(orgId, "t-operator")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, code: "operator_org" })
  })

  test("a running export → 409 export_running (retryable)", async () => {
    const orgId = await createOrg("del-export")
    await push(orgId, "closed", daysAgo(40))
    const [owner] = await sql`SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`
    await seedOrgExport({ orgId, status: "running", requestedBy: owner?.id })
    const res = await del(orgId, "t-export")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, code: "export_running" })
    await sql`DELETE FROM kernel.org_exports WHERE org_id = ${orgId}`
  })
})

describe("DELETE /orgs/:id of a closed org", () => {
  test("queued with both waivers, replay idempotent, then done with no residue", async () => {
    const orgId = await createOrg("del-closed")
    await push(orgId, "closed", daysAgo(31))

    const first = await del(orgId, "timer-del-1")
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, state: "queued" })
    const rows = await ledgerRows(orgId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.operator).toBe("control-plane:timer-del-1")
    const waivers = rows[0]?.waivers as Array<{ kind: string; reason?: string }>
    expect(waivers.map((w) => w.reason).sort()).toEqual(
      [MANAGED_DELETION_WAIVER_REASONS.export, MANAGED_DELETION_WAIVER_REASONS.legalArchive].sort(),
    )
    const [org] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${orgId}`
    expect(org?.deleting_at).not.toBeNull()

    const replay = await del(orgId, "timer-del-1")
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { state: string }).state).toBe("queued")
    expect(await ledgerRows(orgId)).toHaveLength(1)

    // The worker's run (the job this cell's worker would pick up).
    await processOrgDeleteJob(
      { deletionId: rows[0]?.id as string, targetOrgId: orgId },
      { sleep: async () => {} },
    )
    const done = await del(orgId, "timer-del-1")
    expect(await done.json()).toEqual({ ok: true, state: "done" })
    const residue = await residueScan(orgId)
    expect(residue.total).toBe(0)
    expect(residue.orgRow).toBe(false)
    const [after] = await ledgerRows(orgId)
    expect(after?.status).toBe("completed")
  }, 120_000)
})
