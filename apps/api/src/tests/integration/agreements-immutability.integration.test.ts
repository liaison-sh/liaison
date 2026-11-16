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
  await sql`INSERT INTO app_agreements.agreements (id, org_id, number, kind, status, title, language, org_access)
    VALUES (${agreementId}, ${ORG}, ${`AG-2026-${agreementId.slice(0, 6)}`}, 'nda', 'signed', 'Maison Morel NDA', 'en', 'editor')`
  await sql`INSERT INTO app_agreements.agreement_versions (id, org_id, agreement_id, number, sha256, frozen_at, status)
    VALUES (${versionId}, ${ORG}, ${agreementId}, 1, ${"e".repeat(64)}, now(), 'signed')`
  await sql`INSERT INTO app_agreements.signature_events (id, org_id, version_id, client_action_id, invited_email, invited_by,
      typed_name, capacity, consent_words, consent_lang, level, document_sha256, signed_at, ip, user_agent)
    VALUES (${eventId}, ${ORG}, ${versionId}, ${randomUUID()}, 'paul@maison-morel.example', 'lea@studio.example',
      'Paul Morel', 'Gérant', 'words', 'en', 'ses', ${"e".repeat(64)}, now(), '198.51.100.7', 'UA')`
  await sql`INSERT INTO app_agreements.evidence_packages (id, org_id, version_id, level, hash_alg, seal_version,
      document_sha256, signed_pdf_sha256, trail_sha256, seal, sealed_at, timestamp_status)
    VALUES (${packageId}, ${ORG}, ${versionId}, 'ses', 'sha256', 1, ${"e".repeat(64)}, ${"f".repeat(64)},
      ${"a".repeat(64)}, ${"b".repeat(64)}, now(), 'pending')`
  return { versionId, eventId, packageId }
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
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Evidence Immutability Org', 'evidence-immutability-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'immutability@test.com', 'hash', 'Immutability Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
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
    await expect(
      run(sql`INSERT INTO app_agreements.evidence_packages (id, org_id, version_id, level, hash_alg, seal_version,
          document_sha256, sealed_at, timestamp_status)
        VALUES (${randomUUID()}, ${ORG}, ${s.versionId}, 'ses', 'sha256', 1, ${"e".repeat(64)}, now(), 'pending')`),
    ).rejects.toThrow(/unique|duplicate/)
  })
})
