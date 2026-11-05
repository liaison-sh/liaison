// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org setup stamp: a hash of everything an org's persistent app setup
// depends on (build, app versions), stored on the org row
// once every app registered. A matching stamp lets a later registration skip
// the writes; the stamp is read and written under the org's `org-setup`
// advisory xact lock so a process can re-read it after waiting on the lock
// (double-checked) and skip what another process already did. The lock is per
// org: one org's setup never waits on another's.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import {
  computeSetupStamp,
  orgSetupLockSql,
  orgSetupStamp,
  readOrgSetupState,
  setupBuildId,
  stampMatches,
  withOrgSetupLock,
  writeOrgSetupStamp,
} from "~/modules/apps/setup-stamp"
import { pgLockWaiters } from "~/tests/helpers/pg-lock-waiters"
import { waitFor } from "~/tests/helpers/wait-for"

const ORG = randomUUID()
const APPS = [
  { name: "tickets", version: "1.2.0" },
  { name: "mail", version: "0.4.1" },
] as const

async function storedStamp(): Promise<string | null> {
  const [row] = await sql<{ stamp: string | null }[]>`
    SELECT app_setup_stamp AS stamp FROM kernel.organizations WHERE id = ${ORG}`
  return row?.stamp ?? null
}

describe("computeSetupStamp", () => {
  const base = { buildId: "b1", apps: APPS }

  it("is order-independent and changes with one app version or the build id", () => {
    const stamp = computeSetupStamp(base)
    expect(stamp).toMatch(/^[0-9a-f]{64}$/)
    expect(computeSetupStamp({ ...base, apps: [...APPS].reverse() })).toBe(stamp)
    expect(
      computeSetupStamp({ ...base, apps: [APPS[0], { name: "mail", version: "0.4.2" }] }),
    ).not.toBe(stamp)
    expect(computeSetupStamp({ ...base, buildId: "b2" })).not.toBe(stamp)
    // An app set that differs only by where a field boundary falls is still distinct.
    expect(computeSetupStamp({ ...base, apps: [{ name: "a@1", version: "2" }] })).not.toBe(
      computeSetupStamp({ ...base, apps: [{ name: "a", version: "1@2" }] }),
    )
  })
})

describe("setupBuildId", () => {
  it("is LIAISON_VERSION when it names a build", () => {
    expect(setupBuildId({ LIAISON_VERSION: "abc123", NODE_ENV: "production" })).toBe("abc123")
    expect(setupBuildId({ LIAISON_VERSION: "1.4.0", NODE_ENV: "test" })).toBe("1.4.0")
  })

  it("is a constant under NODE_ENV=test when the version is dev", () => {
    const a = setupBuildId({ LIAISON_VERSION: "dev", NODE_ENV: "test" })
    expect(a).toBe(setupBuildId({ LIAISON_VERSION: "dev", NODE_ENV: "test" }))
    expect(a).toBe("dev")
  })

  it("is a per-process nonce when the version is dev outside tests", () => {
    for (const NODE_ENV of ["production", "development"] as const) {
      const id = setupBuildId({ LIAISON_VERSION: "dev", NODE_ENV })
      expect(id).not.toBe("dev")
      expect(id.startsWith("dev+")).toBe(true)
      // Stable within one process, so registrations in this process match each other.
      expect(setupBuildId({ LIAISON_VERSION: "dev", NODE_ENV })).toBe(id)
    }
  })
})

describe("org setup state (database)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Setup Stamp Org', ${`setup-stamp-${ORG.slice(0, 8)}`})`
  })
  beforeEach(async () => {
    orgSetupStamp.enabled = true
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`UPDATE kernel.organizations SET app_setup_stamp = NULL WHERE id = ${ORG}`
    for (const app of APPS) {
      await sql`INSERT INTO kernel.apps (org_id, name, version, status)
        VALUES (${ORG}, ${app.name}, ${app.version}, 'active')`
    }
  })
  afterAll(async () => {
    orgSetupStamp.enabled = true
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  const expected = () => computeSetupStamp({ buildId: "b", apps: APPS })

  it("a never-stamped org reads null and does not match", async () => {
    const state = await readOrgSetupState(ORG, APPS)
    expect(state).toEqual({ stored: null, erroredApps: [], rowsCurrent: true })
    expect(stampMatches(expected(), state)).toBe(false)
  })

  it("matches only with the stored stamp, no errored app and every row at its version", async () => {
    await writeOrgSetupStamp(ORG, expected())
    expect(stampMatches(expected(), await readOrgSetupState(ORG, APPS))).toBe(true)

    // One app in error: no match (today's recovery re-runs its registration).
    await sql`UPDATE kernel.apps SET status = 'error' WHERE org_id = ${ORG} AND name = 'mail'`
    const errored = await readOrgSetupState(ORG, APPS)
    expect(errored.erroredApps).toEqual(["mail"])
    expect(stampMatches(expected(), errored)).toBe(false)
    await sql`UPDATE kernel.apps SET status = 'active' WHERE org_id = ${ORG} AND name = 'mail'`

    // A row at an older version: no match.
    await sql`UPDATE kernel.apps SET version = '1.1.0' WHERE org_id = ${ORG} AND name = 'tickets'`
    const stale = await readOrgSetupState(ORG, APPS)
    expect(stale.rowsCurrent).toBe(false)
    expect(stampMatches(expected(), stale)).toBe(false)
    await sql`UPDATE kernel.apps SET version = '1.2.0' WHERE org_id = ${ORG} AND name = 'tickets'`

    // A missing row (deleted out of band): no match.
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG} AND name = 'tickets'`
    expect(stampMatches(expected(), await readOrgSetupState(ORG, APPS))).toBe(false)
  })

  it("does not match a different expected stamp, nor when the seam is off", async () => {
    await writeOrgSetupStamp(ORG, expected())
    const state = await readOrgSetupState(ORG, APPS)
    expect(stampMatches(computeSetupStamp({ buildId: "other", apps: APPS }), state)).toBe(false)
    orgSetupStamp.enabled = false
    expect(stampMatches(expected(), state)).toBe(false)
  })

  it("write is idempotent and writes nothing when the stamp is already there", async () => {
    await Promise.all([writeOrgSetupStamp(ORG, expected()), writeOrgSetupStamp(ORG, expected())])
    expect(await storedStamp()).toBe(expected())
    const [before] = await sql<{ xmin: string }[]>`
      SELECT xmin::text AS xmin FROM kernel.organizations WHERE id = ${ORG}`
    await writeOrgSetupStamp(ORG, expected())
    const [after] = await sql<{ xmin: string }[]>`
      SELECT xmin::text AS xmin FROM kernel.organizations WHERE id = ${ORG}`
    expect(after?.xmin).toBe(before?.xmin)
  })

  it("write waits on the org-setup lock", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => {
      locked = r
    })
    const holder = withSystemDb("test-hold-org-setup", async (tx) => {
      await tx.execute(orgSetupLockSql(ORG))
      locked()
      await held
    })
    await lockTaken
    const waitersBefore = await pgLockWaiters()
    let done = false
    const write = writeOrgSetupStamp(ORG, expected()).then(() => {
      done = true
    })
    await waitFor(async () => (await pgLockWaiters()) > waitersBefore, {
      label: "write queued on lock",
    })
    expect(done).toBe(false)
    expect(await storedStamp()).toBeNull()
    release()
    await holder
    await write
    expect(await storedStamp()).toBe(expected())
  })

  it("supports a double-checked re-read under the lock: the second setter sees the first's stamp", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => {
      locked = r
    })
    // Process A takes the lock, (would set up,) then writes the stamp in the same transaction.
    const a = withOrgSetupLock("test-a", ORG, async (tx) => {
      locked()
      await held
      await writeOrgSetupStamp(ORG, expected(), tx)
    })
    await lockTaken
    // Process B read no stamp before the lock; it waits, then re-reads under it.
    expect(stampMatches(expected(), await readOrgSetupState(ORG, APPS))).toBe(false)
    const waitersBefore = await pgLockWaiters()
    const b = withOrgSetupLock("test-b", ORG, async (tx) =>
      stampMatches(expected(), await readOrgSetupState(ORG, APPS, tx)),
    )
    await waitFor(async () => (await pgLockWaiters()) > waitersBefore, {
      label: "B queued on lock",
    })
    release()
    await a
    expect(await b).toBe(true)
  })
  it("one org's setup lock never holds another org's setup (a burst of first touches after an upgrade runs side by side)", async () => {
    const OTHER = randomUUID()
    await sql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${OTHER}, 'Setup other', ${`setup-other-${OTHER.slice(0, 8)}`})`
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => {
      locked = r
    })
    const holder = withOrgSetupLock("test-hold-org-a", ORG, async () => {
      locked()
      await held
    })
    await lockTaken
    try {
      // Org B's stamp write and double-checked re-read finish while A holds its lock.
      const deadline = new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3_000))
      const other = (async () => {
        await writeOrgSetupStamp(OTHER, expected())
        return withOrgSetupLock("test-other", OTHER, async (tx) =>
          stampMatches(expected(), await readOrgSetupState(OTHER, APPS, tx)),
        )
      })()
      expect(await Promise.race([other, deadline])).not.toBe("blocked")
    } finally {
      release()
      await holder
      await sql`DELETE FROM kernel.organizations WHERE id = ${OTHER}`
    }
  })
})
