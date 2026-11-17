// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A quote sent for acceptance, through the real path: the invoicing app registered from its
// manifest, its own read tool run in the sandbox, which names the issued PDF and no hash. The
// kernel fingerprints the stored PDF itself (SHA-256 of its bytes), records that on the link,
// and checks it again when the client answers: an accept records against it and invoicing's own
// subscriber sets the quote accepted, with no invoice; a PDF whose bytes changed is refused.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { putObject } from "~/infra/storage/object-storage"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { mintClientAction } from "~/modules/client-actions/mint"
import { insertAppRow } from "~/seed/factories/app-tables"
import { seedFileRow } from "~/seed/factories/files/file-row"
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
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const inv = (table: string) => sql(`${schemaRef("app_invoicing")}.${table}`)

let w: DoorWorld
const capture = new CaptureProvider()
let previousMail: EmailProvider
let issuerId = ""

function descriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _firstParty: true,
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

async function mailTo(email: string, template: string, after: number) {
  for (let i = 0; i < 250; i++) {
    const m = capture.sent.find((x, n) => n >= after && x.to === email && x.template === template)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no ${template} mail to ${email}`)
}

/** A stored PDF of the org: its bytes in the bucket and its kernel row. */
async function storedPdf(bytes: Buffer): Promise<{ id: string; key: string }> {
  const id = crypto.randomUUID()
  const key = `test/${w.orgId}/${id}.pdf`
  await putObject({ key, body: bytes, contentType: "application/pdf" })
  await seedFileRow({
    id,
    orgId: w.orgId,
    app: "invoicing",
    entityType: "document",
    entityId: id,
    filename: "quote.pdf",
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    storageKey: key,
  })
  return { id, key }
}

async function sentQuote(number: string, pdfFileId: string): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(w.orgId, "test:quote", async (tx) => {
    await insertAppRow(tx, "invoicing", "documents", {
      org_id: w.orgId,
      id,
      type: "quote",
      status: "sent",
      number,
      issuer_profile_id: issuerId,
      currency: "EUR",
      subtotal_minor: "100000",
      grand_total_minor: "120000",
      counterparty_name: "Maison A",
      pdf_file_id: pdfFileId,
    })
  })
  return id
}

const mint = (quoteId: string) =>
  mintClientAction({
    orgId: w.orgId,
    kind: "accept",
    targetApp: "invoicing",
    targetType: "document",
    targetId: quoteId,
    contactId: w.clientA.contactId,
    companyId: w.companyA,
    invitedEmail: w.clientA.email,
    invitedName: w.clientA.name,
    expiresInDays: 14,
    createdByUserId: w.admin.userId,
  })

/** Open the link, read the quote, take the code and prove it: the proof a decide spends. */
async function proved(token: string, ip: string) {
  const h = { "x-bun-socket-ip": ip }
  expect((await call("open", { t: token }, h)).status).toBe(200)
  // The issued PDF downloads byte for byte; the quote's lines show it before an answer.
  const file = await call("document", { t: token, format: "pdf" }, h)
  expect(file.status).toBe(200)
  expect((await call("document", { t: token, format: "blocks" }, h)).status).toBe(200)
  await clearRedisPatterns(["ca:code:gap:*"])
  const codeAt = capture.sent.length
  expect((await call("code", { t: token }, h)).status).toBe(202)
  const code = codeOf(await mailTo(w.clientA.email, "client-action.code", codeAt))
  const verified = await call("verify", { t: token, code, name: w.clientA.name }, h)
  expect(verified.status).toBe(200)
  return { h, proof: ((await verified.json()) as { proof: string }).proof }
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  previousMail = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createDoorWorld()
  await ensureAppsForOrg(w.orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], w.orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(w.orgId, 0)
  issuerId = crypto.randomUUID()
  await withPrivilegedDb(w.orgId, "test:issuer", async (tx) => {
    await insertAppRow(tx, "invoicing", "issuer_profiles", {
      org_id: w.orgId,
      id: issuerId,
      legal_name: "Maison Studio SAS",
      country: "FR",
      default_currency: "EUR",
    })
  })
}, 300_000)

afterAll(async () => {
  forgetOrgApps(w?.orgId ?? "")
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  setSystemEmailProvider(previousMail)
  await clearRedisPatterns(["ca:*"])
  if (w) {
    await sql`DELETE FROM ${inv("documents")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${inv("issuer_profiles")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("a quote sent for acceptance", () => {
  it("gets the stored PDF's fingerprint from the kernel, and the client's accept records against it and sets the quote accepted with no invoice", async () => {
    const bytes = Buffer.from(`%PDF-1.4\nquote Q-0101 ${crypto.randomUUID()}\n%%EOF\n`)
    const pdf = await storedPdf(bytes)
    const quoteId = await sentQuote("Q-0101", pdf.id)
    const before = capture.sent.length
    const minted = await mint(quoteId)
    const [row] = (await sql`
      SELECT target_sha256 FROM ${kernel("client_actions")} WHERE id = ${minted.id}`) as unknown as Array<{
      target_sha256: string
    }>
    expect(row?.target_sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const { h, proof } = await proved(token, "198.51.100.61")
    const accepted = await call(
      "decide",
      { t: token, proof, decision: "accept", typed_name: w.clientA.name },
      h,
    )
    expect(accepted.status).toBe(200)
    await drainOutbox()
    const [decided] = (await sql`
      SELECT decision, target_sha256 FROM ${kernel("client_actions")} WHERE id = ${minted.id}`) as unknown as Array<{
      decision: string
      target_sha256: string
    }>
    expect(decided).toMatchObject({
      decision: "accepted",
      target_sha256: row?.target_sha256,
    })
    let status = ""
    for (let i = 0; i < 100 && status !== "accepted"; i++) {
      const [q] = (await sql`
        SELECT status FROM ${inv("documents")} WHERE id = ${quoteId}`) as unknown as Array<{
        status: string
      }>
      status = q?.status ?? ""
      if (status !== "accepted") await new Promise((r) => setTimeout(r, 50))
    }
    expect(status).toBe("accepted")
    const [invoices] = (await sql`
      SELECT count(*)::int AS n FROM ${inv("documents")}
       WHERE org_id = ${w.orgId} AND type = 'invoice'`) as unknown as Array<{ n: number }>
    expect(invoices?.n).toBe(0)
  }, 180_000)

  it("refuses an accept once the stored PDF's bytes changed, and the quote stays sent", async () => {
    const pdf = await storedPdf(Buffer.from(`%PDF-1.4\nquote Q-0102 first\n%%EOF\n`))
    const quoteId = await sentQuote("Q-0102", pdf.id)
    const before = capture.sent.length
    await mint(quoteId)
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const { h, proof } = await proved(token, "198.51.100.62")
    await putObject({
      key: pdf.key,
      body: Buffer.from(`%PDF-1.4\nquote Q-0102 changed\n%%EOF\n`),
      contentType: "application/pdf",
    })
    const refused = await call(
      "decide",
      { t: token, proof, decision: "accept", typed_name: w.clientA.name },
      h,
    )
    expect(refused.status).toBe(409)
    await drainOutbox()
    const [q] = (await sql`
      SELECT status FROM ${inv("documents")} WHERE id = ${quoteId}`) as unknown as Array<{
      status: string
    }>
    expect(q?.status).toBe("sent")
  }, 180_000)
})
