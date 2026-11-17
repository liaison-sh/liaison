// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a signed record and its copies carry, through the real path: the agreements app
// registered from its manifest, a person's send minting the links, the clients signing on the
// public page, and the app's decided handler run in the sandbox from the outbox.
//
// - A version is sealed only with every signer's signature: a signer whose decided delivery
//   was lost is written from their record before the version is marked signed.
// - A new signing link on a restricted agreement keeps the agreement's list: a member off the
//   list sees neither the link nor the decision.
// - A message stamped with a restricted agreement's scope is never a source of a client
//   report, even when the person reading the sources is on the agreement's list.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as dsql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
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
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import { call, codeOf, tokenOf } from "../../../../test-support/client-actions-kit"
import { CaptureProvider, createDoorWorld, type DoorWorld, dropDoorWorld } from "./fixture"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const SCOPES = ["agreements:agreements:read", "agreements:agreements:write"]
const mutableEnv = env as { LIAISON_TSA_URL?: string }
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const app = (table: string) => sql(`${schemaRef("app_agreements")}.${table}`)

let w: DoorWorld
const capture = new CaptureProvider()
let previousMail: EmailProvider
let prevTsa: string | undefined
let prevForce: string | undefined

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

/** The client proves the emailed code and signs on the public page. */
async function signOn(token: string, person: { email: string; name: string }, ip: string) {
  const h = { "x-bun-socket-ip": ip }
  expect((await call("open", { t: token }, h)).status).toBe(200)
  expect((await call("document", { t: token, format: "blocks" }, h)).status).toBe(200)
  await clearRedisPatterns(["ca:code:gap:*"])
  const codeAt = capture.sent.length
  expect((await call("code", { t: token }, h)).status).toBe(202)
  const code = codeOf(await mailTo(person.email, "client-action.code", codeAt))
  const verified = await call("verify", { t: token, code, name: person.name }, h)
  expect(verified.status).toBe(200)
  const { proof } = (await verified.json()) as { proof: string }
  const signed = await call(
    "decide",
    { t: token, proof, decision: "sign", typed_name: person.name },
    h,
  )
  expect(signed.status).toBe(200)
}

async function prepared(title: string, extra: Record<string, unknown> = {}) {
  const created = await asPerson(w.admin.userId, "agreement_create", {
    kind: "nda",
    title,
    company_id: w.companyA,
    source: { body: { blocks: [{ type: "paragraph", text: `${title}: the parties agree.` }] } },
    ...extra,
  })
  expect(created.error).toBeUndefined()
  const agreementId = created.data?.agreement?.id as string
  const out = await asPerson(w.admin.userId, "agreement_prepare", { id: agreementId })
  expect(out.error).toBeUndefined()
  return {
    agreementId,
    versionId: out.data?.version_id as string,
    sha256: out.data?.sha256 as string,
  }
}

/** What a member sees of the org's client actions under their own row security. */
async function actionsSeenBy(userId: string, ids: string[]): Promise<number> {
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId: w.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  }
  return withRlsContext(
    actor,
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          dsql`SELECT id FROM ${dsql.raw(schemaRef("kernel"))}.client_actions
              WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`,
        ),
      ).length,
  )
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
  registerTranslatorConsumer()
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
}, 300_000)

afterAll(async () => {
  await rebuildFilesSelectPolicy()
  if (w) forgetOrgApps(w.orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  setSystemEmailProvider(previousMail)
  mutableEnv.LIAISON_TSA_URL = prevTsa
  if (prevForce === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
  else process.env.RATE_LIMIT_FORCE_ENABLED = prevForce
  await clearRedisPatterns(["ca:*"])
  if (w) {
    await sql`DELETE FROM ${kernel("attention_events")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    for (const t of ["messages", "thread_references", "thread_participants", "threads"])
      await sql`DELETE FROM ${kernel(t)} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${sql(`${schemaRef("app_projects")}.projects`)} WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("a signed record and its copies", () => {
  it("a version whose first signer's decided delivery was lost is sealed with every signer's signature, never one", async () => {
    const v = await prepared("Two signers, one delivery lost")
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: v.versionId,
      sha256: v.sha256,
      mode: "sign",
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }, { contact_id: w.clientA2.contactId }],
    })
    expect(sent.data?.status).toBe("ok")
    const ids = ((sent.data?.client_actions ?? []) as Array<{ id: string }>).map((a) => a.id)
    const tokenA = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const tokenB = tokenOf(await mailTo(w.clientA2.email, "client-action.link", before))

    await signOn(tokenA, w.clientA, "198.51.100.81")
    // The first signer's decided event never reaches the app.
    await sql`UPDATE ${kernel("pending_events")} SET processed_at = now()
               WHERE org_id = ${w.orgId} AND processed_at IS NULL
                 AND payload::text LIKE ${`%${ids[0]}%`}`
    await signOn(tokenB, w.clientA2, "198.51.100.82")
    await drainOutbox()

    const events = (await sql`
      SELECT client_action_id::text AS id FROM ${app("signature_events")}
       WHERE org_id = ${w.orgId} AND version_id = ${v.versionId}`) as unknown as Array<{
      id: string
    }>
    expect(events.map((e) => e.id).sort()).toEqual([...ids].sort())
    const [version] = (await sql`
      SELECT status FROM ${app("agreement_versions")} WHERE id = ${v.versionId}`) as unknown as Array<{
      status: string
    }>
    expect(version?.status).toBe("signed")
    const [pkg] = (await sql`
      SELECT trail::text AS trail FROM ${app("evidence_packages")}
       WHERE org_id = ${w.orgId} AND version_id = ${v.versionId}`) as unknown as Array<{
      trail: string
    }>
    expect(pkg?.trail).toContain(w.clientA.name)
    expect(pkg?.trail).toContain(w.clientA2.name)
  }, 180_000)

  it("a new signing link on a restricted agreement keeps its list: a member off the list sees neither the link nor the decision", async () => {
    const v = await prepared("Closed terms, new link", { org_access: "none" })
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: v.versionId,
      sha256: v.sha256,
      mode: "sign",
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }],
    })
    expect(sent.data?.status).toBe("ok")
    const first = ((sent.data?.client_actions ?? []) as Array<{ id: string }>)[0]?.id as string
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const h = { "x-bun-socket-ip": "198.51.100.83" }
    expect((await call("open", { t: token }, h)).status).toBe(200)
    // A decline without the emailed code: the documented recovery is a new link.
    expect(
      (await call("decide", { t: token, decision: "decline", reason: "Wrong person" }, h)).status,
    ).toBe(200)
    await drainOutbox()
    const renewed = await asPerson(w.admin.userId, "agreement_new_link", {
      client_action_id: first,
    })
    expect(renewed.error).toBeUndefined()
    const second = renewed.data?.client_action?.id as string
    expect(second).toBeTruthy()

    expect(await actionsSeenBy(w.admin.userId, [first, second])).toBe(2)
    expect(await actionsSeenBy(w.member.userId, [first, second])).toBe(0)
    const [row] = (await sql`
      SELECT visible_to FROM ${kernel("client_actions")} WHERE id = ${second}`) as unknown as Array<{
      visible_to: string[] | null
    }>
    expect(row?.visible_to).toEqual([w.admin.userId])
  }, 180_000)

  it("a message stamped with a restricted agreement is never a client report source, even for a reader on its list", async () => {
    // The reader is on the agreement's list and on the message's disclosure list, as the
    // stamping writer leaves it: the row rules let them read it, and still it is no source.
    const closed = await asPerson(w.admin.userId, "agreement_create", {
      kind: "nda",
      title: "Closed report terms",
      org_access: "none",
      company_id: w.companyA,
      source: { body: { blocks: [{ type: "paragraph", text: "Closed." }] } },
    })
    const closedId = closed.data?.agreement?.id as string
    const scopes = [
      "projects:projects:read",
      "projects:projects:write",
      "projects:reports:read",
      "projects:reports:write",
    ]
    const actor: UserContext = {
      actorType: "user",
      userId: w.admin.userId,
      orgId: w.orgId,
      scopes,
      dimensionGrants: { "*": ["*"] },
    }
    const bridgeCall = (method: string, input: unknown) =>
      withRlsContext(actor, async (tx) => {
        const bridge = createRpcBridge(
          "projects",
          w.admin.userId,
          w.orgId,
          tx,
          { name: "projects" },
          scopes,
          "user",
          undefined,
          { origin: "human-ui" } as never,
        )
        return JSON.parse(await bridge[method](JSON.stringify(input))) as Record<string, any>
      })
    const project = await bridgeCall("projects_createProject", { name: "Report source project" })
    const projectId = project.id as string
    const [thread] = (await sql`
      INSERT INTO ${kernel("threads")} (org_id, handle, type, created_by)
      VALUES (${w.orgId}, ${`report-src-${crypto.randomUUID().slice(0, 8)}`}, 'thread', ${w.admin.userId})
      RETURNING id::text AS id`) as unknown as Array<{ id: string }>
    await sql`INSERT INTO ${kernel("thread_participants")} (thread_id, user_id, org_id)
              VALUES (${thread?.id ?? ""}, ${w.admin.userId}, ${w.orgId})`
    await sql`INSERT INTO ${kernel("thread_references")} (thread_id, org_id, app, entity_type, entity_id, added_by)
              VALUES (${thread?.id ?? ""}, ${w.orgId}, 'projects', 'project', ${projectId}, ${w.admin.userId})`
    await sql`INSERT INTO ${kernel("messages")} (thread_id, org_id, author_id, content, required_scopes)
              VALUES (${thread?.id ?? ""}, ${w.orgId}, ${w.admin.userId}, 'The homepage went live.', '{}'::text[])`
    await sql`INSERT INTO ${kernel("messages")} (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
              VALUES (${thread?.id ?? ""}, ${w.orgId}, ${w.admin.userId}, 'The closed price is 90,000.',
                      ${`{restricted:agreements.agreement:${closedId}}`}::text[],
                      ${`{${w.admin.userId}}`}::uuid[])`
    const today = new Date().toISOString().slice(0, 10)
    const sources = await bridgeCall("projects_clientReportSources", { projectId, until: today })
    const text = JSON.stringify(sources.threadMessages)
    expect(text).toContain("The homepage went live.")
    expect(text).not.toContain("closed price")
  }, 120_000)
})
