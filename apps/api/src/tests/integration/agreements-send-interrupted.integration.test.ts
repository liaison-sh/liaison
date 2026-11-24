// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A send for signature cut off half way, through the real path: the agreements app registered
// from its manifest, a person's send run in the sandbox, the sandbox killed at chosen moments,
// the rows, the outbox and the mails as Postgres and the mail channel hold them. Whatever was
// cut off, the agreement reads as sent once its links exist, a signature is recorded, nobody is
// mailed twice, and the document can be voided or replaced. Half a send, or a draft changed since,
// is never taken for sent or signed. A person whose role may send can send, and two people at one
// address sign each with their own link.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import { insertSql } from "~/seed/factories/org/test-rows"
import { drainOutbox } from "~/tests/helpers/outbox"
import {
  acquireTestLock,
  clearRedisPatterns,
  releaseTestLock,
  superuserUrlForTestDb,
} from "~/tests/route-test-setup"
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
/** The test database's owner: the app's own role makes no trigger. */
let owner: ReturnType<typeof postgres>
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
  owner = postgres(superuserUrlForTestDb() as string, { max: 1, onnotice: () => {} })
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

afterEach(async () => {
  await dropTriggers()
  delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
})

afterAll(async () => {
  await owner.end()
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

/** Runs `act` in the database before a row of `table` that fits `when` is written. */
async function trigger(
  table: string,
  on: "INSERT" | "UPDATE",
  when: string,
  act: string,
): Promise<void> {
  await owner.unsafe(`CREATE OR REPLACE FUNCTION public.cut_send_test_fn() RETURNS trigger AS $$
    BEGIN
      IF ${when} THEN ${act} END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql SECURITY DEFINER`)
  await owner.unsafe(`CREATE TRIGGER cut_send_test BEFORE ${on} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION public.cut_send_test_fn()`)
}

async function dropTriggers(): Promise<void> {
  for (const table of ["kernel.client_actions", "app_agreements.agreements"])
    await owner.unsafe(`DROP TRIGGER IF EXISTS cut_send_test ON ${table}`)
  await owner.unsafe("DROP FUNCTION IF EXISTS public.cut_send_test_fn()")
}

const signersOf = (versionId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    email: `s${i + 1}-${versionId.slice(0, 8)}@signers.example`,
    name: `Signer ${i + 1}`,
  }))

const sendParams = (p: { versionId: string; sha256: string }, n: number) => ({
  version_id: p.versionId,
  sha256: p.sha256,
  order: "any",
  expires_in_days: 7,
  signers: signersOf(p.versionId, n),
})

const linkRows = async (versionId: string) =>
  (await sql`
    SELECT id, invited_email, revoked_at, decided_at FROM ${kernel("client_actions")}
     WHERE target_id = ${versionId}`) as unknown as Array<{
    id: string
    invited_email: string
    revoked_at: Date | null
    decided_at: Date | null
  }>

const linkMails = (versionId: string) =>
  capture.sent.filter(
    (m) => m.template === "client-action.link" && m.to.includes(versionId.slice(0, 8)),
  )

async function until(cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("did not settle")
}

/** Exactly one mail to each of the n signers, and none on its way. */
async function oneMailEach(versionId: string, n: number): Promise<void> {
  await until(() => linkMails(versionId).length >= n)
  await new Promise((r) => setTimeout(r, 300))
  const to = linkMails(versionId).map((m) => m.to)
  expect(to).toHaveLength(n)
  expect(new Set(to).size).toBe(n)
}

/** Sends with the run's wall clock cut to 1.5 s: the sandbox is killed 2 s later, while `trigger` holds. */
async function sendCutOff(p: { versionId: string; sha256: string }, n: number): Promise<Out> {
  process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = "1500"
  const out = await asPerson(w.admin.userId, "agreement_send", sendParams(p, n))
  delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
  return out
}

/** The outbox lost the word of a target's links (and of its decisions, when asked). */
async function loseEvents(versionId: string): Promise<void> {
  await owner.unsafe(
    `DELETE FROM kernel.pending_events WHERE org_id = '${w.orgId}' AND payload::text LIKE '%${versionId}%'`,
  )
}

async function reconcile(): Promise<void> {
  const handler = JobsTestAccess.getHandler("agreements", "decided-reconcile")
  if (!handler) throw new Error("decided-reconcile is not registered")
  await dispatchAppJobWithContext(
    handler,
    { orgId: w.orgId },
    { actorType: "system", orgId: w.orgId, purpose: "job", scopes: ["agreements:*"] },
    "session",
  )
  await drainOutbox()
}

const sentAnnounced = async (agreementId: string) =>
  (
    (await sql`
      SELECT id FROM ${kernel("pending_events")}
       WHERE org_id = ${w.orgId} AND payload->>'entityId' = ${agreementId}
         AND payload->>'entity' = 'agreement' AND payload->>'action' = 'sent'`) as unknown as unknown[]
  ).length

const asSigner = (versionId: string, n: number) => {
  const s = signersOf(versionId, n)[n - 1] as { email: string; name: string }
  return {
    who: s,
    token: () =>
      tokenOf(linkMails(versionId).find((m) => m.to === s.email) as (typeof capture.sent)[number]),
  }
}

describe("a send of 40 signers", () => {
  it("goes out whole, once, and reads as sent", async () => {
    const p = await preparedAgreement("Forty signers")
    const sent = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
    expect(sent.data?.status).toBe("ok")
    expect(sent.data?.client_actions).toHaveLength(40)
    expect(await linkRows(p.versionId)).toHaveLength(40)
    await oneMailEach(p.versionId, 40)
    expect(await sentAnnounced(p.agreementId)).toBe(1)
    await drainOutbox()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
  }, 120_000)

  for (const k of [0, 1, 20, 39]) {
    it(`killed while signer ${k + 1} is written: all 40 links, sent, one mail each, and a retry sends nothing`, async () => {
      const p = await preparedAgreement(`Killed after ${k}`)
      await trigger(
        "kernel.client_actions",
        "INSERT",
        `NEW.target_id = '${p.versionId}' AND (SELECT count(*) FROM kernel.client_actions WHERE target_id = NEW.target_id) = ${k}`,
        "PERFORM pg_sleep(5);",
      )
      const cut = await sendCutOff(p, 40)
      expect(cut.error?.code).toBe("timeout")
      expect(cut.error?.message).toContain("may have gone through")
      // All of them or none: nothing is visible while the transaction is open.
      expect(await linkRows(p.versionId)).toHaveLength(0)
      // A retry while the first still writes waits for it and makes nothing of its own.
      const during = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
      expect(during.data ?? during).toMatchObject({ status: "ok", already_sent: true })
      expect(await linkRows(p.versionId)).toHaveLength(40)
      await dropTriggers()
      await drainOutbox()
      expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
      const after = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
      expect(JSON.stringify(after)).toContain("already sent")
      expect(JSON.stringify(after)).toContain("nothing was sent again")
      expect(await linkRows(p.versionId)).toHaveLength(40)
      await oneMailEach(p.versionId, 40)
      expect(await sentAnnounced(p.agreementId)).toBe(1)
    }, 120_000)
  }

  it("killed and never asked again: the kernel's word of the links marks it sent", async () => {
    const p = await preparedAgreement("Killed, no retry")
    await trigger(
      "kernel.client_actions",
      "INSERT",
      `NEW.target_id = '${p.versionId}' AND (SELECT count(*) FROM kernel.client_actions WHERE target_id = NEW.target_id) = 20`,
      "PERFORM pg_sleep(5);",
    )
    expect((await sendCutOff(p, 40)).error?.code).toBe("timeout")
    await until(async () => (await linkRows(p.versionId)).length === 40)
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
    await drainOutbox()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
    expect(await sentAnnounced(p.agreementId)).toBe(1)
    await oneMailEach(p.versionId, 40)
  }, 120_000)

  it("all 40 made, then its status write fails: told that the links went out, and repaired", async () => {
    const p = await preparedAgreement("Status not written")
    await trigger(
      "app_agreements.agreements",
      "UPDATE",
      `NEW.id = '${p.agreementId}' AND NEW.status = 'sent'`,
      "RAISE EXCEPTION 'not now';",
    )
    const out = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
    expect(out.data?.status).toBe("ok")
    expect(out.data?.message).toContain("its state follows")
    expect(await linkRows(p.versionId)).toHaveLength(40)
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
    const again = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
    expect(again.data).toMatchObject({ status: "ok", already_sent: true })
    await dropTriggers()
    await loseEvents(p.versionId)
    await reconcile()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
    await oneMailEach(p.versionId, 40)
  }, 120_000)

  it("one signer's link fails: none is made, nothing is mailed, and the retry sends all once", async () => {
    const p = await preparedAgreement("One link fails")
    await trigger(
      "kernel.client_actions",
      "INSERT",
      `NEW.target_id = '${p.versionId}' AND NEW.invited_name = 'Signer 21'`,
      "RAISE EXCEPTION 'no row for this signer';",
    )
    const out = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
    expect(JSON.stringify(out)).toContain("SEND_NOT_CONFIRMED")
    await dropTriggers()
    await drainOutbox()
    expect(await linkRows(p.versionId)).toHaveLength(0)
    expect(linkMails(p.versionId)).toEqual([])
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
    const again = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
    expect(again.data?.status).toBe("ok")
    await oneMailEach(p.versionId, 40)
  }, 120_000)

  it("sent twice at the same moment, it goes out once", async () => {
    const p = await preparedAgreement("Clicked twice")
    const outs = await Promise.all([
      asPerson(w.admin.userId, "agreement_send", sendParams(p, 40)),
      asPerson(w.admin.userId, "agreement_send", sendParams(p, 40)),
    ])
    expect(outs.some((o) => o.data?.status === "ok")).toBe(true)
    expect(await linkRows(p.versionId)).toHaveLength(40)
    await oneMailEach(p.versionId, 40)
    await drainOutbox()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
    expect(await sentAnnounced(p.agreementId)).toBe(1)
  }, 120_000)
})

/** A send of n signers whose run was killed, and whose word of the links was lost. */
async function cutSend(title: string, n: number) {
  const p = await preparedAgreement(title)
  await trigger(
    "kernel.client_actions",
    "INSERT",
    `NEW.target_id = '${p.versionId}' AND (SELECT count(*) FROM kernel.client_actions WHERE target_id = NEW.target_id) = 0`,
    "PERFORM pg_sleep(5);",
  )
  expect((await sendCutOff(p, n)).error?.code).toBe("timeout")
  await until(async () => (await linkRows(p.versionId)).length === n)
  await dropTriggers()
  await oneMailEach(p.versionId, n)
  await loseEvents(p.versionId)
  expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
  return p
}

describe("a draft whose send was cut off", () => {
  it("a signature that arrives in between is recorded, and the last one seals it", async () => {
    const p = await cutSend("Signed in between", 2)
    const one = asSigner(p.versionId, 1)
    await signAs(one.token(), one.who, "198.51.100.91")
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("partly_signed")
    const two = asSigner(p.versionId, 2)
    await signAs(two.token(), two.who, "198.51.100.92")
    expect(await statusOf(p.agreementId, p.versionId)).toEqual({
      agreement: "signed",
      version: "signed",
      sealed: true,
    })
    // Its own send, asked again now, neither mails anyone nor moves it back.
    await asPerson(w.admin.userId, "agreement_send", sendParams(p, 2))
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("signed")
    await oneMailEach(p.versionId, 2)
  }, 120_000)

  it("the reconcile job marks it sent and records a signature whose own word was lost", async () => {
    const p = await cutSend("Reconciled", 2)
    // The signature is decided in the kernel; the app never hears of it.
    const one = (await linkRows(p.versionId)).find((r) => r.invited_email.startsWith("s1-"))
    await sql`
      UPDATE ${kernel("client_actions")}
         SET decided_at = now(), decision = 'signed', typed_name = 'Signer 1',
             code_verified_at = now(), document_shown_at = now()
       WHERE id = ${one?.id ?? ""}`
    await reconcile()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("partly_signed")
    const events = await sql`
      SELECT client_action_id FROM ${app("signature_events")} WHERE version_id = ${p.versionId}`
    expect(events.map((e) => e.client_action_id)).toEqual([one?.id])
    await reconcile()
    expect(await linkRows(p.versionId)).toHaveLength(2)
    await oneMailEach(p.versionId, 2)
  }, 120_000)

  it("the reconcile job runs for an organization whose only agreement is that draft", () => {
    const job = (descriptor().jobs as Record<string, { runsFor: unknown }>)["decided-reconcile"]
    expect(JSON.stringify(job?.runsFor)).toContain('"draft"')
  })

  it("it can be voided at once: every open link is withdrawn", async () => {
    const p = await cutSend("Voided", 2)
    const out = await asPerson(w.admin.userId, "agreement_void", {
      id: p.agreementId,
      reason: "Wrong terms",
    })
    expect(out.data?.status).toBe("ok")
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("voided")
    expect((await linkRows(p.versionId)).every((r) => r.revoked_at)).toBe(true)
    await reconcile()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("voided")
  }, 120_000)

  it("a void waits for an answer not recorded yet; once recorded, it goes through and keeps it", async () => {
    const p = await cutSend("Voided after an answer", 2)
    const one = (await linkRows(p.versionId)).find((r) => r.invited_email.startsWith("s1-"))
    await sql`
      UPDATE ${kernel("client_actions")}
         SET decided_at = now(), decision = 'signed', typed_name = 'Signer 1',
             code_verified_at = now(), document_shown_at = now()
       WHERE id = ${one?.id ?? ""}`
    const ask = () =>
      asPerson(w.admin.userId, "agreement_void", { id: p.agreementId, reason: "Wrong terms" })
    expect(JSON.stringify(await ask())).toContain("ANSWER_BEING_RECORDED")
    expect((await linkRows(p.versionId)).some((r) => r.revoked_at)).toBe(false)
    await reconcile()
    expect((await ask()).data?.status).toBe("ok")
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("voided")
    const open = (await linkRows(p.versionId)).filter((r) => !r.revoked_at && !r.decided_at)
    expect(open).toEqual([])
    const events = await sql`
      SELECT client_action_id FROM ${app("signature_events")} WHERE version_id = ${p.versionId}`
    expect(events.map((e) => e.client_action_id)).toEqual([one?.id])
  }, 120_000)

  it("a save replaces it: its links die and a new version can be sent", async () => {
    const p = await cutSend("Edited", 2)
    const saved = await asPerson(w.admin.userId, "agreement_update", {
      id: p.agreementId,
      source: { body: { blocks: [{ type: "paragraph", text: "New terms." }] } },
    })
    expect(saved.error).toBeUndefined()
    expect((await linkRows(p.versionId)).every((r) => r.revoked_at)).toBe(true)
    const next = await asPerson(w.admin.userId, "agreement_prepare", { id: p.agreementId })
    expect(next.data?.status).toBe("ok")
    const v2 = {
      agreementId: p.agreementId,
      versionId: next.data?.version_id as string,
      sha256: next.data?.sha256 as string,
    }
    const sent = await asPerson(w.admin.userId, "agreement_send", sendParams(v2, 2))
    expect(sent.data?.status).toBe("ok")
    await oneMailEach(v2.versionId, 2)
  }, 120_000)

  it("other signers on it are refused by name, and it reads as sent", async () => {
    const p = await cutSend("Other signers", 2)
    const out = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 3))
    expect(JSON.stringify(out)).toContain("ALREADY_SENT")
    expect(JSON.stringify(out)).toContain("Signer 1")
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
    expect(await linkRows(p.versionId)).toHaveLength(2)
    await oneMailEach(p.versionId, 2)
  }, 120_000)
})

/** The signer's answer is decided in the kernel; the app never hears of it. */
async function decidedUnheard(versionId: string, n: number): Promise<string> {
  const link = (await linkRows(versionId)).find((r) => r.invited_email.startsWith(`s${n}-`))
  await sql`
    UPDATE ${kernel("client_actions")}
       SET decided_at = now(), decision = 'signed', typed_name = ${`Signer ${n}`},
           code_verified_at = now(), document_shown_at = now()
     WHERE id = ${link?.id ?? ""}`
  return link?.id ?? ""
}

const recordedFor = async (versionId: string) =>
  (
    (await sql`
      SELECT client_action_id FROM ${app("signature_events")}
       WHERE version_id = ${versionId}`) as unknown as Array<{ client_action_id: string }>
  ).map((e) => e.client_action_id)

const toldOf = async (agreementId: string) => {
  await drainOutbox()
  return (await sql`
    SELECT user_id, summary FROM ${kernel("attention_events")}
     WHERE org_id = ${w.orgId} AND entity_id = ${agreementId}
       AND kind = 'agreements:agreement.send_unfinished'`) as unknown as Array<{
    user_id: string
    summary: string
  }>
}

/** The links as an earlier release left them: made one by one, the last `missing` never made. */
async function asMadeOneByOne(versionId: string, missing: number): Promise<void> {
  const rows = (await linkRows(versionId)).sort((a, b) =>
    a.invited_email.localeCompare(b.invited_email),
  )
  const gone = rows.slice(rows.length - missing).map((r) => r.id)
  await owner.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica")
    for (const id of gone) {
      await tx.unsafe(`DELETE FROM kernel.client_action_events WHERE action_id = '${id}'`)
      await tx.unsafe(`DELETE FROM kernel.client_actions WHERE id = '${id}'`)
    }
    await tx.unsafe(`UPDATE kernel.client_action_events SET meta = meta - 'send_size'
      WHERE action_id IN (SELECT id FROM kernel.client_actions WHERE target_id = '${versionId}')`)
  })
}

describe("an answer not recorded yet", () => {
  it("holds a void and a save as long as it is not recorded, on a draft and on a sent agreement", async () => {
    const p = await cutSend("Held until recorded", 2)
    const id = await decidedUnheard(p.versionId, 1)
    const ask = async () => [
      JSON.stringify(
        await asPerson(w.admin.userId, "agreement_void", { id: p.agreementId, reason: "No" }),
      ).includes("ANSWER_BEING_RECORDED"),
      JSON.stringify(
        await asPerson(w.admin.userId, "agreement_update", {
          id: p.agreementId,
          source: { body: { blocks: [{ type: "paragraph", text: "New terms." }] } },
        }),
      ).includes("ANSWER_BEING_RECORDED"),
    ]
    for (let i = 0; i < 2; i++) expect(await ask()).toEqual([true, true])
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
    expect((await linkRows(p.versionId)).some((r) => r.revoked_at)).toBe(false)
    await reconcile()
    expect(await recordedFor(p.versionId)).toEqual([id])
    const voided = await asPerson(w.admin.userId, "agreement_void", {
      id: p.agreementId,
      reason: "No",
    })
    expect(voided.data?.status).toBe("ok")
    expect(await recordedFor(p.versionId)).toEqual([id])
  }, 120_000)
})

describe("the job that repairs sends", () => {
  it("records a lost signature however many long frozen versions there are, and whatever one draft does", async () => {
    const lost = await preparedAgreement("Lost signature")
    await asPerson(w.admin.userId, "agreement_send", sendParams(lost, 2))
    await oneMailEach(lost.versionId, 2)
    await drainOutbox()
    const id = await decidedUnheard(lost.versionId, 1)
    const bad = await cutSend("Cannot be written", 1)
    const good = await cutSend("Can be written", 1)
    // Hundreds of long documents, newer than the ones to repair.
    await owner.unsafe(
      insertSql(
        "app_agreements.agreement_versions",
        Array.from({ length: 400 }, (_, i) => ({
          org_id: w.orgId,
          agreement_id: lost.agreementId,
          number: -1 - i,
          status: "frozen",
          frozen_at: { raw: "now()" },
          source: { raw: "jsonb_build_object('text', repeat('x', 60000))" },
          source_text: { raw: "repeat('x', 60000)" },
        })),
      ),
    )
    await trigger(
      "app_agreements.agreements",
      "UPDATE",
      `NEW.id = '${bad.agreementId}' AND NEW.status = 'sent'`,
      "RAISE EXCEPTION 'not now';",
    )
    await reconcile()
    expect(await recordedFor(lost.versionId)).toEqual([id])
    expect((await statusOf(lost.agreementId, lost.versionId)).agreement).toBe("partly_signed")
    expect((await statusOf(good.agreementId, good.versionId)).agreement).toBe("sent")
    expect((await statusOf(bad.agreementId, bad.versionId)).agreement).toBe("draft")
    await dropTriggers()
    await owner.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica")
      await tx.unsafe(
        `DELETE FROM app_agreements.agreement_versions WHERE agreement_id = '${lost.agreementId}' AND number < 0`,
      )
    })
    await reconcile()
    expect((await statusOf(bad.agreementId, bad.versionId)).agreement).toBe("sent")
  }, 180_000)
})

describe("a draft an earlier release left with links", () => {
  it("half a send is never sent or sealed: its signature is kept, its people are told once, and they decide", async () => {
    const p = await cutSend("Half made", 2)
    await asMadeOneByOne(p.versionId, 1)
    const one = asSigner(p.versionId, 1)
    await signAs(one.token(), one.who, "198.51.100.101")
    await reconcile()
    await reconcile()
    expect(await statusOf(p.agreementId, p.versionId)).toEqual({
      agreement: "draft",
      version: "frozen",
      sealed: false,
    })
    expect(await recordedFor(p.versionId)).toHaveLength(1)
    const told = await toldOf(p.agreementId)
    expect(told.map((t) => t.user_id)).toEqual([w.admin.userId])
    expect(told[0]?.summary).toContain("may have stopped before every signer had a link")
    // Everyone asked again: refused, and still a draft.
    const out = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 2))
    expect(JSON.stringify(out)).toContain("ALREADY_SENT")
    expect(JSON.stringify(out)).toContain("stays a draft")
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
    const voided = await asPerson(w.admin.userId, "agreement_void", {
      id: p.agreementId,
      reason: "Sent by half",
    })
    expect(voided.data?.status).toBe("ok")
    expect(await recordedFor(p.versionId)).toHaveLength(1)
  }, 120_000)

  it("a whole one is a person's to call sent: the same send again does, and mails nobody", async () => {
    const p = await cutSend("Whole, made one by one", 2)
    await asMadeOneByOne(p.versionId, 0)
    await reconcile()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
    const again = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 2))
    expect(again.data).toMatchObject({ status: "ok", already_sent: true })
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("sent")
    await oneMailEach(p.versionId, 2)
  }, 120_000)

  it("a draft edited after its send was cut off is not taken for sent", async () => {
    const p = await cutSend("Edited since", 1)
    await owner.unsafe(`UPDATE app_agreements.agreement_drafts
      SET source = '{"body":{"blocks":[{"type":"paragraph","text":"Renegotiated."}]}}'::jsonb
      WHERE agreement_id = '${p.agreementId}'`)
    await reconcile()
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
    const one = asSigner(p.versionId, 1)
    await signAs(one.token(), one.who, "198.51.100.102")
    expect(await statusOf(p.agreementId, p.versionId)).toEqual({
      agreement: "draft",
      version: "frozen",
      sealed: false,
    })
    expect((await toldOf(p.agreementId))[0]?.summary).toContain("The draft changed after version 1")
  }, 120_000)
})

describe("a version prepared while the one before is being sent", () => {
  for (const cut of [false, true]) {
    it(`${cut ? "and the send is cut off" : "the send says so"}: no sent agreement without links, and the new version can be sent`, async () => {
      const p = await preparedAgreement(`Prepared meanwhile ${cut}`)
      await trigger(
        "kernel.client_actions",
        "INSERT",
        `NEW.target_id = '${p.versionId}' AND (SELECT count(*) FROM kernel.client_actions WHERE target_id = NEW.target_id) = 0`,
        "PERFORM pg_sleep(4);",
      )
      const sending = cut
        ? sendCutOff(p, 2)
        : asPerson(w.admin.userId, "agreement_send", sendParams(p, 2))
      await new Promise((r) => setTimeout(r, 700))
      const next = await asPerson(w.admin.userId, "agreement_prepare", { id: p.agreementId })
      expect(next.data?.status).toBe("ok")
      const out = await sending
      if (!cut) expect(JSON.stringify(out)).toContain("VERSION_CHANGED")
      await until(async () => (await linkRows(p.versionId)).length === 2)
      await dropTriggers()
      await drainOutbox()
      await drainOutbox()
      expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("draft")
      expect((await linkRows(p.versionId)).every((r) => r.revoked_at)).toBe(true)
      const v2 = {
        versionId: next.data?.version_id as string,
        sha256: next.data?.sha256 as string,
      }
      const sent = await asPerson(w.admin.userId, "agreement_send", sendParams(v2, 2))
      expect(sent.data?.status).toBe("ok")
      await drainOutbox()
      expect((await statusOf(p.agreementId, v2.versionId)).agreement).toBe("sent")
    }, 120_000)
  }

  it("seen as sent before the newer version: the job puts it back to a draft and tells its people", async () => {
    const p = await cutSend("Seen as sent first", 2)
    const id = await decidedUnheard(p.versionId, 1)
    await owner.unsafe(
      insertSql("app_agreements.agreement_versions", {
        org_id: w.orgId,
        agreement_id: p.agreementId,
        number: 2,
        status: "frozen",
        sha256: "e".repeat(64),
        frozen_at: { raw: "now()" },
      }),
    )
    await owner.unsafe(
      `UPDATE app_agreements.agreements SET status = 'sent' WHERE id = '${p.agreementId}'`,
    )
    await reconcile()
    expect(await statusOf(p.agreementId, p.versionId)).toEqual({
      agreement: "draft",
      version: "superseded",
      sealed: false,
    })
    expect(await recordedFor(p.versionId)).toEqual([id])
    expect((await toldOf(p.agreementId))[0]?.summary).toContain("Send version 2")
    const open = (await linkRows(p.versionId)).filter((r) => !r.revoked_at && !r.decided_at)
    expect(open).toEqual([])
  }, 120_000)
})

describe("who may send, and who signs", () => {
  it("a role that may send can send, and nothing else opens to it", async () => {
    const role = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.roles", { id: role, org_id: w.orgId, name: `lead-${role.slice(0, 8)}` }),
    )
    for (const scope of SCOPES)
      await sql.unsafe(insertSql("kernel.role_scope_grants", { role_id: role, scope }))
    await sql.unsafe(
      insertSql("kernel.user_roles", {
        user_id: w.member.userId,
        role_id: role,
        org_id: w.orgId,
      }),
    )
    const created = await asPerson(w.member.userId, "agreement_create", {
      kind: "nda",
      title: "Sent by its lead",
      source: { body: { blocks: [{ type: "paragraph", text: "The parties agree." }] } },
    })
    const id = created.data?.agreement?.id as string
    const prepared = await asPerson(w.member.userId, "agreement_prepare", { id })
    const p = {
      versionId: prepared.data?.version_id as string,
      sha256: prepared.data?.sha256 as string,
    }
    const sent = await asPerson(w.member.userId, "agreement_send", sendParams(p, 2))
    expect(sent.error).toBeUndefined()
    expect(sent.data?.status).toBe("ok")
    await oneMailEach(p.versionId, 2)
    // Their own call to the kernel's read stays refused, as does one of a document closed to them.
    const direct = await asPerson(w.member.userId, "client_action_view_get", {
      targetType: "agreement_version",
      targetId: p.versionId,
    })
    expect(JSON.stringify(direct)).toContain("agreements:internal")
    const closed = await preparedAgreement("Closed to the lead")
    await owner.unsafe(
      `UPDATE app_agreements.agreements SET org_access = 'none', acl_user_ids = '["${w.admin.userId}"]'::jsonb WHERE id = '${closed.agreementId}'`,
    )
    const refused = await asPerson(w.member.userId, "agreement_send", sendParams(closed, 1))
    expect(JSON.stringify(refused)).toContain("NOT_FOUND")
    expect(await linkRows(closed.versionId)).toHaveLength(0)
    const one = asSigner(p.versionId, 1)
    const two = asSigner(p.versionId, 2)
    await signAs(one.token(), one.who, "198.51.100.103")
    await signAs(two.token(), two.who, "198.51.100.104")
    expect(await statusOf(id, p.versionId)).toEqual({
      agreement: "signed",
      version: "signed",
      sealed: true,
    })
  }, 180_000)

  it("two people at one address each sign with their own name and code, and it is signed only by both", async () => {
    const p = await preparedAgreement("A couple")
    const email = `couple-${p.versionId.slice(0, 8)}@signers.example`
    const sent = await asPerson(w.admin.userId, "agreement_send", {
      version_id: p.versionId,
      sha256: p.sha256,
      order: "any",
      expires_in_days: 7,
      signers: [
        { email, name: "Anne Couple" },
        { email, name: "Jean Couple" },
      ],
    })
    expect(sent.data?.message).toContain("Anne Couple, Jean Couple can sign now")
    await until(() => linkMails(p.versionId).length === 2)
    const tokenFor = (name: string) =>
      tokenOf(
        linkMails(p.versionId).find((m) => m.text?.includes(name)) as (typeof capture.sent)[number],
      )
    await signAs(tokenFor("Anne Couple"), { email, name: "Anne Couple" }, "198.51.100.105")
    expect((await statusOf(p.agreementId, p.versionId)).agreement).toBe("partly_signed")
    await signAs(tokenFor("Jean Couple"), { email, name: "Jean Couple" }, "198.51.100.106")
    expect(await statusOf(p.agreementId, p.versionId)).toEqual({
      agreement: "signed",
      version: "signed",
      sealed: true,
    })
    const names = (await sql`
      SELECT typed_name FROM ${app("signature_events")}
       WHERE version_id = ${p.versionId} ORDER BY typed_name`) as unknown as Array<{
      typed_name: string
    }>
    expect(names.map((n) => n.typed_name)).toEqual(["Anne Couple", "Jean Couple"])
  }, 120_000)
})

describe("a reminder of 40 signers cut off half way", () => {
  it("mails each once; the same reminder again mails nobody and says so", async () => {
    const p = await preparedAgreement("Reminded")
    const sent = await asPerson(w.admin.userId, "agreement_send", sendParams(p, 40))
    const ids = ((sent.data?.client_actions ?? []) as Array<{ id: string }>).map((a) => a.id)
    await oneMailEach(p.versionId, 40)
    await trigger(
      "kernel.client_actions",
      "UPDATE",
      `NEW.id = '${ids[20]}' AND NEW.token_hash IS DISTINCT FROM OLD.token_hash`,
      "PERFORM pg_sleep(5);",
    )
    process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = "1500"
    const cut = await asPerson(w.admin.userId, "agreement_reminder_send", {
      client_action_ids: ids,
    })
    delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
    expect(cut.error?.code).toBe("timeout")
    const again = await asPerson(w.admin.userId, "agreement_reminder_send", {
      client_action_ids: ids,
    })
    expect(again.data).toMatchObject({ status: "ok", reminded: [] })
    expect(again.data?.message).toContain("minutes ago")
    await until(() => linkMails(p.versionId).length >= 80)
    await new Promise((r) => setTimeout(r, 300))
    expect(linkMails(p.versionId)).toHaveLength(80)
  }, 120_000)
})
