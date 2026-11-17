// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal's agreement reads: a client reads their company's agreements behind an
// open agreement share, a restricted one only when the share names them, the
// versions frozen or signed, and who each link waits on. Each door test fails when
// its predicate is taken out of its view.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { registerApps } from "~/modules/apps/runtime"
import { createPortalSession } from "~/modules/auth/auth"
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
async function agreement(companyId: string, opts: { orgAccess?: string; status?: string } = {}) {
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
  return { id, versionId }
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
      await tx.unsafe("DELETE FROM app_agreements.agreement_versions WHERE org_id = $1", [w.orgId])
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
})
