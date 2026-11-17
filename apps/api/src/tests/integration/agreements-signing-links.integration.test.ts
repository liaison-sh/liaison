// SPDX-License-Identifier: FSL-1.1-ALv2
//
// New links and the send's signers, through the real path: the agreements app registered
// from its manifest, a person's send and new link minting the links, the clients signing on
// the public page, and the app's decided handler run in the sandbox from the outbox. A link
// a new one replaced leaves the send: the agreement seals once every live signer signed, in
// any order and one after the other. A signature on an agreement no longer waiting for
// signatures is never recorded or sealed.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
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
import { registerTranslatorConsumer } from "~/modules/attention/translator"
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
  // Production builds the files row policy from the installed catalog; this app is
  // registered from its manifest, so the policy is built from the registry's parents.
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
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
    await sql`DELETE FROM ${kernel("attention_events")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

/** Opens the link, shows the document, proves the code and signs as `who`. */
async function signAs(token: string, who: { email: string; name: string }, ip: string) {
  const h = { "x-bun-socket-ip": ip }
  expect((await call("open", { t: token }, h)).status).toBe(200)
  expect((await call("document", { t: token, format: "blocks" }, h)).status).toBe(200)
  await clearRedisPatterns(["ca:code:gap:*"])
  const codeAt = capture.sent.length
  expect((await call("code", { t: token }, h)).status).toBe(202)
  const code = codeOf(await mailTo(who.email, "client-action.code", codeAt))
  const verified = await call("verify", { t: token, code, name: who.name }, h)
  expect(verified.status).toBe(200)
  const { proof } = (await verified.json()) as { proof: string }
  const signed = await call(
    "decide",
    { t: token, proof, decision: "sign", typed_name: who.name },
    h,
  )
  expect(signed.status).toBe(200)
  await drainOutbox()
}

async function preparedAgreement(title: string) {
  const created = await asPerson(w.admin.userId, "agreement_create", {
    kind: "nda",
    title,
    company_id: w.companyA,
    source: { body: { blocks: [{ type: "paragraph", text: `${title}: the parties agree.` }] } },
  })
  expect(created.error).toBeUndefined()
  const agreementId = created.data?.agreement?.id as string
  const prepared = await asPerson(w.admin.userId, "agreement_prepare", { id: agreementId })
  expect(prepared.error).toBeUndefined()
  return {
    agreementId,
    versionId: prepared.data?.version_id as string,
    sha256: prepared.data?.sha256 as string,
  }
}

async function statusOf(agreementId: string, versionId: string) {
  const [a] = (await sql`
    SELECT status FROM ${app("agreements")} WHERE id = ${agreementId}`) as unknown as Array<{
    status: string
  }>
  const [v] = (await sql`
    SELECT status FROM ${app("agreement_versions")} WHERE id = ${versionId}`) as unknown as Array<{
    status: string
  }>
  const pkgs = await sql`
    SELECT 1 FROM ${app("evidence_packages")} WHERE version_id = ${versionId}`
  return { agreement: a?.status, version: v?.status, sealed: pkgs.length > 0 }
}

describe("new links and the signers of a send", () => {
  it("in any order, a new link for one signer and both signatures seal the agreement", async () => {
    const { agreementId, versionId, sha256 } = await preparedAgreement("Any order new link")
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256,
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }, { contact_id: w.clientA2.contactId }],
    })
    expect(sent.data?.status).toBe("ok")
    const second = ((sent.data?.client_actions ?? []) as Array<{ id: string; signer: string }>)[1]
    const tokenA = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    await mailTo(w.clientA2.email, "client-action.link", before)

    const relinkAt = capture.sent.length
    const relinked = await asPerson(w.admin.userId, "agreement_new_link", {
      client_action_id: second?.id,
    })
    expect(relinked.error).toBeUndefined()
    expect(relinked.data?.status).toBe("ok")
    const tokenB = tokenOf(await mailTo(w.clientA2.email, "client-action.link", relinkAt))

    await signAs(tokenA, w.clientA, "198.51.100.81")
    expect((await statusOf(agreementId, versionId)).agreement).toBe("partly_signed")
    await signAs(tokenB, w.clientA2, "198.51.100.82")
    expect(await statusOf(agreementId, versionId)).toEqual({
      agreement: "signed",
      version: "signed",
      sealed: true,
    })
  }, 120_000)

  it("one after the other, the first signer's new link signed opens the second signer's turn, and both seal it", async () => {
    const { agreementId, versionId, sha256 } = await preparedAgreement("In order new link")
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256,
      order: "sequential",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }, { contact_id: w.clientA2.contactId }],
    })
    expect(sent.data?.status).toBe("ok")
    const first = ((sent.data?.client_actions ?? []) as Array<{ id: string }>)[0]
    await mailTo(w.clientA.email, "client-action.link", before)
    const relinkAt = capture.sent.length
    const relinked = await asPerson(w.admin.userId, "agreement_new_link", {
      client_action_id: first?.id,
    })
    expect(relinked.data?.status).toBe("ok")
    const tokenA = tokenOf(await mailTo(w.clientA.email, "client-action.link", relinkAt))

    const turnAt = capture.sent.length
    await signAs(tokenA, w.clientA, "198.51.100.83")
    const tokenB = tokenOf(await mailTo(w.clientA2.email, "client-action.link", turnAt))
    await signAs(tokenB, w.clientA2, "198.51.100.84")
    expect(await statusOf(agreementId, versionId)).toEqual({
      agreement: "signed",
      version: "signed",
      sealed: true,
    })
  }, 120_000)

  it("one after the other, a decline made without the code and a new link let the turns go on to the seal", async () => {
    const { agreementId, versionId, sha256 } = await preparedAgreement("Declined then new link")
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256,
      order: "sequential",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }, { contact_id: w.clientA2.contactId }],
    })
    const first = ((sent.data?.client_actions ?? []) as Array<{ id: string }>)[0]
    const declineToken = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const h = { "x-bun-socket-ip": "198.51.100.85" }
    expect((await call("open", { t: declineToken }, h)).status).toBe(200)
    expect(
      (await call("decide", { t: declineToken, decision: "decline", reason: "Wrong person" }, h))
        .status,
    ).toBe(200)
    await drainOutbox()
    expect((await statusOf(agreementId, versionId)).agreement).toBe("declined")

    const relinkAt = capture.sent.length
    const relinked = await asPerson(w.admin.userId, "agreement_new_link", {
      client_action_id: first?.id,
    })
    expect(relinked.data?.status).toBe("ok")
    const tokenA = tokenOf(await mailTo(w.clientA.email, "client-action.link", relinkAt))
    const turnAt = capture.sent.length
    await signAs(tokenA, w.clientA, "198.51.100.86")
    const tokenB = tokenOf(await mailTo(w.clientA2.email, "client-action.link", turnAt))
    await signAs(tokenB, w.clientA2, "198.51.100.87")
    expect(await statusOf(agreementId, versionId)).toEqual({
      agreement: "signed",
      version: "signed",
      sealed: true,
    })
  }, 120_000)

  it("a signature on an agreement voided while its link was open records nothing and seals nothing", async () => {
    const { agreementId, versionId, sha256 } = await preparedAgreement("Voided under the link")
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256,
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }],
    })
    expect(sent.data?.status).toBe("ok")
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    // The agreement leaves "waiting for signatures" by a path that left the link open.
    await sql`UPDATE ${app("agreements")} SET status = 'voided' WHERE id = ${agreementId}`
    await signAs(token, w.clientA, "198.51.100.88")
    const events = await sql`
      SELECT 1 FROM ${app("signature_events")} WHERE version_id = ${versionId}`
    expect(events).toHaveLength(0)
    expect(await statusOf(agreementId, versionId)).toEqual({
      agreement: "voided",
      version: "frozen",
      sealed: false,
    })
  }, 120_000)

  it("a contact named with another address is refused before any card or link", async () => {
    const { versionId, sha256 } = await preparedAgreement("Other address")
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256,
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId, email: "someone-else@elsewhere.example" }],
    })
    expect(JSON.stringify(sent)).toContain("NOT_THE_CONTACTS_ADDRESS")
    const rows = await sql`
      SELECT 1 FROM ${kernel("client_actions")} WHERE target_id = ${versionId}`
    expect(rows).toHaveLength(0)
    expect(capture.sent.slice(before).filter((m) => m.template === "client-action.link")).toEqual(
      [],
    )
  }, 120_000)
})
