// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-database proof that nobody edits a signed agreement's evidence from the
// app: a set write-once column of `evidence_packages` and `agreement_versions`
// never changes, and no row of `signature_events` or `evidence_packages` can be
// deleted, under the app's own role (the handlers' RLS transaction), the
// privileged session and the plain app connection. A null write-once column is
// filled once (the timestamp that arrives later).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { upsertAppRow } from "~/seed/factories/app-tables"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const ORG = "00000000-0000-4000-8000-0000000a6e01"
const USER = "00000000-0000-4000-8000-0000000a6e02"
const SCOPES = ["agreements:*"]

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

async function run(q: PromiseLike<unknown>): Promise<void> {
  await q
}

interface Seeded {
  versionId: string
  eventId: string
  packageId: string
}

async function seed(): Promise<Seeded> {
  const agreementId = randomUUID()
  const versionId = randomUUID()
  const eventId = randomUUID()
  const packageId = randomUUID()
  const now = new Date().toISOString()
  await withPrivilegedDb(ORG, "test:agreements-immutability-seed", async (tx) => {
    await upsertAppRow(tx, "agreements", "agreements", {
      id: agreementId,
      org_id: ORG,
      number: `AG-2026-${agreementId.slice(0, 6)}`,
      kind: "nda",
      status: "signed",
      title: "Maison Morel NDA",
      language: "en",
      org_access: "editor",
    })
    await upsertAppRow(tx, "agreements", "agreement_versions", {
      id: versionId,
      org_id: ORG,
      agreement_id: agreementId,
      number: 1,
      sha256: "e".repeat(64),
      frozen_at: now,
      status: "signed",
    })
    await upsertAppRow(tx, "agreements", "signature_events", {
      id: eventId,
      org_id: ORG,
      version_id: versionId,
      client_action_id: randomUUID(),
      invited_email: "paul@maison-morel.example",
      invited_by: "lea@studio.example",
      typed_name: "Paul Morel",
      capacity: "Gérant",
      consent_words: "words",
      consent_lang: "en",
      level: "ses",
      document_sha256: "e".repeat(64),
      signed_at: now,
      ip: "198.51.100.7",
      user_agent: "UA",
    })
    await upsertAppRow(tx, "agreements", "evidence_packages", packageRow(packageId, versionId, now))
  })
  return { versionId, eventId, packageId }
}

function packageRow(id: string, versionId: string, sealedAt: string) {
  return {
    id,
    org_id: ORG,
    version_id: versionId,
    level: "ses",
    hash_alg: "sha256",
    seal_version: 1,
    document_sha256: "e".repeat(64),
    signed_pdf_sha256: "f".repeat(64),
    trail_sha256: "a".repeat(64),
    seal: "b".repeat(64),
    sealed_at: sealedAt,
    timestamp_status: "pending",
  }
}

/**
 * The error text of a statement run as the app's handlers run: the RLS role in
 * the org, as a holder of every agreements scope, who can see the row (checked
 * first, so a statement that matched nothing cannot pass for a refusal).
 */
async function asAppRole(statement: ReturnType<typeof dsql>): Promise<string> {
  return withRlsContext(
    { actorType: "user", userId: USER, orgId: ORG, scopes: SCOPES, dimensionGrants: {} } as never,
    async (tx) => {
      const seen = (await tx.execute(
        dsql`SELECT count(*)::int AS n FROM app_agreements.evidence_packages`,
      )) as unknown as Array<{ n: number }>
      if (!(Number(seen[0]?.n) > 0)) throw new Error("the app role sees no package")
      return tx.execute(statement)
    },
  ).then(
    () => "no error",
    (e: Error & { cause?: unknown }) => `${e.message} ${String(e.cause)}`,
  )
}

async function asPrivileged(statement: ReturnType<typeof dsql>): Promise<string> {
  return withPrivilegedDb(ORG, "test:agreements-immutability", (tx) => tx.execute(statement)).then(
    () => "no error",
    (e: Error & { cause?: unknown }) => `${e.message} ${String(e.cause)}`,
  )
}

describe("agreements evidence is immutable", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await seedOrgRow(
      { id: ORG, name: "Evidence Immutability Org", slug: "evidence-immutability-org" },
      { onConflict: "skip" },
    )
    await seedUserRows(
      [
        {
          id: USER,
          orgId: ORG,
          email: "immutability@test.com",
          passwordHash: "hash",
          name: "Immutability Tester",
          status: "active",
        },
      ],
      { onConflict: "skip" },
    )
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([descriptor() as never], ORG)
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("update of a set column and delete raise under three roles", async () => {
    const s = await seed()
    // Plain app connection.
    await expect(
      run(
        sql`UPDATE app_agreements.evidence_packages SET seal = ${"c".repeat(64)} WHERE id = ${s.packageId}`,
      ),
    ).rejects.toThrow(/immutable_row/)
    await expect(
      run(sql`DELETE FROM app_agreements.evidence_packages WHERE id = ${s.packageId}`),
    ).rejects.toThrow(/immutable_retention/)
    await expect(
      run(sql`DELETE FROM app_agreements.signature_events WHERE id = ${s.eventId}`),
    ).rejects.toThrow(/immutable_retention/)
    await expect(
      run(
        sql`UPDATE app_agreements.agreement_versions SET sha256 = ${"0".repeat(64)} WHERE id = ${s.versionId}`,
      ),
    ).rejects.toThrow(/immutable_row/)
    // The privileged session and the app's own role.
    for (const as of [asPrivileged, asAppRole]) {
      expect(
        await as(
          dsql`UPDATE app_agreements.evidence_packages SET trail_sha256 = ${"9".repeat(64)} WHERE id = ${s.packageId}`,
        ),
      ).toMatch(/immutable_row/)
      expect(
        await as(
          dsql`UPDATE app_agreements.signature_events SET typed_name = 'Someone Else' WHERE id = ${s.eventId}`,
        ),
      ).toMatch(/immutable_row/)
      expect(
        await as(dsql`DELETE FROM app_agreements.evidence_packages WHERE id = ${s.packageId}`),
      ).toMatch(/immutable_retention/)
      expect(
        await as(dsql`DELETE FROM app_agreements.signature_events WHERE id = ${s.eventId}`),
      ).toMatch(/immutable_retention/)
    }
    // Every row is still there.
    const left = await sql`SELECT
      (SELECT count(*)::int FROM app_agreements.evidence_packages WHERE id = ${s.packageId}) AS p,
      (SELECT count(*)::int FROM app_agreements.signature_events WHERE id = ${s.eventId}) AS e`
    expect(left[0]).toEqual({ p: 1, e: 1 })
  })

  it("a signature's evidence field recorded empty stays empty: filling it raises under three roles", async () => {
    const s = await seed()
    await expect(
      run(
        sql`UPDATE app_agreements.signature_events SET code_verified_at = now() WHERE id = ${s.eventId}`,
      ),
    ).rejects.toThrow(/immutable_row/)
    for (const as of [asPrivileged, asAppRole]) {
      expect(
        await as(
          dsql`UPDATE app_agreements.signature_events SET code_verified_at = now(), typed_phrase = 'I agree' WHERE id = ${s.eventId}`,
        ),
      ).toMatch(/immutable_row/)
    }
    const [row] =
      await sql`SELECT code_verified_at, typed_phrase FROM app_agreements.signature_events WHERE id = ${s.eventId}`
    expect(row).toEqual({ code_verified_at: null, typed_phrase: null })
  })

  it("a write-once column left empty at the seal is filled once, the mutable state moves freely", async () => {
    const s = await seed()
    const tsr = randomUUID()
    await sql`UPDATE app_agreements.evidence_packages SET tsr_file_id = ${tsr}, timestamp_status = 'stamped' WHERE id = ${s.packageId}`
    await expect(
      run(
        sql`UPDATE app_agreements.evidence_packages SET tsr_file_id = ${randomUUID()} WHERE id = ${s.packageId}`,
      ),
    ).rejects.toThrow(/immutable_row/)
    await sql`UPDATE app_agreements.evidence_packages SET last_verify_ok = false, last_verified_at = now() WHERE id = ${s.packageId}`
    const rows =
      await sql`SELECT tsr_file_id::text AS t, last_verify_ok FROM app_agreements.evidence_packages WHERE id = ${s.packageId}`
    expect(rows[0]).toEqual({ t: tsr, last_verify_ok: false })
  })

  it("one package per version", async () => {
    const s = await seed()
    const second = await withPrivilegedDb(ORG, "test:agreements-immutability-seed", (tx) =>
      upsertAppRow(
        tx,
        "agreements",
        "evidence_packages",
        packageRow(randomUUID(), s.versionId, new Date().toISOString()),
      ),
    ).then(
      () => "no error",
      (e: Error & { cause?: unknown }) => `${e.message} ${String(e.cause)}`,
    )
    expect(second).toMatch(/unique|duplicate/)
  })
})
