// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox-keys REST surface, against real rows and the real RLS boundary.
//
// The properties under test are all about what the server refuses:
//   * Enrollment is idempotent PER USER. Identities and wraps are keyed by
//     user, not by account, so connecting a second personal mailbox must not
//     mint a second Account Key and orphan everything sealed under the first.
//   * The wrap LISTING never carries a blob. `wrapped_account_key` is an
//     offline cracking oracle, so returning every one of them from a listing
//     would hand an attacker every oracle in a single call. The blob has its
//     own owner-only, rate-limited route.
//   * The last wrap, and the last mailbox password (`passphrase`) wrap, cannot
//     be deleted: the password is the unlock method that works on every
//     machine.
//   * Enrolling without a mailbox password wrap is refused for the same reason,
//     and no new recovery-phrase wrap is accepted at all: the phrase is retired.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { stepUpCodeKey } from "~/modules/auth/step-up"
import { TestKeyring } from "~/modules/mailbox-keys/__fixtures__/keyring"
import { mailboxKeysRoutes, mailboxRoutes } from "~/modules/mailbox-keys/routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

function appFor(user: minimal.Person, scopes: string[] = ["mail:*"]): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    c.set("scopes", scopes as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox-keys", mailboxKeysRoutes)
  app.route("/api/mailbox", mailboxRoutes)
  app.onError(errorHandler)
  keyrings.set(app, new TestKeyring(user.id))
  return app
}

const keyrings = new WeakMap<Hono<AppEnv>, TestKeyring>()

function keyringOf(app: Hono<AppEnv>): TestKeyring {
  const k = keyrings.get(app)
  if (!k) throw new Error("app built without appFor")
  return k
}

/** A valid emailed step-up code for a mailbox key rotation. */
async function rotateStepUp(userId: string): Promise<{ stepUpCode: string }> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(userId, "mailbox_rotate"), hashToken(code), "EX", 600)
  return { stepUpCode: code }
}

function recoveryWrap(label = "recovery phrase") {
  return {
    wrapType: "recovery_phrase" as const,
    label,
    wrappedAccountKey: Buffer.from("wrapped-under-the-phrase").toString("base64"),
    kdfParams: { salt: "c2FsdA==" },
    verifier: Buffer.from("verifier").toString("base64"),
  }
}

function passkeyWrap(label = "Passkey") {
  return {
    wrapType: "passkey_prf" as const,
    label,
    credentialId: Buffer.from("credential").toString("base64"),
    wrappedAccountKey: Buffer.from("wrapped-under-the-prf").toString("base64"),
    kdfParams: { salt: "c2FsdA==", credentialId: Buffer.from("credential").toString("base64") },
  }
}

function passphraseWrap(label = "passphrase") {
  return {
    wrapType: "passphrase" as const,
    label,
    wrappedAccountKey: Buffer.from("wrapped-under-the-passphrase").toString("base64"),
    kdfParams: { salt: "c2FsdA==", m: 65536, t: 3, p: 4 },
  }
}

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function enroll(app: Hono<AppEnv>, keyId = 1): Promise<Response> {
  return post(app, "/api/mailbox-keys/enroll", {
    ...(await keyringOf(app).enrollPayload(keyId)),
    wraps: [passphraseWrap()],
  })
}

let mailAccountSeq = 0

/**
 * One personal mailbox already suspended by the deploy step, plus one org
 * mailbox that must not be touched. Seeded privileged: the caller's RLS session
 * carries no grant that could create an account row for them.
 */
async function seedMailAccounts(
  user: minimal.Person,
): Promise<{ personalId: string; orgId: string }> {
  const n = ++mailAccountSeq
  const stamp = `${Date.now()}-${n}`
  return withSystemDb("mailbox-keys-test-seed-accounts", async (db) => {
    const conn = (
      await db.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, provider_type, identifier, created_by)
      VALUES (${user.orgId}::uuid, 'mail', 'gmail', 'org', 'oauth2', ${`enc-state-${stamp}`}, ${user.id}::uuid)
      RETURNING id`)
    )[0] as { id: string }
    const personal = (
      await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status,
         encryption_state)
      VALUES (${user.orgId}::uuid, ${conn.id}::uuid, 'user', ${user.id}::uuid, 'gmail',
              ${`personal-${stamp}@test.com`}, 'active', 'pending_enrollment')
      RETURNING id`)
    )[0] as { id: string }
    const shared = (
      await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status,
         encryption_state)
      VALUES (${user.orgId}::uuid, ${conn.id}::uuid, 'shared', NULL, 'gmail',
              ${`shared-${stamp}@test.com`}, 'active', 'none')
      RETURNING id`)
    )[0] as { id: string }
    return { personalId: personal.id, orgId: shared.id }
  })
}

async function readEncryptionStates(ids: string[]): Promise<Record<string, string>> {
  const rows = await withSystemDb("mailbox-keys-test-read-states", (db) =>
    db.execute(drizzleSql`
      SELECT id::text AS id, encryption_state FROM app_mail.accounts
       WHERE id IN (${drizzleSql.join(
         ids.map((i) => drizzleSql`${i}::uuid`),
         drizzleSql.raw(", "),
       )})`),
  )
  const out: Record<string, string> = {}
  for (const row of rows as unknown as Array<{ id: string; encryption_state: string }>) {
    out[row.id] = row.encryption_state
  }
  return out
}

describe("mailbox-keys routes", () => {
  test("enroll persists the keyring and is idempotent per user", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)

    const first = await enroll(app)
    expect(first.status).toBe(201)
    const firstBody = await json<{ data: { keyId: number; identityId: string } }>(first)
    expect(firstBody.data.keyId).toBe(1)

    const second = await post(app, "/api/mailbox-keys/enroll", {
      ...(await keyringOf(app).strangerPayload(2)),
      wraps: [passphraseWrap("a second password")],
    })
    expect(second.status).toBe(200)
    const secondBody = await json<{ data: { keyId: number; identityId: string } }>(second)
    expect(secondBody.data.keyId).toBe(1)
    expect(secondBody.data.identityId).toBe(firstBody.data.identityId)

    const counts = await withSystemDb("mailbox-keys-test-counts", (db) =>
      db.execute(drizzleSql`
        SELECT
          (SELECT count(*) FROM kernel.user_mailbox_identities WHERE user_id = ${user.id}::uuid) AS identities,
          (SELECT count(*) FROM kernel.user_key_wraps WHERE user_id = ${user.id}::uuid) AS wraps`),
    )
    const row = counts[0] as { identities: string; wraps: string }
    expect(Number(row.identities)).toBe(1)
    expect(Number(row.wraps)).toBe(1)
  })

  test("enroll without a mailbox password wrap is refused and persists nothing", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    // A passkey alone works on one machine only: the password is required.
    const res = await post(app, "/api/mailbox-keys/enroll", {
      ...(await keyringOf(app).strangerPayload(1)),
      wraps: [passkeyWrap()],
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("mailbox password")
    const rows = await withSystemDb("mailbox-keys-test-empty", (db) =>
      db.execute(
        drizzleSql`SELECT id FROM kernel.user_mailbox_identities WHERE user_id = ${user.id}::uuid`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  test("enroll refuses an ECDH public key the server cannot seal to", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const payload = await keyringOf(app).strangerPayload(1)
    const res = await post(app, "/api/mailbox-keys/enroll", {
      ...payload,
      ecdhPublicKey: Buffer.from("not an spki point").toString("base64"),
      wraps: [passphraseWrap()],
    })
    expect(res.status).toBe(400)
    const rows = await withSystemDb("mailbox-keys-test-bad-key", (db) =>
      db.execute(
        drizzleSql`SELECT id FROM kernel.user_mailbox_identities WHERE user_id = ${user.id}::uuid`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  test("GET /me lists wrap metadata and never a wrapped Account Key", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)

    const res = await app.request("/api/mailbox-keys/me")
    expect(res.status).toBe(200)
    const body = await json(res)
    // Non-vacuity: there IS something to leak, so the absence below is real.
    expect(body.data.identities).toHaveLength(1)
    expect(body.data.wraps).toHaveLength(1)
    expect(body.data.wraps[0].type).toBe("passphrase")
    expect(body.data.wraps[0].label).toBe("passphrase")
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain("wrappedAccountKey")
    expect(serialized).not.toContain(Buffer.from("wrapped-under-the-passphrase").toString("base64"))
    expect(serialized).not.toContain("verifier")
  })

  test("the wrap blob is owner only and 404s for anyone else", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    const ownerApp = appFor(owner)
    expect((await enroll(ownerApp)).status).toBe(201)
    const listed = await json(await ownerApp.request("/api/mailbox-keys/me"))
    const wrapId = listed.data.wraps[0].id as string

    const mine = await ownerApp.request(`/api/mailbox-keys/wraps/${wrapId}/blob`)
    expect(mine.status).toBe(200)
    const mineBody = await json(mine)
    expect(mineBody.data.wrappedAccountKey).toBe(
      Buffer.from("wrapped-under-the-passphrase").toString("base64"),
    )
    expect(mineBody.data.kdfParams).toEqual({ salt: "c2FsdA==", m: 65536, t: 3, p: 4 })

    const other = await minimal.person(owner.orgId)
    const otherRes = await appFor(other).request(`/api/mailbox-keys/wraps/${wrapId}/blob`)
    // 404, not 403 with a body: an existence oracle over another user's key
    // material is itself information.
    expect(otherRes.status).toBe(404)
    expect(await otherRes.text()).not.toContain("wrapped-under-the-passphrase")
  })

  test("deleting the last wrap and the last mailbox password are both refused", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)
    const listed = await json(await app.request("/api/mailbox-keys/me"))
    const passwordId = listed.data.wraps[0].id as string

    const lastOne = await app.request(`/api/mailbox-keys/wraps/${passwordId}`, {
      method: "DELETE",
    })
    expect(lastOne.status).toBe(409)

    // A passkey for this machine, added after unlocking with the password.
    const added = await post(app, "/api/mailbox-keys/wraps", passkeyWrap())
    expect(added.status).toBe(201)

    // Two wraps now, so "the last wrap" no longer applies, but the password is
    // still the last of its kind and the only method that works everywhere.
    const lastPassword = await app.request(`/api/mailbox-keys/wraps/${passwordId}`, {
      method: "DELETE",
    })
    expect(lastPassword.status).toBe(409)

    const passkeyId = (await json(await app.request("/api/mailbox-keys/me"))).data.wraps.find(
      (w: { type: string }) => w.type === "passkey_prf",
    ).id as string
    const deletable = await app.request(`/api/mailbox-keys/wraps/${passkeyId}`, {
      method: "DELETE",
    })
    expect(deletable.status).toBe(200)
  })

  test("no new recovery phrase wrap is accepted, at enrolment or afterwards", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const enrolWithPhrase = await post(app, "/api/mailbox-keys/enroll", {
      ...(await keyringOf(app).strangerPayload(1)),
      wraps: [passphraseWrap(), recoveryWrap()],
    })
    expect(enrolWithPhrase.status).toBe(400)

    expect((await enroll(app)).status).toBe(201)
    const addPhrase = await post(app, "/api/mailbox-keys/wraps", recoveryWrap())
    expect(addPhrase.status).toBe(400)
    const listed = await json(await app.request("/api/mailbox-keys/me"))
    expect(listed.data.wraps.map((w: { type: string }) => w.type)).toEqual(["passphrase"])
  })

  test("rotate retires the previous identity and activates the new one", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)

    const res = await post(app, "/api/mailbox-keys/rotate", {
      ...(await keyringOf(app).rotatePayload(2)),
      ...(await rotateStepUp(user.id)),
    })
    expect(res.status).toBe(201)

    const rows = await withSystemDb("mailbox-keys-test-rotate", (db) =>
      db.execute(drizzleSql`
        SELECT key_id, status FROM kernel.user_mailbox_identities
        WHERE user_id = ${user.id}::uuid ORDER BY key_id`),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key_id: 1, status: "retired" })
    expect(rows[1]).toMatchObject({ key_id: 2, status: "active" })
  })

  test("rotate refuses a key id that is already in use", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)
    const res = await post(app, "/api/mailbox-keys/rotate", {
      ...(await keyringOf(app).strangerPayload(1)),
      ...(await rotateStepUp(user.id)),
    })
    expect(res.status).toBe(409)
  })

  test("enrolling moves the caller's own personal mailboxes to ready", async () => {
    // Without this the feature deadlocks: the deploy step moves every personal
    // account to `pending_enrollment`, which suspends its sync, and enrolling
    // mints the identity that ARMS the plaintext trigger. If nothing advances
    // `encryption_state`, the mailbox is armed AND permanently suspended, so no
    // mail ever arrives again no matter what the user does.
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const { personalId, orgId: sharedId } = await seedMailAccounts(user)

    const before = await readEncryptionStates([personalId, sharedId])
    expect(before[personalId], "non-vacuity: the fixture starts suspended").toBe(
      "pending_enrollment",
    )
    expect(before[sharedId]).toBe("none")

    expect((await enroll(app)).status).toBe(201)

    const after = await readEncryptionStates([personalId, sharedId])
    expect(after[personalId]).toBe("ready")
    expect(after[sharedId], "an org mailbox is not in the encryption regime").toBe("none")
  })

  test("enrolment FAILS rather than leaving the mailbox armed and permanently silent", async () => {
    // The worst outcome this feature has: the identity row is created, so the
    // database trigger ARMS and no plaintext can be written; the account stays
    // at `pending_enrollment`, so sync is suspended forever; and the API answers
    // 200, so nobody is told. A caller holding `mail:accounts:read` but not
    // `mail:accounts:write` produced exactly that, because the UPDATE runs in
    // the caller's own RLS transaction and RLS filters it SILENTLY.
    //
    // Enrolment is all or nothing: either the mailbox can fetch mail again, or
    // no keyring is persisted at all.
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user, ["mail:accounts:read"])
    const { personalId } = await seedMailAccounts(user)
    expect(
      (await readEncryptionStates([personalId]))[personalId],
      "non-vacuity: the fixture starts suspended",
    ).toBe("pending_enrollment")

    const res = await enroll(app)
    expect(
      res.status,
      "a 2xx here is a mailbox that will never receive mail again",
    ).toBeGreaterThan(399)

    // The mailbox is untouched, and so is the keyring: nothing half-enrolled.
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("pending_enrollment")
    const identities = await withSystemDb("mailbox-keys-test-read-identities", (db) =>
      db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.user_mailbox_identities
         WHERE user_id = ${user.id}::uuid`),
    )
    expect((identities as unknown as Array<{ n: number }>)[0]?.n).toBe(0)
    const wraps = await withSystemDb("mailbox-keys-test-read-wraps", (db) =>
      db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.user_key_wraps WHERE user_id = ${user.id}::uuid`),
    )
    expect((wraps as unknown as Array<{ n: number }>)[0]?.n).toBe(0)
  })

  test("enrolling leaves another user's suspended mailbox alone", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    // Same org, different owner: the sharper case, and the one RLS has to get
    // right, since an org-wide UPDATE would look correct in a one-org fixture.
    const stranger = await minimal.person(owner.orgId)
    const { personalId } = await seedMailAccounts(owner)

    expect((await enroll(appFor(stranger))).status).toBe(201)

    const after = await readEncryptionStates([personalId])
    expect(after[personalId]).toBe("pending_enrollment")
  })

  test("a second enrollment is idempotent and does not re-transition a ready mailbox", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const { personalId } = await seedMailAccounts(user)

    expect((await enroll(app)).status).toBe(201)
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("ready")

    // `ready -> ready` is NOT a legal pair in the state machine. A helper that
    // fed every row through `nextEncryptionState` unconditionally would throw
    // here and turn a harmless repeat enrollment into a 500.
    const second = await post(app, "/api/mailbox-keys/enroll", {
      ...(await keyringOf(app).strangerPayload(2)),
      wraps: [passphraseWrap("a second password")],
    })
    expect(second.status).toBe(200)
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("ready")
  })

  test("re-enrolling repairs a mailbox still suspended at pending_enrollment", async () => {
    // The idempotent short-circuit returned the existing keyring BEFORE
    // advancing the state, so a mailbox that arrived after the first enrolment,
    // or that the first enrolment missed, stayed suspended for good: re-enroling
    // is the obvious repair a user reaches for and it did nothing at all.
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)

    const { personalId } = await seedMailAccounts(user)
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("pending_enrollment")

    const second = await post(app, "/api/mailbox-keys/enroll", {
      ...(await keyringOf(app).strangerPayload(2)),
      wraps: [passphraseWrap("a repair password")],
    })
    expect(second.status).toBe(200)
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("ready")
  })

  test("rotating to a usable key lifts a blocked mailbox back to ready", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const { personalId } = await seedMailAccounts(user)
    expect((await enroll(app)).status).toBe(201)

    await withSystemDb("mailbox-keys-test-block", (db) =>
      db.execute(drizzleSql`
        UPDATE app_mail.accounts SET encryption_state = 'blocked' WHERE id = ${personalId}::uuid`),
    )
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("blocked")

    const res = await post(app, "/api/mailbox-keys/rotate", {
      ...(await keyringOf(app).rotatePayload(2)),
      ...(await rotateStepUp(user.id)),
    })
    expect(res.status).toBe(201)
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("ready")
  })

  test("GET /api/mailbox/migration-state returns the caller's ledger row", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)

    const before = await app.request("/api/mailbox/migration-state")
    expect(before.status).toBe(200)
    expect((await json(before)).data).toBeNull()

    expect((await enroll(app)).status).toBe(201)
    const after = await app.request("/api/mailbox/migration-state")
    expect(after.status).toBe(200)
    const body = await json(after)
    expect(body.data.userId).toBe(user.id)
    expect(body.data.enrolledAt).toBeTruthy()
    expect(body.data.plaintextPurgedAt).toBeNull()
  })

  test("POST /api/mailbox-keys/arm is refused before the owner has an identity", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const { personalId } = await seedMailAccounts(user)

    const res = await post(app, "/api/mailbox-keys/arm", {})
    expect(res.status).toBe(409)
    // Nothing moved: an armed mailbox nobody can seal to would suspend itself
    // again on the first message.
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("pending_enrollment")
  })

  test("POST /api/mailbox-keys/arm lifts a suspended mailbox for an owner who already has keys", async () => {
    // The wizard shows "nothing new to do here" to an owner with keys, and the
    // enroll route needs a keyring payload the client no longer holds. Before
    // this route the only way out of a suspended mailbox for such an owner was
    // to run the whole OAuth connect again, which restarted the mailbox from
    // scratch.
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)
    const { personalId, orgId } = await seedMailAccounts(user)
    expect((await readEncryptionStates([personalId]))[personalId]).toBe("pending_enrollment")

    const res = await post(app, "/api/mailbox-keys/arm", {})
    expect(res.status).toBe(200)
    expect((await json(res)).data.moved).toContain(personalId)
    const after = await readEncryptionStates([personalId, orgId])
    expect(after[personalId]).toBe("ready")
    // A shared mailbox is not in the regime and is never touched.
    expect(after[orgId]).toBe("none")

    // Idempotent: a ready mailbox has no edge for "enrolled" and is skipped.
    const again = await post(app, "/api/mailbox-keys/arm", {})
    expect(again.status).toBe(200)
    expect((await json(again)).data.moved).toEqual([])
  })
})

describe("mailbox keys: who may touch the keyring", () => {
  test("a restricted device session reaches no mailbox key route", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("userId", user.id)
      c.set("orgId", user.orgId)
      c.set("scopes", ["mail:*"] as never)
      c.set("dimensionGrants", {})
      c.set("sessionRestricted", true as never)
      await next()
    })
    app.route("/api/mailbox-keys", mailboxKeysRoutes)
    app.route("/api/mailbox", mailboxRoutes)
    app.onError(errorHandler)
    expect((await app.request("/api/mailbox-keys/me")).status).toBe(403)
    expect((await app.request("/api/mailbox/sync-cursor")).status).toBe(403)
  })

  test("a token without the mail scope reaches no mailbox key route", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user, ["tickets:tickets:read"])
    expect((await app.request("/api/mailbox-keys/me")).status).toBe(403)
  })

  test("enroll refuses an attestation that does not verify", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    const res = await post(app, "/api/mailbox-keys/enroll", {
      ...(await keyringOf(app).enrollPayload(1)),
      attestation: Buffer.from("not a signature").toString("base64"),
      wraps: [passphraseWrap()],
    })
    expect(res.status).toBe(400)
  })

  test("rotate needs the step-up proof", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)
    const res = await post(app, "/api/mailbox-keys/rotate", {
      ...(await keyringOf(app).rotatePayload(2)),
    })
    expect(res.status).toBe(400)
  })

  test("rotate refuses a new identity not attested by the current signing key", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)
    const res = await post(app, "/api/mailbox-keys/rotate", {
      ...(await keyringOf(app).rotatePayload(2, { signer: "new" })),
      ...(await rotateStepUp(user.id)),
    })
    expect(res.status).toBe(403)
    const rows = await withSystemDb("mailbox-keys-test-rotate-refused", (db) =>
      db.execute(drizzleSql`
        SELECT key_id, status FROM kernel.user_mailbox_identities
        WHERE user_id = ${user.id}::uuid ORDER BY key_id`),
    )
    expect(rows).toEqual([{ key_id: 1, status: "active" }] as never)
  })

  test("a new wrap keeps the KDF parameters the client recorded, as before", async () => {
    // The server does not judge the KDF or its cost: every shape a client
    // produces today (PBKDF2 from the browser and the native build, a legacy
    // row's params) is stored as sent.
    const user = await minimal.person((await createTestOrg()).id)
    const app = appFor(user)
    expect((await enroll(app)).status).toBe(201)
    for (const kdfParams of [
      { salt: "c2FsdA==", kdf: "pbkdf2-sha256", iterations: 600_000 },
      { salt: "c2FsdA==", kdf: "pbkdf2-sha256", iterations: 1000 },
      { salt: "c2FsdA==" },
    ]) {
      const res = await post(app, "/api/mailbox-keys/wraps", {
        ...passphraseWrap("another password"),
        kdfParams,
      })
      expect(res.status).toBe(201)
    }
  })
})
