// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal's agreement reads: a client reads their company's agreements behind an
// open agreement share, a restricted one only when the share names them, the
// versions frozen or signed, and who each link waits on; a version's page pictures and
// its sealed files, a client's own copy only; and the signing link of a version behind
// a share made on the agreement itself. Each door test fails when its predicate is
// taken out of its view or function.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withPortalContext } from "~/db/portal-rls"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { registerApps } from "~/modules/apps/runtime"
import { createPortalSession } from "~/modules/auth/auth"
import { portalFileStorage } from "~/modules/portal/file-stream"
import { ensurePortalViews } from "~/modules/portal/views"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import agreementsManifest from "../../../../../../bundled-apps/agreements/app.manifest.json"
import {
  createDoorWorld,
  type DoorPerson,
  type DoorWorld,
  dropDoorWorld,
  insertClientAction,
  insertShare,
} from "./fixture"
import { insertFile } from "./reads-world"

let w: DoorWorld
const tokens: Record<string, string> = {}

async function registerAgreementsSchema(orgId: string): Promise<void> {
  const desc = {
    ...agreementsManifest,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../../bundled-apps/.source/agreements/${agreementsManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
  const { failedApps } = await registerApps([desc], orgId, { skipOrgRows: true })
  if (failedApps.length > 0)
    throw new Error(`agreements did not register: ${failedApps.join(", ")}`)
}

async function get(path: string, as: DoorPerson = w.clientA) {
  if (!tokens[as.userId])
    tokens[as.userId] = (await createPortalSession(as.userId, w.orgId)).accessToken
  return app.request(`/api/portal${path}`, {
    headers: { Authorization: `Bearer ${tokens[as.userId]}` },
  })
}

/** An agreement of the first org with one frozen version. */
async function agreement(
  companyId: string,
  opts: { orgAccess?: string; status?: string; withFiles?: boolean } = {},
) {
  const id = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  await sql.unsafe(
    insertSql("app_agreements.agreements", {
      id,
      org_id: w.orgId,
      number: `AG-${id.slice(0, 6)}`,
      kind: "sow",
      status: opts.status ?? "sent",
      title: "Mission Alpha",
      company_id: companyId,
      org_access: opts.orgAccess ?? "editor",
      language: "fr",
    }),
  )
  await sql.unsafe(
    insertSql("app_agreements.agreement_versions", {
      id: versionId,
      org_id: w.orgId,
      agreement_id: id,
      number: 1,
      source: { raw: `'{"body":{"blocks":[]}}'::jsonb` },
      sha256: "c".repeat(64),
      status: "frozen",
      frozen_at: { raw: "now()" },
    }),
  )
  if (!opts.withFiles) return { id, versionId, fileId: "", pageFileId: "" }
  const onVersion = { app: "agreements", entity_type: "agreement_version", entity_id: versionId }
  const fileId = await insertFile(w, onVersion)
  const pageFileId = await insertFile(w, onVersion)
  const pages = JSON.stringify([
    { n: 1, width: 800, height: 1100, picture_file_id: pageFileId, text: "Mission Alpha" },
  ])
  await sql.unsafe(
    `UPDATE app_agreements.agreement_versions SET file_id = $1, pages = $2::jsonb WHERE id = $3`,
    [fileId, pages, versionId],
  )
  return { id, versionId, fileId, pageFileId }
}

/** A sealed package on a version: the signed PDF, the staff file, one signer's copy and the colleague's. */
async function sealed(versionId: string, signerActionId: string) {
  const parent = { app: "agreements", entity_type: "evidence_package", entity_id: versionId }
  const signed = await insertFile(w, parent)
  const staff = await insertFile(w, parent)
  const own = await insertFile(w, parent)
  const colleague = await insertFile(w, parent)
  await sql.unsafe(
    insertSql("app_agreements.evidence_packages", {
      id: crypto.randomUUID(),
      org_id: w.orgId,
      version_id: versionId,
      level: "ses",
      hash_alg: "sha256",
      seal_version: 1,
      document_sha256: "c".repeat(64),
      signed_pdf_file_id: signed,
      evidence_file_id: staff,
      signer_copy_file_ids: {
        raw: `'${JSON.stringify({ [signerActionId]: own, colleague })}'::jsonb`,
      },
      sealed_at: { raw: "now()" },
    }),
  )
  return { signed, staff, own, colleague }
}

/** The client actions the portal view shows a person, read on the portal's own login. */
async function portalActionIds(as: DoorPerson): Promise<string[]> {
  return withPortalContext({ orgId: w.orgId, userId: as.userId }, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`SELECT id FROM portal.client_actions`),
    ).map((r) => r.id),
  )
}

/** Storage answering one byte for any key, so an allowed file streams. */
function fakeStorage() {
  return spyOn(portalFileStorage, "open").mockImplementation(async () => ({
    stream: new Blob(["x"]).stream(),
    contentType: "image/webp",
    contentLength: 1,
  }))
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  await registerAgreementsSchema(w.orgId)
  // The views as the code holds them now, as boot puts them back.
  await withSystemDb("portal-documents-test-views", (tx) =>
    ensurePortalViews(tx, "agreements", "compare"),
  )
}, 180_000)

afterAll(async () => {
  if (w) {
    await sql.unsafe(
      `UPDATE "${schemaRef("kernel")}".organizations SET deleting_at = now() WHERE id = $1`,
      [w.orgId],
    )
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_admin")
      await tx.unsafe("SELECT set_config('liaison.demo_purge_org', $1, true)", [w.orgId])
      await tx.unsafe("DELETE FROM app_agreements.evidence_packages WHERE org_id = $1", [w.orgId])
      await tx.unsafe("DELETE FROM app_agreements.agreement_versions WHERE org_id = $1", [w.orgId])
      await tx.unsafe("DELETE FROM kernel.files WHERE org_id = $1", [w.orgId])
      await tx.unsafe("DELETE FROM app_agreements.agreements WHERE org_id = $1", [w.orgId])
    })
    await dropDoorWorld(w)
  }
  await sql.unsafe("REVOKE liaison_portal FROM liaison_request GRANTED BY liaison").catch(() => {})
  await releaseTestLock()
})

describe("portal documents", () => {
  it("NT-20 company B's agreement gives the same 404 as a random id, and is absent from A's list", async () => {
    const a = await agreement(w.companyA)
    const b = await agreement(w.companyB)
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: a.id })
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: b.id })
    expect((await get(`/documents/${b.id}`, w.clientB)).status).toBe(200)
    const asB = await get(`/documents/${b.id}`)
    const random = await get(`/documents/${crypto.randomUUID()}`)
    expect(asB.status).toBe(404)
    expect(await asB.text()).toBe(await random.text())
    const list = ((await (await get("/documents")).json()) as { data: Array<{ id: string }> }).data
    expect(list.map((x) => x.id)).toEqual([a.id])
  })

  it("an agreement shared on its version reads with its source and who its link waits on, and the link is the invited person's only", async () => {
    const a = await agreement(w.companyA)
    // The automatic share of a send names the version its link is for.
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: a.versionId })
    await insertClientAction(w, {
      company_id: w.companyA,
      target_id: a.versionId,
      invited_email: w.clientA.email,
      invited_name: w.clientA.name,
    })
    const mine = (await (await get(`/documents/${a.id}`)).json()) as {
      data: {
        versions: Array<{ id: string; source: unknown }>
        actions: Array<{ invitedName: string; mine: boolean; words?: string }>
      }
    }
    expect(mine.data.versions.map((v) => v.id)).toEqual([a.versionId])
    expect(mine.data.actions).toHaveLength(1)
    expect(mine.data.actions[0]?.mine).toBe(true)
    expect(mine.data.actions[0]?.words).toContain("Mission Alpha")
    const colleague = (await (await get(`/documents/${a.id}`, w.clientA2)).json()) as {
      data: { actions: Array<{ invitedName: string; mine: boolean; words?: string }> }
    }
    expect(colleague.data.actions[0]?.invitedName).toBe(w.clientA.name)
    expect(colleague.data.actions[0]?.mine).toBe(false)
    expect(colleague.data.actions[0]?.words).toBeUndefined()
    // No address of anyone in either body.
    expect(JSON.stringify(colleague)).not.toContain(w.clientA.email)
  })

  it("a restricted agreement reads only for the portal people its share names; a draft for nobody", async () => {
    const r = await agreement(w.companyA, { orgAccess: "none" })
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: r.id })
    expect((await get(`/documents/${r.id}`)).status).toBe(404)
    const named = await agreement(w.companyA, { orgAccess: "none" })
    await insertShare(w, {
      company_id: w.companyA,
      kind: "agreement",
      object_id: named.id,
      only_user_ids: [w.clientA.userId],
    })
    expect((await get(`/documents/${named.id}`)).status).toBe(200)
    expect((await get(`/documents/${named.id}`, w.clientA2)).status).toBe(404)
    const draft = await agreement(w.companyA, { status: "draft" })
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: draft.id })
    expect((await get(`/documents/${draft.id}`)).status).toBe(404)
  })

  it("NT-20 company B's page pictures and frozen file give the same 404 as a random id; an infected version names none of its files", async () => {
    const a = await agreement(w.companyA, { withFiles: true })
    const b = await agreement(w.companyB, { withFiles: true })
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: a.id })
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: b.id })
    const open = fakeStorage()
    try {
      // Company B reads its own: the ids are real.
      expect((await get(`/documents/${b.versionId}/pages/1`, w.clientB)).status).toBe(200)
      expect((await get(`/files/${b.fileId}`, w.clientB)).status).toBe(200)
      const own = await get(`/documents/${a.versionId}/pages/1`)
      expect(own.status).toBe(200)
      expect(own.headers.get("cache-control")).toBe("no-store")
      expect((await get(`/documents/${a.id}/pages/1`)).status).toBe(200)
      expect((await get(`/files/${a.pageFileId}`)).status).toBe(200)
      const random = await (await get(`/documents/${crypto.randomUUID()}/pages/1`)).text()
      for (const path of [
        `/documents/${b.versionId}/pages/1`,
        `/documents/${b.id}/pages/1`,
        `/documents/${a.versionId}/pages/2`,
      ]) {
        const res = await get(path)
        expect({ path, status: res.status }).toEqual({ path, status: 404 })
        expect(await res.text()).toBe(random)
      }
      const randomFile = await (await get(`/files/${crypto.randomUUID()}`)).text()
      for (const file of [b.fileId, b.pageFileId]) {
        const res = await get(`/files/${file}`)
        expect(res.status).toBe(404)
        expect(await res.text()).toBe(randomFile)
      }
      // A scan found the frozen file infected: neither it nor its pages are served.
      await sql.unsafe(
        `UPDATE app_agreements.agreement_versions SET scan_state = 'infected' WHERE id = $1`,
        [a.versionId],
      )
      for (const path of [
        `/documents/${a.versionId}/pages/1`,
        `/files/${a.fileId}`,
        `/files/${a.pageFileId}`,
      ]) {
        const res = await get(path)
        expect({ path, status: res.status }).toEqual({ path, status: 404 })
      }
      // Only allowed files were ever opened: B's own two, A's three before the scan.
      expect(open).toHaveBeenCalledTimes(5)
    } finally {
      open.mockRestore()
    }
  })

  it("a signer is given the signed PDF and their own copy, a colleague the copy with no device, nobody the staff file", async () => {
    const a = await agreement(w.companyA, { withFiles: true })
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: a.id })
    const action = await insertClientAction(w, {
      company_id: w.companyA,
      target_id: a.versionId,
      decided_at: { raw: "now()" },
      decision: "signed",
      decided_via: "portal",
    })
    const f = await sealed(a.versionId, action)
    const b = await agreement(w.companyB, { withFiles: true })
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: b.id })
    const open = fakeStorage()
    try {
      type Doc = { data: { evidence: Array<{ signedPdfFileId: string; copyFileId: string }> } }
      const mine = (await (await get(`/documents/${a.id}`)).json()) as Doc
      expect(mine.data.evidence).toEqual([
        expect.objectContaining({ signedPdfFileId: f.signed, copyFileId: f.own }),
      ])
      const colleague = (await (await get(`/documents/${a.id}`, w.clientA2)).json()) as Doc
      expect(colleague.data.evidence).toEqual([
        expect.objectContaining({ signedPdfFileId: f.signed, copyFileId: f.colleague }),
      ])
      const status = async (file: string, as: DoorPerson) =>
        (await get(`/files/${file}`, as)).status
      expect(await status(f.signed, w.clientA)).toBe(200)
      expect(await status(f.own, w.clientA)).toBe(200)
      expect(await status(f.colleague, w.clientA)).toBe(404)
      expect(await status(f.signed, w.clientA2)).toBe(200)
      expect(await status(f.colleague, w.clientA2)).toBe(200)
      expect(await status(f.own, w.clientA2)).toBe(404)
      for (const as of [w.clientA, w.clientA2, w.clientB])
        expect(await status(f.staff, as)).toBe(404)
      expect(await status(f.signed, w.clientB)).toBe(404)
      expect(await status(f.own, w.clientB)).toBe(404)
    } finally {
      open.mockRestore()
    }
  })

  it("a share on the agreement itself shows its versions' open link; a closed share, or another company's agreement, shows none", async () => {
    const a = await agreement(w.companyA)
    const share = await insertShare(w, {
      company_id: w.companyA,
      kind: "agreement",
      object_id: a.id,
    })
    const action = await insertClientAction(w, {
      company_id: w.companyA,
      target_id: a.versionId,
      invited_email: w.clientA.email,
      invited_name: w.clientA.name,
    })
    type Doc = { data: { actions: Array<{ id: string; mine: boolean; words?: string }> } }
    const mine = (await (await get(`/documents/${a.id}`)).json()) as Doc
    expect(mine.data.actions.map((x) => x.id)).toEqual([action])
    expect(mine.data.actions[0]?.mine).toBe(true)
    expect(mine.data.actions[0]?.words).toContain("Mission Alpha")
    // The colleague sees who it waits on through the same share.
    const colleague = (await (await get(`/documents/${a.id}`, w.clientA2)).json()) as Doc
    expect(colleague.data.actions.map((x) => x.id)).toEqual([action])

    // A link stamped for company A whose version is another company's agreement stays
    // hidden, though a share of company A names that agreement.
    const b = await agreement(w.companyB)
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: b.id })
    const stray = await insertClientAction(w, { company_id: w.companyA, target_id: b.versionId })
    const visible = await portalActionIds(w.clientA)
    expect(visible).toContain(action)
    expect(visible).not.toContain(stray)

    // The share closed: the link is gone with the document.
    await sql.unsafe(
      `UPDATE "${schemaRef("kernel")}".portal_shares SET closed_at = now() WHERE id = $1`,
      [share],
    )
    expect((await get(`/documents/${a.id}`)).status).toBe(404)
    expect(await portalActionIds(w.clientA)).not.toContain(action)
  })

  it("NT-20 an agreement or a link with no company is nobody's, though a share names it", async () => {
    const a = await agreement(w.companyA, { withFiles: true })
    await sql.unsafe(`UPDATE app_agreements.agreements SET company_id = NULL WHERE id = $1`, [a.id])
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: a.id })
    const open = fakeStorage()
    try {
      expect((await get(`/documents/${a.id}`)).status).toBe(404)
      expect((await get(`/documents/${a.versionId}/pages/1`)).status).toBe(404)
      expect((await get(`/files/${a.fileId}`)).status).toBe(404)
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
    const mine = await agreement(w.companyA)
    await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: mine.id })
    const unstamped = await insertClientAction(w, { company_id: null, target_id: mine.versionId })
    expect(await portalActionIds(w.clientA)).not.toContain(unstamped)
  })
})
