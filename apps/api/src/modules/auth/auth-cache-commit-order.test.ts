// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The auth cache answers the permission-version check for a token. A writer
// bumps the version and drops the cache entry inside its transaction; a
// request arriving before that transaction commits still reads the committed
// (old) version. These tests pin that such a read cannot leave the old version
// cached once the change has committed, so a token minted before the change is
// refused at once instead of for the rest of the cache TTL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { invalidateAuthCache, isUserAuthCurrent } from "~/modules/auth/auth-state"
import { setUserScopes } from "~/modules/permissions/app-grants"
import { person, secondOrg } from "~/seed/tiers/minimal"

let ORG = ""
let USER = ""

async function storedPermissionVersion(): Promise<number> {
  const [row] = await sql`SELECT permission_version FROM kernel.users WHERE id = ${USER}`
  return Number(row?.permission_version)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeAll(async () => {
  ORG = (await secondOrg({ name: "Auth Cache Order" })).orgId
  USER = (await person(ORG)).id
})

beforeEach(async () => {
  await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${USER} AND org_id = ${ORG}`
  invalidateAuthCache(USER)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${USER} AND org_id = ${ORG}`
})

describe("auth cache: invalidation follows the commit of a permission change", () => {
  it("a read between the version bump and the commit does not keep an old token accepted", async () => {
    const before = await storedPermissionVersion()
    const oldToken = { userId: USER, orgId: ORG, permissionVersion: before }
    expect(await isUserAuthCurrent(oldToken)).toBe(true)

    const bumped = deferred()
    const commit = deferred()
    // A real writer: changes the user's grants, bumps permission_version and
    // drops the cache entry, all inside a transaction held open below.
    const writer = withPrivilegedDb(ORG, "test:auth-cache-order", async (tx) => {
      await setUserScopes(tx as unknown as RlsClient, {
        orgId: ORG,
        callingApp: "shopify",
        userId: USER,
        scopes: ["shopify:orders:read"],
      })
      bumped.resolve()
      await commit.promise
    })
    await bumped.promise

    // The interleaved request: outside the writer's transaction it sees the
    // committed (old) version, which is the right answer until the commit.
    expect(await isUserAuthCurrent(oldToken)).toBe(true)

    commit.resolve()
    await writer
    expect(await storedPermissionVersion()).toBe(before + 1)

    // Committed: the token minted before the change is refused.
    expect(await isUserAuthCurrent(oldToken)).toBe(false)
    expect(
      await isUserAuthCurrent({ userId: USER, orgId: ORG, permissionVersion: before + 1 }),
    ).toBe(true)
  })

  it("a read in flight while the entry is dropped is not cached", async () => {
    const before = await storedPermissionVersion()
    const oldToken = { userId: USER, orgId: ORG, permissionVersion: before }

    // Start a cold read, then drop the entry before its query has answered.
    const inFlight = isUserAuthCurrent(oldToken)
    invalidateAuthCache(USER)
    expect(await inFlight).toBe(true)

    // The version moves without a further drop (a peer's write whose
    // broadcast this process has not seen yet, say). The read that overlapped
    // the drop must not have cached what it saw.
    await sql`UPDATE kernel.users SET permission_version = permission_version + 1 WHERE id = ${USER}`
    expect(await isUserAuthCurrent(oldToken)).toBe(false)
  })
})
