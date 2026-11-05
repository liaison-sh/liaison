// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RLS boundary for the mailbox key tables.
//
// Seed privileged, ASSERT through the real `liaison_rls` role. A privileged
// connection bypasses every policy, so an assertion made through it would ship
// green on a table with no policy at all.
//
// The shape being pinned:
//   * `kernel.user_key_wraps` is owner only, for every operation. The wrapped
//     Account Key is an offline cracking oracle, so a second user seeing even
//     one row is a real loss.
//   * `kernel.user_mailbox_identities` is a split pair: owner writes, org
//     members read. Sealing mail for a colleague needs their ECDH public key
//     and verifying their keyring needs their signing public key, and a public
//     key is public by definition. Postgres has no column-level RLS, so the
//     org-read exposure is the whole row; every column on that table is public
//     key material or status.
//   * `kernel.mailbox_migration_state` and `kernel.mailbox_client_jobs` are
//     owner only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { withRlsBoundaryAs } from "~/tests/helpers/rls-boundary"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const ECDH = Buffer.from("ecdh-public-key-bytes")
const SIGN = Buffer.from("sign-public-key-bytes")
const ATTESTATION = Buffer.from("keyring-attestation-bytes")
const WRAPPED = Buffer.from("wrapped-account-key-bytes")

interface Fixture {
  owner: minimal.Person
  other: minimal.Person
  identityId: string
  wrapId: string
}

async function seed(): Promise<Fixture> {
  const owner = await minimal.person((await createTestOrg()).id)
  const other = await minimal.person(owner.orgId)
  const { identityId, wrapId } = await withSystemDb("mailbox-keys-rls-seed", async (db) => {
    const identity = await db.execute(drizzleSql`
      INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${owner.orgId}::uuid, ${owner.id}::uuid, 1, ${ECDH}, ${SIGN}, ${ATTESTATION}, 'active')
      RETURNING id`)
    const wrap = await db.execute(drizzleSql`
      INSERT INTO kernel.user_key_wraps
        (org_id, user_id, wrap_type, label, wrapped_account_key)
      VALUES (${owner.orgId}::uuid, ${owner.id}::uuid, 'recovery_phrase', 'phrase', ${WRAPPED})
      RETURNING id`)
    await db.execute(drizzleSql`
      INSERT INTO kernel.mailbox_migration_state (user_id, org_id)
      VALUES (${owner.id}::uuid, ${owner.orgId}::uuid)`)
    await db.execute(drizzleSql`
      INSERT INTO kernel.mailbox_client_jobs (org_id, user_id, kind, payload, status)
      VALUES (${owner.orgId}::uuid, ${owner.id}::uuid, 'index_backfill', '{}'::jsonb, 'pending')`)
    return {
      identityId: (identity[0] as { id: string }).id,
      wrapId: (wrap[0] as { id: string }).id,
    }
  })
  return { owner, other, identityId, wrapId }
}

describe("kernel mailbox key tables -- RLS", () => {
  test("user_key_wraps is owner only", async () => {
    const fx = await seed()
    const mine = await withRlsBoundaryAs(fx.owner.id, fx.owner.orgId, (tx) =>
      tx.execute(drizzleSql`SELECT id FROM kernel.user_key_wraps WHERE id = ${fx.wrapId}::uuid`),
    )
    // Non-vacuity: the row exists and the owner can see it, so the zero below
    // is RLS at work and not an empty table.
    expect(mine).toHaveLength(1)

    const theirs = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(drizzleSql`SELECT id FROM kernel.user_key_wraps WHERE id = ${fx.wrapId}::uuid`),
    )
    expect(theirs).toHaveLength(0)
  })

  test("another org member cannot update or delete a wrap they do not own", async () => {
    const fx = await seed()
    const updated = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.user_key_wraps SET label = 'stolen' WHERE id = ${fx.wrapId}::uuid RETURNING id`,
      ),
    )
    expect(updated).toHaveLength(0)
    const deleted = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(
        drizzleSql`DELETE FROM kernel.user_key_wraps WHERE id = ${fx.wrapId}::uuid RETURNING id`,
      ),
    )
    expect(deleted).toHaveLength(0)
    const stillThere = await withSystemDb("mailbox-keys-rls-verify", (db) =>
      db.execute(drizzleSql`SELECT label FROM kernel.user_key_wraps WHERE id = ${fx.wrapId}::uuid`),
    )
    expect((stillThere[0] as { label: string }).label).toBe("phrase")
  })

  test("an org member can read another user's identity public keys", async () => {
    const fx = await seed()
    const rows = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(drizzleSql`
        SELECT ecdh_public_key, sign_public_key, status
        FROM kernel.user_mailbox_identities WHERE id = ${fx.identityId}::uuid`),
    )
    expect(rows).toHaveLength(1)
    const row = rows[0] as { ecdh_public_key: Uint8Array; status: string }
    expect(Buffer.from(row.ecdh_public_key).toString()).toBe(ECDH.toString())
    expect(row.status).toBe("active")
  })

  test("an org member cannot update or delete another user's identity", async () => {
    const fx = await seed()
    const updated = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(drizzleSql`
        UPDATE kernel.user_mailbox_identities SET status = 'retired'
        WHERE id = ${fx.identityId}::uuid RETURNING id`),
    )
    expect(updated).toHaveLength(0)
    const deleted = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(drizzleSql`
        DELETE FROM kernel.user_mailbox_identities WHERE id = ${fx.identityId}::uuid RETURNING id`),
    )
    expect(deleted).toHaveLength(0)
    const stillActive = await withSystemDb("mailbox-keys-rls-verify-identity", (db) =>
      db.execute(drizzleSql`
        SELECT status FROM kernel.user_mailbox_identities WHERE id = ${fx.identityId}::uuid`),
    )
    expect((stillActive[0] as { status: string }).status).toBe("active")
  })

  test("an org member cannot insert an identity for someone else", async () => {
    const fx = await seed()
    let failed = false
    try {
      await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO kernel.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${fx.owner.orgId}::uuid, ${fx.owner.id}::uuid, 9, ${ECDH}, ${SIGN}, ${ATTESTATION}, 'active')`),
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })

  test("migration state and client jobs are owner only", async () => {
    const fx = await seed()
    const mineState = await withRlsBoundaryAs(fx.owner.id, fx.owner.orgId, (tx) =>
      tx.execute(
        drizzleSql`SELECT user_id FROM kernel.mailbox_migration_state WHERE user_id = ${fx.owner.id}::uuid`,
      ),
    )
    expect(mineState).toHaveLength(1)
    const theirState = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(
        drizzleSql`SELECT user_id FROM kernel.mailbox_migration_state WHERE user_id = ${fx.owner.id}::uuid`,
      ),
    )
    expect(theirState).toHaveLength(0)

    const mineJobs = await withRlsBoundaryAs(fx.owner.id, fx.owner.orgId, (tx) =>
      tx.execute(
        drizzleSql`SELECT id FROM kernel.mailbox_client_jobs WHERE user_id = ${fx.owner.id}::uuid`,
      ),
    )
    expect(mineJobs).toHaveLength(1)
    const theirJobs = await withRlsBoundaryAs(fx.other.id, fx.other.orgId, (tx) =>
      tx.execute(
        drizzleSql`SELECT id FROM kernel.mailbox_client_jobs WHERE user_id = ${fx.owner.id}::uuid`,
      ),
    )
    expect(theirJobs).toHaveLength(0)
  })

  test("an empty session GUC returns zero rows instead of throwing", async () => {
    // The known Liaison trap: `''::uuid` raises 22P02 and aborts the whole
    // query before the policy can evaluate to deny, so every policy on these
    // tables must go through NULLIF.
    const fx = await seed()
    const rows = await withSystemDb("mailbox-keys-rls-empty-guc", async (db) => {
      await db.execute(drizzleSql`SET LOCAL ROLE liaison_rls`)
      await db.execute(drizzleSql`SELECT set_config('app.current_user_id', '', true)`)
      await db.execute(drizzleSql`SELECT set_config('app.current_org_id', '', true)`)
      return db.execute(drizzleSql`SELECT id FROM kernel.user_key_wraps`)
    })
    expect(rows).toHaveLength(0)
    expect(fx.wrapId).toBeTruthy()
  })
})
