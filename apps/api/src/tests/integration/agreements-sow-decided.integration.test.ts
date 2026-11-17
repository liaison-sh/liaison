// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signed text's Knowledge copy, made from the app's decided handler through the real path:
// the agreements app registered from its manifest, a person's send minting the link, the
// client signing on the public page, and the decided handler run in the sandbox from the
// outbox as the app's system identity. The kernel writes and reads back the copy as the person
// who sent the agreement, under their own row security. A sender who can no longer write
// Knowledge, or is no longer active, gets no copy: the seal still completes and the
// agreement's activity says the copy was not made and why.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as dsql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { roleDimensionGrants } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { onEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { handleEnableRoutineTemplate } from "~/modules/agent/tools/skills-routines-tools"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertAppRow } from "~/seed/factories/app-tables"
import { grantScopesThroughRole } from "~/seed/factories/people/scoped-role"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import {
  CaptureProvider,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"
import { dropReadsWorld } from "~/tests/security/portal-doors/reads-world"
import { call, codeOf, tokenOf } from "../../../test-support/client-actions-kit"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SCOPES = ["agreements:agreements:read", "agreements:agreements:write"]
const mutableEnv = env as { LIAISON_TSA_URL?: string }
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const app = (table: string) => sql(`${schemaRef("app_agreements")}.${table}`)
const knowledge = (table: string) => sql(`${schemaRef("app_knowledge")}.${table}`)

let w: DoorWorld
const capture = new CaptureProvider()
let previousMail: EmailProvider
let prevTsa: string | undefined
let prevForce: string | undefined
const notMade: Array<{ orgId: string; entityId: string; data: Record<string, unknown> }> = []

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

type Out = { data?: Record<string, any>; error?: { code: string; message: string } }

async function asPerson(userId: string, tool: string, params: unknown): Promise<Out> {
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId: w.orgId,
    scopes: SCOPES,
    dimensionGrants: {},
  }
  return (await executeToolCore({
    toolName: `agreements:${tool}`,
    orgId: w.orgId,
    actor,
    params,
    origin: "human-ui",
  } as never)) as Out
}

async function mailTo(email: string, template: string, after: number) {
  for (let i = 0; i < 250; i++) {
    const m = capture.sent.find((x, n) => n >= after && x.to === email && x.template === template)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no ${template} mail to ${email}`)
}

/** One agreement sent by `sender` and signed by client A on the public page; the decided
 *  handler then runs from the outbox. `beforeSign` runs between the send and the signature. */
let signings = 0

async function sendAndSign(
  sender: string,
  title: string,
  beforeSign?: () => Promise<void>,
): Promise<{ agreementId: string; versionId: string }> {
  const created = await asPerson(sender, "agreement_create", {
    kind: "nda",
    title,
    company_id: w.companyA,
    source: { body: { blocks: [{ type: "paragraph", text: `${title}: the parties agree.` }] } },
  })
  expect(created.error).toBeUndefined()
  const agreementId = created.data?.agreement?.id as string
  const prepared = await asPerson(sender, "agreement_prepare", { id: agreementId })
  expect(prepared.error).toBeUndefined()
  const versionId = prepared.data?.version_id as string
  const before = capture.sent.length
  const sent = await asPerson(sender, "agreement_send", {
    version_id: versionId,
    sha256: prepared.data?.sha256 as string,
    order: "any",
    expires_in_days: 7,
    signers: [{ contact_id: w.clientA.contactId }],
  })
  expect(sent.data?.status).toBe("ok")
  if (beforeSign) await beforeSign()
  const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
  // One address per signing: the public surface's limit counts per address, and this file signs often.
  signings += 1
  const h = { "x-bun-socket-ip": `198.51.100.${90 + signings}` }
  expect((await call("open", { t: token }, h)).status).toBe(200)
  expect((await call("document", { t: token, format: "blocks" }, h)).status).toBe(200)
  await clearRedisPatterns(["ca:code:gap:*"])
  const codeAt = capture.sent.length
  expect((await call("code", { t: token }, h)).status).toBe(202)
  const code = codeOf(await mailTo(w.clientA.email, "client-action.code", codeAt))
  const verified = await call("verify", { t: token, code, name: w.clientA.name }, h)
  expect(verified.status).toBe(200)
  const { proof } = (await verified.json()) as { proof: string }
  const signed = await call(
    "decide",
    { t: token, proof, decision: "sign", typed_name: w.clientA.name },
    h,
  )
  expect(signed.status).toBe(200)
  await drainOutbox()
  return { agreementId, versionId }
}

async function versionRow(versionId: string) {
  const [v] = (await sql`
    SELECT status, knowledge_document_id FROM ${app("agreement_versions")}
     WHERE id = ${versionId}`) as unknown as Array<{
    status: string
    knowledge_document_id: string | null
  }>
  return v
}

async function projectsOf(agreementId: string) {
  return (await sql`
    SELECT id::text AS id, company_id::text AS company_id, owner_id::text AS owner_id,
           time_budgets_on
      FROM app_projects.projects
     WHERE org_id = ${w.orgId} AND external_ref = ${`agreement:${agreementId}`}`) as unknown as Array<{
    id: string
    company_id: string | null
    owner_id: string | null
    time_budgets_on: boolean
  }>
}

async function agreementProject(agreementId: string) {
  const [a] = (await sql`
    SELECT project_id::text AS project_id, project_time_budgets, project_timebox_minutes
      FROM ${app("agreements")}
     WHERE id = ${agreementId}`) as unknown as Array<{
    project_id: string | null
    project_time_budgets: boolean | null
    project_timebox_minutes: number | null
  }>
  return a
}

async function sealedPackage(versionId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT evidence_file_id FROM ${app("evidence_packages")}
     WHERE org_id = ${w.orgId} AND version_id = ${versionId}`) as unknown as Array<{
    evidence_file_id: string | null
  }>
  return Boolean(rows[0]?.evidence_file_id)
}

async function reads(userId: string, scopes: string[], documentId: string): Promise<number> {
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId: w.orgId,
    scopes,
    dimensionGrants: { "*": ["*"] },
  }
  return withRlsContext(actor, async (tx) => {
    const rows = extractRows<{ n: number }>(
      await tx.execute(
        dsql`SELECT count(*)::int AS n FROM app_knowledge.documents WHERE id = ${documentId}::uuid`,
      ),
    )
    return Number(rows[0]?.n ?? 0)
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  prevForce = process.env.RATE_LIMIT_FORCE_ENABLED
  process.env.RATE_LIMIT_FORCE_ENABLED = "true"
  prevTsa = mutableEnv.LIAISON_TSA_URL
  mutableEnv.LIAISON_TSA_URL = "https://tsa.example.test/"
  previousMail = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createDoorWorld()
  await ensureAppsForOrg(w.orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], w.orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(w.orgId, 0)
  // The admin holds every value of every dimension, as an owner does (Knowledge checks the
  // writer's sensitivity grant; the role API refuses a wildcard, so the grant row is written
  // directly). The member holds the agreements app and nothing of Knowledge.
  const { roleId: everyValue } = await grantScopesThroughRole(w.orgId, {
    adminUserId: w.admin.userId,
    userId: w.admin.userId,
    name: `every-dimension-${w.orgId.slice(0, 8)}`,
    scopes: [],
    dimensions: {},
  })
  await withPrivilegedDb(w.orgId, "test:owner-dimensions", async (tx) => {
    await tx
      .insert(roleDimensionGrants)
      .values({ roleId: everyValue, dimensionKey: "*", dimensionValues: ["*"] })
  })
  await grantScopesThroughRole(w.orgId, {
    adminUserId: w.admin.userId,
    userId: w.member.userId,
    name: `agreements-only-${w.orgId.slice(0, 8)}`,
    scopes: ["agreements:*"],
    dimensions: {},
  })
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
  onEvent(
    async (e) => {
      if (e.app === "agreements" && e.action === "knowledge_copy_not_made")
        notMade.push({
          orgId: String(e.orgId),
          entityId: String(e.entityId),
          data: (e.data ?? {}) as Record<string, unknown>,
        })
    },
    { delivery: "once", name: "test:sow-copy-not-made" },
  )
}, 300_000)

afterAll(async () => {
  await rebuildFilesSelectPolicy()
  forgetOrgApps(w.orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  setSystemEmailProvider(previousMail)
  mutableEnv.LIAISON_TSA_URL = prevTsa
  if (prevForce === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
  else process.env.RATE_LIMIT_FORCE_ENABLED = prevForce
  await clearRedisPatterns(["ca:*"])
  if (w) {
    await sql`DELETE FROM ${kernel("resource_grants")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${knowledge("documents")} WHERE org_id = ${w.orgId}`
    for (const t of [
      "routines",
      "contact_group_members",
      "contact_segments",
      "thread_participants",
      "threads",
    ])
      await sql`DELETE FROM ${kernel(t)} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${kernel("attention_events")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    await dropReadsWorld(w)
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("the signed text's Knowledge copy from the decided handler", () => {
  it("is written as the person who sent it, closed to the organization, and read back by them only", async () => {
    const { versionId } = await sendAndSign(w.admin.userId, "Written as the sender")
    expect(await sealedPackage(versionId)).toBe(true)
    const v = await versionRow(versionId)
    expect(v?.status).toBe("signed")
    const documentId = v?.knowledge_document_id ?? ""
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/)
    const [doc] = (await sql`
      SELECT created_by, org_access, body FROM ${knowledge("documents")}
       WHERE id = ${documentId}`) as unknown as Array<{
      created_by: string
      org_access: string
      body: string | null
    }>
    expect(doc?.created_by).toBe(w.admin.userId)
    expect(doc?.org_access).toBe("none")
    expect(await reads(w.admin.userId, ["knowledge:*"], documentId)).toBe(1)
    expect(await reads(w.member.userId, ["*"], documentId)).toBe(0)
  }, 120_000)

  it("a sender who cannot write Knowledge gets no copy; the seal completes and the activity says why", async () => {
    const before = notMade.length
    const { agreementId, versionId } = await sendAndSign(w.member.userId, "No Knowledge scope")
    expect(await sealedPackage(versionId)).toBe(true)
    expect((await versionRow(versionId))?.knowledge_document_id ?? null).toBeNull()
    const said = notMade.slice(before).filter((e) => e.entityId === agreementId)
    expect(said.length).toBe(1)
    expect(said[0]?.data.code).toBe("SENDER_CANNOT_WRITE_KNOWLEDGE")
    expect(String(said[0]?.data.reason)).toContain("not made")
  }, 120_000)

  it("a sender no longer active gets no copy; the seal completes and the activity says why", async () => {
    const before = notMade.length
    try {
      const { agreementId, versionId } = await sendAndSign(
        w.admin.userId,
        "Sender gone",
        async () => {
          await sql`UPDATE ${kernel("users")} SET status = 'deactivated' WHERE id = ${w.admin.userId}`
        },
      )
      expect(await sealedPackage(versionId)).toBe(true)
      expect((await versionRow(versionId))?.knowledge_document_id ?? null).toBeNull()
      const said = notMade.slice(before).filter((e) => e.entityId === agreementId)
      expect(said.map((e) => e.data.code)).toEqual(["SENDER_INACTIVE"])
    } finally {
      await sql`UPDATE ${kernel("users")} SET status = 'active' WHERE id = ${w.admin.userId}`
    }
  }, 120_000)

  it("on a closed agreement, the sender reads the copy through the list only: taken off it, they read nothing of it", async () => {
    const { agreementId, versionId } = await sendAndSign(
      w.admin.userId,
      "Closed to the list",
      async () => {
        await sql`UPDATE ${app("agreements")} SET org_access = 'none'
                   WHERE org_id = ${w.orgId} AND title = 'Closed to the list'`
        const [a] = (await sql`SELECT id FROM ${app("agreements")}
                   WHERE org_id = ${w.orgId} AND title = 'Closed to the list'`) as unknown as Array<{
          id: string
        }>
        await withPrivilegedDb(w.orgId, "test:sow-copy-list", async (tx) => {
          await insertAppRow(tx, "agreements", "agreement_shares", {
            org_id: w.orgId,
            agreement_id: a?.id ?? "",
            user_id: w.admin.userId,
            role: "editor",
          })
        })
      },
    )
    const documentId = (await versionRow(versionId))?.knowledge_document_id ?? ""
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/)
    const [doc] = (await sql`
      SELECT created_by, author_reads FROM ${knowledge("documents")} WHERE id = ${documentId}`) as unknown as Array<{
      created_by: string
      author_reads: boolean
    }>
    expect(doc?.created_by).toBe(w.admin.userId)
    expect(doc?.author_reads).toBe(false)
    expect(await reads(w.admin.userId, ["knowledge:*"], documentId)).toBe(1)
    await sql`UPDATE ${app("agreement_shares")} SET removed_at = now()
               WHERE agreement_id = ${agreementId} AND user_id = ${w.admin.userId}`
    await withPrivilegedDb(w.orgId, "test:sow-copy-follow", async (tx) => {
      await tx.execute(
        dsql`SELECT kernel.restricted_access_follow(${w.orgId}::uuid, 'agreements.agreement', ${agreementId}::uuid)`,
      )
    })
    expect(await reads(w.admin.userId, ["*"], documentId)).toBe(0)
  }, 120_000)
  it("on an open agreement, whoever enabled the Scope check routine also reads the copy", async () => {
    const enabled = (await handleEnableRoutineTemplate(
      { appName: "agreements", templateKey: "scope-check" },
      {
        orgId: w.orgId,
        userId: w.admin.userId,
        actorType: "user",
        scopes: ["*"],
        approverUserId: w.admin.userId,
      } as never,
    )) as { routine?: { id: string }; error?: unknown }
    expect(enabled.error).toBeUndefined()
    // Owned by a colleague who did not send the agreement.
    await sql`UPDATE ${kernel("routines")} SET owner_user_id = ${w.member.userId}
               WHERE id = ${enabled.routine?.id ?? ""}`
    const { versionId } = await sendAndSign(
      w.admin.userId,
      "Read by the routine owner",
      async () => {
        await sql`UPDATE ${app("agreements")} SET org_access = 'viewer'
                 WHERE org_id = ${w.orgId} AND title = 'Read by the routine owner'`
      },
    )
    const documentId = (await versionRow(versionId))?.knowledge_document_id ?? ""
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/)
    const grants = (await sql`
      SELECT grantee::text AS grantee FROM ${kernel("resource_grants")}
       WHERE org_id = ${w.orgId} AND resource_type = 'knowledge.document'
         AND resource_id = ${documentId}::uuid AND grantee_kind = 'user'`) as unknown as Array<{
      grantee: string
    }>
    expect(grants.map((g) => g.grantee)).toContain(w.member.userId)
    await sql`DELETE FROM ${kernel("routines")} WHERE id = ${enabled.routine?.id ?? ""}`
  }, 120_000)
})

describe("a signed statement of work starts its project from the decided handler", () => {
  it("one project for the agreement, made as the person who approved the send; a proposal with a timebox starts it with time and budgets on and the timebox as its plan", async () => {
    const { agreementId } = await sendAndSign(w.admin.userId, "Statement of work", async () => {
      await sql`UPDATE ${app("agreements")} SET kind = 'proposal', hours_minutes = 2400
                 WHERE org_id = ${w.orgId} AND title = 'Statement of work'`
    })
    // The send was the admin's own click: every action of it names them as its approver.
    const approvers = (await sql`
      SELECT DISTINCT approved_by_user_id::text AS id FROM ${kernel("client_actions")}
       WHERE org_id = ${w.orgId} AND target_id IN (
         SELECT id FROM ${app("agreement_versions")} WHERE agreement_id = ${agreementId})`) as unknown as Array<{
      id: string | null
    }>
    expect(approvers.map((r) => r.id)).toEqual([w.admin.userId])
    const projects = await projectsOf(agreementId)
    expect(projects).toHaveLength(1)
    expect(projects[0]?.company_id).toBe(w.companyA)
    expect(projects[0]?.owner_id).toBe(w.admin.userId)
    // The approved send is that person's act: projects takes time and budgets from it.
    expect(projects[0]?.time_budgets_on).toBe(true)
    const [plan] = (await sql`
      SELECT timebox_minutes FROM app_projects.project_time_plan
       WHERE org_id = ${w.orgId} AND project_id = ${projects[0]?.id ?? ""}::uuid`) as unknown as Array<{
      timebox_minutes: number | null
    }>
    expect(plan?.timebox_minutes).toBe(2400)
    const a = await agreementProject(agreementId)
    expect(a?.project_id).toBe(projects[0]?.id ?? "")
    expect(a?.project_time_budgets).toBe(true)
    expect(a?.project_timebox_minutes).toBe(2400)
    // The seal retry, run again, makes no second project.
    await drainOutbox()
    expect(await projectsOf(agreementId)).toHaveLength(1)
  }, 120_000)

  it("a send no person approved starts its project with time and budgets off, and the agreement records that", async () => {
    const { agreementId } = await sendAndSign(w.admin.userId, "Sent by nobody", async () => {
      await sql`UPDATE ${app("agreements")} SET kind = 'sow', hours_minutes = 2400
                 WHERE org_id = ${w.orgId} AND title = 'Sent by nobody'`
      // A send no person approved: its actions name no approver, so its calls stay the system's.
      await sql`UPDATE ${kernel("client_actions")} SET approved_by_user_id = NULL
                 WHERE org_id = ${w.orgId} AND target_id IN (
                   SELECT v.id FROM ${app("agreement_versions")} v
                     JOIN ${app("agreements")} g ON g.id = v.agreement_id
                    WHERE g.org_id = ${w.orgId} AND g.title = 'Sent by nobody')`
    })
    const projects = await projectsOf(agreementId)
    expect(projects).toHaveLength(1)
    // Made as its sender, on no person's act: projects keeps time and budgets off.
    expect(projects[0]?.owner_id).toBe(w.admin.userId)
    expect(projects[0]?.time_budgets_on).toBe(false)
    const a = await agreementProject(agreementId)
    expect(a?.project_id).toBe(projects[0]?.id ?? "")
    expect(a?.project_time_budgets).toBe(false)
    expect(a?.project_timebox_minutes).toBeNull()
  }, 120_000)

  it("signing adds the client to the Scope check's group, as the sender", async () => {
    const enabled = (await handleEnableRoutineTemplate(
      { appName: "agreements", templateKey: "scope-check" },
      {
        orgId: w.orgId,
        userId: w.admin.userId,
        actorType: "user",
        scopes: ["*"],
        approverUserId: w.admin.userId,
      } as never,
    )) as { routine?: { id: string }; error?: unknown }
    expect(enabled.error).toBeUndefined()
    const [group] = (await sql`
      SELECT id::text AS id FROM ${kernel("contact_segments")}
       WHERE org_id = ${w.orgId} AND system_key = 'agreements:clients-signed'`) as unknown as Array<{
      id: string
    }>
    expect(group?.id).toMatch(/^[0-9a-f-]{36}$/)
    await sendAndSign(w.admin.userId, "Signed with a client", async () => {
      await sql`UPDATE ${app("agreements")} SET contact_id = ${w.clientA.contactId}
                 WHERE org_id = ${w.orgId} AND title = 'Signed with a client'`
    })
    const members = (await sql`
      SELECT contact_id::text AS contact_id FROM ${kernel("contact_group_members")}
       WHERE org_id = ${w.orgId} AND segment_id = ${group?.id ?? ""}::uuid`) as unknown as Array<{
      contact_id: string
    }>
    expect(members.map((m) => m.contact_id)).toContain(w.clientA.contactId)
    await sql`DELETE FROM ${kernel("routines")} WHERE id = ${enabled.routine?.id ?? ""}`
  }, 120_000)
})
