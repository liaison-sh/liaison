// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can see an agreement, at the data layer. The agreements app declares `sharedRows` on
// every table: with `org_access = 'none'` only the people on the agreement's list read its
// rows, whatever scope or grant a reader holds (`*` included), and the list itself is closed
// the same way. Registered through the real runtime, read under `liaison_rls`.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { registerApps } from "~/modules/apps/runtime"
import { type AppCell, insertAppRow } from "~/seed/factories/app-tables"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import agreementsManifest from "../../../../../bundled-apps/agreements/app.manifest.json"

const orgId = crypto.randomUUID()
const listed = crypto.randomUUID()
const member = crypto.randomUUID()
const admin = crypto.randomUUID()

const TABLES = [
  "agreements",
  "agreement_shares",
  "agreement_drafts",
  "agreement_versions",
  "signature_events",
  "evidence_packages",
] as const

function agreements() {
  return {
    ...agreementsManifest,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../bundled-apps/.source/agreements/${agreementsManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
}

const reader = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

/** Rows of each table this reader sees. */
async function seen(ctx: UserContext): Promise<Record<string, number>> {
  return withRlsContext(ctx, async (tx) => {
    const out: Record<string, number> = {}
    for (const t of TABLES) {
      const rows = (await tx.execute(
        dsql.raw(`SELECT count(*)::int AS n FROM app_agreements.${t}`),
      )) as unknown as Array<{ n: number }>
      out[t] = Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
    }
    return out
  })
}

const READ = ["agreements:agreements:read", "agreements:evidence:read"]
let agreementId = ""

async function setOrgAccess(access: "none" | "viewer" | "editor") {
  await withPrivilegedDb(orgId, "test:agreement-access", async (tx) => {
    await tx.execute(
      dsql`UPDATE app_agreements.agreements SET org_access = ${access} WHERE id = ${agreementId}` as never,
    )
  })
}

beforeAll(async () => {
  await acquireTestLock()
  await seedOrgRow({ id: orgId, name: "Maison Accords", slug: `restricted-${orgId.slice(0, 8)}` })
  const { failedApps } = await registerApps([agreements()], orgId, { skipOrgRows: true })
  expect(failedApps).toEqual([])
  agreementId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test:agreement-rows", async (tx) => {
    const now = new Date().toISOString()
    const put = (table: string, row: Record<string, AppCell>) =>
      insertAppRow(tx, "agreements", table, { org_id: orgId, ...row })
    await put("agreements", {
      id: agreementId,
      number: "AG-2026-001",
      kind: "nda",
      title: "Closed agreement",
      org_access: "none",
    })
    await put("agreement_shares", { agreement_id: agreementId, user_id: listed, role: "editor" })
    await put("agreement_drafts", { agreement_id: agreementId })
    await put("agreement_versions", {
      id: versionId,
      agreement_id: agreementId,
      number: 1,
      frozen_at: now,
    })
    await put("signature_events", {
      version_id: versionId,
      client_action_id: crypto.randomUUID(),
      invited_email: "a@b.example",
      invited_by: "x",
      typed_name: "A B",
      capacity: "self",
      consent_words: "I sign",
      consent_lang: "en",
      level: "ses",
      document_sha256: "ab",
      signed_at: now,
    })
    await put("evidence_packages", {
      version_id: versionId,
      level: "ses",
      hash_alg: "sha-256",
      seal_version: 1,
      document_sha256: "ab",
      sealed_at: now,
    })
  })
}, 180_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`.catch(() => {})
  await releaseTestLock()
})

describe("who can see an agreement", () => {
  it("with org access none a member with the read scope, an admin holding every scope and an agent acting for them read zero rows from every table", async () => {
    await setOrgAccess("none")
    const zero = Object.fromEntries(TABLES.map((t) => [t, 0]))
    expect(await seen(reader(member, READ))).toEqual(zero)
    expect(await seen(reader(admin, ["*"]))).toEqual(zero)
    // An agent acting for a person reads with that person's id and the agent's own ceiling.
    expect(await seen(reader(admin, ["agreements:*"]))).toEqual(zero)
    const one = Object.fromEntries(TABLES.map((t) => [t, 1]))
    expect(await seen(reader(listed, READ))).toEqual(one)
  })

  it("a person removed from the list reads nothing; an open agreement reads normally", async () => {
    await withPrivilegedDb(orgId, "test:agreement-access", async (tx) => {
      await tx.execute(
        dsql`UPDATE app_agreements.agreement_shares SET removed_at = now() WHERE user_id = ${listed}` as never,
      )
    })
    expect((await seen(reader(listed, READ))).agreements).toBe(0)
    await setOrgAccess("viewer")
    const one = Object.fromEntries(TABLES.map((t) => [t, 1]))
    expect(await seen(reader(member, READ))).toEqual(one)
    // The scope still decides for an open agreement: no read scope, no rows.
    expect((await seen(reader(member, []))).agreements).toBe(0)
  })
})
