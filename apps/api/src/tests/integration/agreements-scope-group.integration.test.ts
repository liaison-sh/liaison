// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Scope check's contact group, through the real path: the agreements app registered from
// its manifest; enabling its routine template makes the app's own contact group once (named by
// its key) and stores the routine's sender filter with that group's id; the daily reconcile,
// run as a job in the sandbox, adds each signed agreement's client to the group through the
// declared `kernel:contacts_group_add`, as the person who sent the agreement; and the routine's
// filter passes that client's mail only when the receiving provider authenticated the sender.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { ownerMailSenderFilterMatches } from "~/infra/jobs/event-routine-gate"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { handleEnableRoutineTemplate } from "~/modules/agent/tools/skills-routines-tools"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { mintClientAction } from "~/modules/client-actions/mint"
import { insertAppRow } from "~/seed/factories/app-tables"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import {
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const SHA = "d".repeat(64)

let w: DoorWorld
let routineId = ""
let groupId = ""

function descriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "agreements", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "agreements",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

const adminCtx = () =>
  ({
    orgId: w.orgId,
    userId: w.admin.userId,
    actorType: "user",
    scopes: ["*"],
    approverUserId: w.admin.userId,
  }) as never

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  w = await createDoorWorld()
  await ensureAppsForOrg(w.orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], w.orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(w.orgId, 0)
}, 300_000)

afterAll(async () => {
  forgetOrgApps(w.orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await clearRedisPatterns(["ca:*"])
  if (w) {
    for (const t of ["routines", "contact_group_members", "contact_segments", "threads"])
      await sql`DELETE FROM ${kernel(t)} WHERE org_id = ${w.orgId}`
    await sql`UPDATE ${kernel("contacts")} SET owner_user_id = NULL WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("the Scope check's group of clients", () => {
  it("enabling the template makes the app's own group once and filters the routine on it", async () => {
    const res = (await handleEnableRoutineTemplate(
      { appName: "agreements", templateKey: "scope-check" },
      adminCtx(),
    )) as { routine?: Record<string, unknown>; error?: { code: string; message: string } }
    expect(res.error).toBeUndefined()
    const groups = (await sql`
      SELECT id::text AS id, name, kind FROM ${kernel("contact_segments")}
       WHERE org_id = ${w.orgId} AND system_key = 'agreements:clients-signed'`) as unknown as Array<{
      id: string
      name: string
      kind: string
    }>
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ name: "Clients under a signed agreement", kind: "manual" })
    groupId = groups[0]?.id ?? ""
    routineId = String(res.routine?.id ?? "")
    const [routine] = (await sql`
      SELECT event, event_filter FROM ${kernel("routines")} WHERE id = ${routineId}`) as unknown as Array<{
      event: string
      event_filter: { fromGroupIds?: string[] } | null
    }>
    expect(routine?.event).toBe("mail:message:create")
    expect(routine?.event_filter).toEqual({ fromGroupIds: [groupId] })
    // Enabled again (another person, or the same after a reset): still one group.
    await handleEnableRoutineTemplate(
      { appName: "agreements", templateKey: "scope-check" },
      adminCtx(),
    )
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM ${kernel("contact_segments")}
       WHERE org_id = ${w.orgId} AND system_key = 'agreements:clients-signed'`) as unknown as Array<{
      n: number
    }>
    expect(n).toBe(1)
  }, 120_000)

  it("the daily reconcile adds a signed agreement's client to the group, as the person who sent it", async () => {
    if (!groupId) throw new Error("the template was not enabled")
    const agreementId = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    await withPrivilegedDb(w.orgId, "test:scope-group-signed", async (tx) => {
      await insertAppRow(tx, "agreements", "agreements", {
        org_id: w.orgId,
        id: agreementId,
        number: "AG-2026-020",
        kind: "sow",
        status: "signed",
        title: "Website",
        company_id: w.companyA,
        contact_id: w.clientA.contactId,
        org_access: "editor",
        created_by_user_id: w.admin.userId,
      })
      await insertAppRow(tx, "agreements", "agreement_versions", {
        org_id: w.orgId,
        id: versionId,
        agreement_id: agreementId,
        number: 1,
        status: "signed",
        sha256: SHA,
        source_text: "1. Scope\nA website.",
        frozen_at: new Date().toISOString(),
      })
    })
    const minted = await mintClientAction({
      orgId: w.orgId,
      kind: "sign",
      targetApp: "agreements",
      targetType: "agreement_version",
      targetId: versionId,
      contactId: w.clientA.contactId,
      companyId: w.companyA,
      invitedEmail: w.clientA.email,
      invitedName: w.clientA.name,
      expiresInDays: 14,
      createdByUserId: w.admin.userId,
    })
    // As if the client had signed it.
    await sql`UPDATE ${kernel("client_actions")} SET decision = 'signed', decided_at = now()
               WHERE id = ${minted.id}`
    const handler = JobsTestAccess.getHandler("agreements", "scope-group-reconcile")
    if (!handler) throw new Error("scope-group-reconcile is not registered")
    await dispatchAppJobWithContext(
      handler,
      { orgId: w.orgId },
      { actorType: "system", orgId: w.orgId, purpose: "job", scopes: ["agreements:*"] },
      "session",
    )
    const members = (await sql`
      SELECT contact_id::text AS contact, added_by::text AS added_by
        FROM ${kernel("contact_group_members")}
       WHERE org_id = ${w.orgId} AND segment_id = ${groupId}::uuid`) as unknown as Array<{
      contact: string
      added_by: string | null
    }>
    expect(members).toEqual([{ contact: w.clientA.contactId, added_by: w.admin.userId }])
  }, 120_000)

  it("the routine's filter passes the client's mail only when its sender was authenticated", async () => {
    const owner: UserContext = {
      actorType: "user",
      userId: w.admin.userId,
      orgId: w.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const mail = (senderAuth: string, email = w.clientA.email) => ({
      app: "mail",
      entity: "message",
      action: "create",
      orgId: w.orgId,
      data: { direction: "inbound", from: { email }, senderAuth },
    })
    const filter = { fromGroupIds: [groupId] }
    expect(await ownerMailSenderFilterMatches(owner, filter, mail("pass"))).toBe(true)
    expect(await ownerMailSenderFilterMatches(owner, filter, mail("fail"))).toBe(false)
    expect(await ownerMailSenderFilterMatches(owner, filter, mail("none"))).toBe(false)
    expect(
      await ownerMailSenderFilterMatches(owner, filter, mail("pass", "someone@elsewhere.example")),
    ).toBe(false)
  }, 60_000)
})
