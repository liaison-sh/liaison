// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A client's signature on an agreement closed to the organization, through the real
// path: the agreements app registered from its manifest, a person's send minting the
// link, the client opening it and signing on the public page, and the app's decided
// handler run in the sandbox from the outbox. The handler is system work: the closed
// agreement's row rules (no list entry for anyone but its author) never hide the
// version from it, so the signature is recorded and the agreement moves.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
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
}, 300_000)

afterAll(async () => {
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

describe("a client's signature through the agreements app", () => {
  it("on an agreement closed to the organization, is recorded and moves the agreement to signed", async () => {
    const created = await asPerson(w.admin.userId, "agreement_create", {
      kind: "nda",
      title: "Closed NDA",
      org_access: "none",
      company_id: w.companyA,
      source: { body: { blocks: [{ type: "paragraph", text: "The parties agree." }] } },
    })
    expect(created.error).toBeUndefined()
    const agreementId = created.data?.agreement?.id as string

    // Another member of the organization does not see it: the row rules are on.
    const theirs = await asPerson(w.member.userId, "agreement_get", { id: agreementId })
    expect(JSON.stringify(theirs)).toContain("NOT_FOUND")

    const prepared = await asPerson(w.admin.userId, "agreement_prepare", { id: agreementId })
    expect(prepared.error).toBeUndefined()
    const versionId = prepared.data?.version_id as string
    const sha256 = prepared.data?.sha256 as string
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)

    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256,
      mode: "sign",
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }],
    })
    expect(sent.error).toBeUndefined()
    expect(sent.data?.status).toBe("ok")
    const actionId = sent.data?.client_actions?.[0]?.id as string

    // The client opens the link, reads, proves the code and signs.
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const ip = "198.51.100.77"
    const h = { "x-bun-socket-ip": ip }
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

    const events = (await sql`
      SELECT client_action_id, version_id, typed_name FROM ${app("signature_events")}
       WHERE org_id = ${w.orgId} AND version_id = ${versionId}`) as unknown as Array<{
      client_action_id: string
      typed_name: string
    }>
    expect(events).toHaveLength(1)
    expect(events[0]?.client_action_id).toBe(actionId)
    expect(events[0]?.typed_name).toBe(w.clientA.name)
    const [row] = (await sql`
      SELECT status FROM ${app("agreements")} WHERE id = ${agreementId}`) as unknown as Array<{
      status: string
    }>
    expect(row?.status).toBe("signed")
    const [version] = (await sql`
      SELECT status FROM ${app("agreement_versions")} WHERE id = ${versionId}`) as unknown as Array<{
      status: string
    }>
    expect(version?.status).toBe("signed")
  }, 120_000)

  it("with one signer past the code and one not, sign refuses for the unverified one and the agreement never reaches signed", async () => {
    const created = await asPerson(w.admin.userId, "agreement_create", {
      kind: "nda",
      title: "Two signers",
      company_id: w.companyA,
      source: { body: { blocks: [{ type: "paragraph", text: "Both parties agree." }] } },
    })
    const agreementId = created.data?.agreement?.id as string
    const prepared = await asPerson(w.admin.userId, "agreement_prepare", { id: agreementId })
    const versionId = prepared.data?.version_id as string
    const before = capture.sent.length
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: versionId,
      sha256: prepared.data?.sha256 as string,
      order: "any",
      expires_in_days: 7,
      signers: [{ contact_id: w.clientA.contactId }, { contact_id: w.clientA2.contactId }],
    })
    expect(sent.data?.status).toBe("ok")
    const tokenA = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const tokenB = tokenOf(await mailTo(w.clientA2.email, "client-action.link", before))
    const h = { "x-bun-socket-ip": "198.51.100.78" }

    // Signer A proves the code and signs.
    await call("open", { t: tokenA }, h)
    await call("document", { t: tokenA, format: "blocks" }, h)
    await clearRedisPatterns(["ca:code:gap:*"])
    const codeAt = capture.sent.length
    await call("code", { t: tokenA }, h)
    const code = codeOf(await mailTo(w.clientA.email, "client-action.code", codeAt))
    const verified = await call("verify", { t: tokenA, code, name: w.clientA.name }, h)
    const { proof } = (await verified.json()) as { proof: string }
    expect(
      (await call("decide", { t: tokenA, proof, decision: "sign", typed_name: w.clientA.name }, h))
        .status,
    ).toBe(200)

    // Signer B's link reads, but signs neither with no proof, nor a guessed one, nor A's.
    expect((await call("open", { t: tokenB }, h)).status).toBe(200)
    expect((await call("document", { t: tokenB, format: "blocks" }, h)).status).toBe(200)
    for (const p of [undefined, "guessed-proof", proof]) {
      const r = await call(
        "decide",
        { t: tokenB, ...(p ? { proof: p } : {}), decision: "sign", typed_name: w.clientA2.name },
        h,
      )
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
    await drainOutbox()
    const [mid] = (await sql`
      SELECT status FROM ${app("agreements")} WHERE id = ${agreementId}`) as unknown as Array<{
      status: string
    }>
    expect(mid?.status).toBe("partly_signed")

    // The same link may decline: the agreement closes as declined, never signed.
    expect(
      (await call("decide", { t: tokenB, decision: "decline", reason: "Not me" }, h)).status,
    ).toBe(200)
    await drainOutbox()
    const [row] = (await sql`
      SELECT status FROM ${app("agreements")} WHERE id = ${agreementId}`) as unknown as Array<{
      status: string
    }>
    expect(row?.status).toBe("declined")
    const events = await sql`
      SELECT 1 FROM ${app("signature_events")} WHERE version_id = ${versionId}`
    expect(events).toHaveLength(1)
    const [version] = (await sql`
      SELECT status FROM ${app("agreement_versions")} WHERE id = ${versionId}`) as unknown as Array<{
      status: string
    }>
    expect(version?.status).not.toBe("signed")
  }, 120_000)
})
