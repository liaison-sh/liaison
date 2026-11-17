// SPDX-License-Identifier: FSL-1.1-ALv2
//
// change_request_send through the real path: the agreements app registered from its manifest,
// a person's own call in the sandbox, the change request frozen by the host renderer, its
// approval link minted by the kernel, and the reply as the declared mail call. When the reply
// cannot leave (here: the person has no mailbox for that conversation), the kernel withdraws
// the link in the same call and the change request stays a draft: nothing reaches the client.
// Approved on its link with the code, the change request is a recorded approval sealed like a
// signature, accepted, and its parent's amended total rises by its price; its parent's project
// then gets one milestone task, made as the person who sent the change request.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createProject } from "~/apps/projects/service/create-project"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { mintClientAction } from "~/modules/client-actions/mint"
import { insertAppRow } from "~/seed/factories/app-tables"
import { asUser } from "~/seed/factories/people/actors"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import {
  CaptureProvider,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"
import { call, codeOf, tokenOf } from "../../../test-support/client-actions-kit"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SCOPES = ["agreements:agreements:read", "agreements:agreements:write", "mail:*"]
const mutableEnv = env as { LIAISON_TSA_URL?: string }
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const app = (table: string) => sql(`${schemaRef("app_agreements")}.${table}`)
const SHA = "c".repeat(64)
let crId = ""
let crVersionId = ""

async function mailTo(email: string, template: string, after: number) {
  for (let i = 0; i < 250; i++) {
    const m = capture.sent.find((x, n) => n >= after && x.to === email && x.template === template)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no ${template} mail to ${email}`)
}

let w: DoorWorld
let parentId = ""
let versionId = ""
let projectId = ""
const capture = new CaptureProvider()
let previousMail: EmailProvider
let prevTsa: string | undefined

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

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
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
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
  parentId = crypto.randomUUID()
  versionId = crypto.randomUUID()
  const owner: UserContext = {
    actorType: "user",
    userId: w.admin.userId,
    orgId: w.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  }
  projectId = await asUser(owner, async (tx) => {
    const made = await createProject({
      tx: tx as never,
      orgId: w.orgId,
      actor: owner,
      input: { name: "Website", key: "WEB" },
    })
    return made.id
  })
  await withPrivilegedDb(w.orgId, "test:change-request-parent", async (tx) => {
    await insertAppRow(tx, "agreements", "agreements", {
      org_id: w.orgId,
      id: parentId,
      number: "AG-2026-014",
      kind: "sow",
      status: "signed",
      title: "Website",
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      currency: "EUR",
      price_minor: "4200000",
      project_id: projectId,
      org_access: "editor",
      created_by_user_id: w.admin.userId,
    })
    await insertAppRow(tx, "agreements", "agreement_versions", {
      org_id: w.orgId,
      id: versionId,
      agreement_id: parentId,
      number: 1,
      status: "signed",
      sha256: SHA,
      source_text:
        "1. Scope\nA website in two languages.\n8.2 Extra work is billed at 100.00 EUR per hour.",
      frozen_at: new Date().toISOString(),
    })
  })
}, 300_000)

afterAll(async () => {
  await rebuildFilesSelectPolicy()
  forgetOrgApps(w.orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  setSystemEmailProvider(previousMail)
  mutableEnv.LIAISON_TSA_URL = prevTsa
  await clearRedisPatterns(["ca:*"])
  if (w) {
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    for (const t of ["tasks", "projects"])
      await sql`DELETE FROM ${sql(`${schemaRef("app_projects")}.${t}`)} WHERE org_id = ${w.orgId}`
    for (const t of ["thread_participants", "threads"])
      await sql`DELETE FROM ${kernel(t)} WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("a change request sent through the sandbox", () => {
  it("a reply that cannot leave withdraws the approval link the kernel minted, and the change request stays a draft", async () => {
    const out = await asPerson(w.admin.userId, "change_request_send", {
      parent_agreement_id: parentId,
      title: "Single sign-on",
      work: ["Sign-in with the client's identity provider"],
      hours_minutes: 3600,
      hours_source: "past similar work",
      rate_minor: "10000",
      reply: { conversation_id: crypto.randomUUID(), body: "Here is a change request." },
      passage: { version_id: versionId, section: "8.2" },
      mail_message_id: "mail-1",
    })
    // The call answers the mail's refusal, named, and says the link was withdrawn.
    const message = String(out.error?.message ?? out.data?.error?.message ?? "")
    expect(message).toContain("was withdrawn")
    const crs = (await sql`
      SELECT id, number, status, price_minor::text AS price, hours_minutes FROM ${app("agreements")}
       WHERE org_id = ${w.orgId} AND parent_agreement_id = ${parentId}`) as unknown as Array<{
      id: string
      number: string
      status: string
      price: string
      hours_minutes: number
    }>
    expect(crs).toHaveLength(1)
    expect(crs[0]).toMatchObject({
      number: "CR-1",
      status: "draft",
      price: "600000",
      hours_minutes: 3600,
    })
    const [v] = (await sql`
      SELECT id, status FROM ${app("agreement_versions")} WHERE agreement_id = ${crs[0]?.id}`) as unknown as Array<{
      id: string
      status: string
    }>
    expect(v?.status).toBe("frozen")
    crId = crs[0]?.id ?? ""
    crVersionId = v?.id ?? ""
    const links = (await sql`
      SELECT kind, revoked_at IS NOT NULL AS revoked FROM ${kernel("client_actions")}
       WHERE org_id = ${w.orgId} AND target_id = ${v?.id}::uuid`) as unknown as Array<{
      kind: string
      revoked: boolean
    }>
    expect(links.length).toBeGreaterThan(0)
    expect(links.every((l) => l.kind === "approve" && l.revoked)).toBe(true)
  }, 120_000)

  it("approved on its link with the code, it is a recorded approval sealed like a signature, the parent's total rises by its price, and its project gets the task as its sender", async () => {
    // As if the reply had left: the change request waits for its client.
    await sql`UPDATE ${app("agreements")} SET status = 'sent' WHERE id = ${crId}`
    const before = capture.sent.length
    await mintClientAction({
      orgId: w.orgId,
      kind: "approve",
      targetApp: "agreements",
      targetType: "agreement_version",
      targetId: crVersionId,
      contactId: w.clientA.contactId,
      companyId: w.companyA,
      invitedEmail: w.clientA.email,
      invitedName: w.clientA.name,
      expiresInDays: 14,
      createdByUserId: w.admin.userId,
    })
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const h = { "x-bun-socket-ip": "198.51.100.92" }
    expect((await call("open", { t: token }, h)).status).toBe(200)
    expect((await call("document", { t: token, format: "blocks" }, h)).status).toBe(200)
    await clearRedisPatterns(["ca:code:gap:*"])
    const codeAt = capture.sent.length
    expect((await call("code", { t: token }, h)).status).toBe(202)
    const code = codeOf(await mailTo(w.clientA.email, "client-action.code", codeAt))
    const verified = await call("verify", { t: token, code, name: w.clientA.name }, h)
    expect(verified.status).toBe(200)
    const { proof } = (await verified.json()) as { proof: string }
    const approved = await call(
      "decide",
      { t: token, proof, decision: "approve", typed_name: w.clientA.name },
      h,
    )
    expect(approved.status).toBe(200)
    await drainOutbox()
    const [cr] = (await sql`
      SELECT status FROM ${app("agreements")} WHERE id = ${crId}`) as unknown as Array<{
      status: string
    }>
    expect(cr?.status).toBe("accepted")
    const [parent] = (await sql`
      SELECT amended_total_minor::text AS total FROM ${app("agreements")} WHERE id = ${parentId}`) as unknown as Array<{
      total: string | null
    }>
    expect(parent?.total).toBe("4800000")
    const events = (await sql`
      SELECT level FROM ${app("signature_events")} WHERE version_id = ${crVersionId}`) as unknown as Array<{
      level: string
    }>
    expect(events.map((e) => e.level)).toEqual(["recorded_approval"])
    const [pkg] = (await sql`
      SELECT level FROM ${app("evidence_packages")} WHERE version_id = ${crVersionId}`) as unknown as Array<{
      level: string
    }>
    expect(pkg?.level).toBe("recorded_approval")
    // The work follows: one milestone task in the parent's project, made by the person who sent
    // the change request (never a system identity), recorded on the change request.
    const tasks = (await sql`
      SELECT id::text AS id, title, created_by::text AS created_by
        FROM ${sql(`${schemaRef("app_projects")}.tasks`)}
       WHERE org_id = ${w.orgId} AND project_id = ${projectId}::uuid`) as unknown as Array<{
      id: string
      title: string
      created_by: string | null
    }>
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: "CR-1: Single sign-on", created_by: w.admin.userId })
    const [effects] = (await sql`
      SELECT effects_task_id::text AS task, effects_done_at IS NOT NULL AS done, effects_note AS note
        FROM ${app("agreements")} WHERE id = ${crId}`) as unknown as Array<{
      task: string | null
      done: boolean
      note: string | null
    }>
    expect(effects).toMatchObject({ task: tasks[0]?.id, done: true })
  }, 120_000)
})
