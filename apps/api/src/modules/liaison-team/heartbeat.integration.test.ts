// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Active-user count and the jittered heartbeat against a real database
// (`heartbeat.ts`, `payloads.ts`). The clock is injected: no wall-clock wait.
//
// Discriminators (what each test would catch), noted per test.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  heartbeatMinuteOfDay,
  heartbeatOnBoot,
  heartbeatTick,
  LAST_HEARTBEAT_SETTING,
} from "./heartbeat"
import { type LiaisonTeamIdentity, readIdentity, writeIdentity } from "./identity"
import { countActiveUsers } from "./payloads"
import { setSharing } from "./settings"

const MIN = 60_000
const DAY = 24 * 60 * MIN

const savedEndpoint = env.LIAISON_TEAM_ENDPOINT
const savedVersion = env.LIAISON_VERSION
const orgIds: string[] = []

async function makeOrg(opts: { demo?: boolean; deleting?: boolean } = {}): Promise<string> {
  const slug = `hb-${crypto.randomUUID().slice(0, 8)}`
  const settings = opts.demo ? { demo: { variant: "visitor" } } : {}
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO kernel.organizations (name, slug, settings, deleting_at)
    VALUES (${slug}, ${slug}, ${JSON.stringify(settings)}::jsonb,
            ${opts.deleting ? new Date().toISOString() : null})
    RETURNING id`
  orgIds.push(o?.id as string)
  return o?.id as string
}
async function makeUser(
  orgId: string,
  email: string,
  status: "active" | "suspended" | "deactivated" = "active",
): Promise<void> {
  await sql`INSERT INTO kernel.users (org_id, email, name, status)
            VALUES (${orgId}::uuid, ${email}, 'T', ${status}::kernel.user_status)`
}
const count = () => withSystemDb("test", (tx) => countActiveUsers(tx))
const heartbeats = () =>
  sql<{ status: string; data: { version: string; activeUsers: number } }[]>`
    SELECT status, data FROM kernel.control_plane_outbox WHERE type = 'heartbeat' ORDER BY created_at`
const identity = () => withSystemDb("test", (tx) => readIdentity(tx))

/** Registered identity without a network round trip. */
async function registeredIdentity(): Promise<LiaisonTeamIdentity> {
  await setSharing({ register: true }, { userId: null })
  const id = await identity()
  if (!id) throw new Error("no identity")
  const registered = { ...id, state: "registered" as const, registeredAt: new Date().toISOString() }
  await withSystemDb("test", (tx) => writeIdentity(tx, registered))
  return registered
}
const midnight = () => new Date(Math.floor(Date.now() / DAY) * DAY)

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = savedEndpoint
  ;(env as { LIAISON_VERSION: string }).LIAISON_VERSION = savedVersion
  await releaseTestLock()
})
beforeEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = "http://127.0.0.1:9"
})
afterEach(async () => {
  if (orgIds.length) {
    await sql`DELETE FROM kernel.users WHERE org_id = ANY(${orgIds}::uuid[])`
    await sql`DELETE FROM kernel.organizations WHERE id = ANY(${orgIds}::uuid[])`
    orgIds.length = 0
  }
})

describe("countActiveUsers", () => {
  // Discriminator: each exclusion has its own assertion, so dropping any one predicate fails here.
  it("counts active people across two orgs, excludes a demo org, a deactivated user and an import placeholder", async () => {
    const base = await count()
    const a = await makeOrg()
    const b = await makeOrg()
    await makeUser(a, "a1@example.test")
    await makeUser(a, "a2@example.test")
    await makeUser(b, "b1@example.test")
    expect(await count()).toBe(base + 3)

    const demo = await makeOrg({ demo: true })
    await makeUser(demo, "visitor@example.test")
    expect(await count()).toBe(base + 3)

    await makeUser(a, "gone@example.test", "deactivated")
    await makeUser(a, "paused@example.test", "suspended")
    expect(await count()).toBe(base + 3)

    await makeUser(a, "someone@import.invalid")
    expect(await count()).toBe(base + 3)

    const dying = await makeOrg({ deleting: true })
    await makeUser(dying, "d1@example.test")
    expect(await count()).toBe(base + 3)
  })
})

describe("heartbeat minute", () => {
  // Discriminator: a constant minute, or a random one, fails.
  it("two instance ids map to different minutes, the same id always to the same minute", () => {
    const ids = Array.from({ length: 50 }, () => crypto.randomUUID())
    const minutes = ids.map(heartbeatMinuteOfDay)
    expect(ids.map(heartbeatMinuteOfDay)).toEqual(minutes)
    expect(new Set(minutes).size).toBeGreaterThan(25)
    for (const m of minutes) {
      expect(m).toBeGreaterThanOrEqual(0)
      expect(m).toBeLessThan(1440)
      // Discriminator: a minute off the 10-minute tick grid (e.g. 1435) is
      // never reached by the */10 job before the day rolls over.
      expect(m % 10).toBe(0)
    }
  })
})

describe("heartbeat enqueue", () => {
  // Discriminator: enqueuing for an instance that never registered fails.
  it("an unregistered instance enqueues nothing", async () => {
    await heartbeatOnBoot(new Date())
    await heartbeatTick(new Date())
    expect(await heartbeats()).toHaveLength(0)
    // pending (registration asked, not yet answered) is not registered either
    await setSharing({ register: true }, { userId: null })
    await heartbeatOnBoot(new Date())
    await heartbeatTick(new Date(midnight().getTime() + DAY - MIN))
    expect(await heartbeats()).toHaveLength(0)
  })

  // Discriminator: a registered identity whose switch was turned off (retiring) must not send.
  it("a retiring instance enqueues nothing", async () => {
    await registeredIdentity()
    await setSharing({ register: false }, { userId: null })
    expect((await identity())?.state).toBe("retiring")
    await heartbeatOnBoot(new Date())
    expect(await heartbeats()).toHaveLength(0)
  })

  // Discriminator: re-enqueuing on every boot, or never on a new version, fails.
  it("boot with a new LIAISON_VERSION enqueues one heartbeat, same version enqueues none", async () => {
    await registeredIdentity()
    ;(env as { LIAISON_VERSION: string }).LIAISON_VERSION = "9.9.1"
    const t = new Date()
    await heartbeatOnBoot(t)
    await heartbeatOnBoot(t)
    let hb = await heartbeats()
    expect(hb).toHaveLength(1)
    expect(hb[0]?.data.version).toBe("9.9.1")
    ;(env as { LIAISON_VERSION: string }).LIAISON_VERSION = "9.9.2"
    await heartbeatOnBoot(t)
    hb = await heartbeats()
    expect(hb.map((h) => h.data.version)).toEqual(["9.9.1", "9.9.2"])
  })

  // Discriminator: sending before the instance's minute, or twice in one day, fails.
  it("the daily tick enqueues once per day, at the instance minute and not before", async () => {
    const id = await registeredIdentity()
    ;(env as { LIAISON_VERSION: string }).LIAISON_VERSION = "9.9.3"
    const day = midnight()
    const yesterday = new Date(day.getTime() - DAY).toISOString().slice(0, 10)
    await sql`INSERT INTO kernel.instance_settings (key, value)
              VALUES (${LAST_HEARTBEAT_SETTING}, ${JSON.stringify({ version: "9.9.3", day: yesterday })}::jsonb)`
    const target = (d: Date) => new Date(d.getTime() + heartbeatMinuteOfDay(id.instanceId) * MIN)
    if (heartbeatMinuteOfDay(id.instanceId) > 0) {
      await heartbeatTick(new Date(target(day).getTime() - 1))
      expect(await heartbeats()).toHaveLength(0)
    }
    await heartbeatTick(target(day))
    await heartbeatTick(new Date(target(day).getTime() + 10 * MIN))
    expect(await heartbeats()).toHaveLength(1)
    await heartbeatTick(target(new Date(day.getTime() + DAY)))
    expect(await heartbeats()).toHaveLength(2)
  })
})
