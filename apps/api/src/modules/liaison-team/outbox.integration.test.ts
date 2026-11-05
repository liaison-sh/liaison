// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Liaison team registration and outbox against a real database and the
// fake control plane over TCP (tests/e2e/helpers/mock-control-plane.ts). Every
// drain is `drainOnce(now)` with an injected clock, never a wall-clock wait;
// the fake's `Date` header follows the same clock.
//
// Discriminators (what each test would catch), noted per test.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { deriveInstanceKey } from "@liaison/control-plane-contract/node"
import { sql } from "~/db"
import { getPoolGauges } from "~/db/pool-diag"
import { withSystemDb } from "~/db/privileged"
import { env, LIAISON_TEAM_DISABLED } from "~/lib/env"
import {
  type FakeControlPlaneHandle,
  startFakeControlPlane,
} from "~/tests/e2e/helpers/mock-control-plane"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { decryptInstanceKey, type LiaisonTeamIdentity, readIdentity } from "./identity"
import { claimDue, type DrainOptions, drainOnce, enqueue } from "./outbox"
import { heartbeatData } from "./payloads"
import { LiaisonTeamError, readSharing, readStatus, setSharing } from "./settings"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let fake: FakeControlPlaneHandle
let now: Date
const savedEndpoint = env.LIAISON_TEAM_ENDPOINT

interface Row {
  id: string
  type: string
  message_id: string
  status: string
  attempts: number
  next_attempt_at: Date | string
  last_status: number | null
  last_error: string | null
  data: Record<string, unknown>
  purged_at: Date | null
}

const at = (ms: number) => new Date(now.getTime() + ms)
const advance = (ms: number) => {
  now = at(ms)
}
// The injected clock stands still during a drain unless a test moves it.
const drain = (when: Date = now, opts: DrainOptions = {}) =>
  drainOnce(when, { random: () => 0.5, elapsedMs: () => 0, ...opts })

async function rows(): Promise<Row[]> {
  return sql<Row[]>`SELECT * FROM kernel.control_plane_outbox ORDER BY created_at, id`
}
async function row(id: string): Promise<Row> {
  const [r] = await sql<Row[]>`SELECT * FROM kernel.control_plane_outbox WHERE id = ${id}`
  if (!r) throw new Error(`row ${id} gone`)
  return r
}
const identity = (): Promise<LiaisonTeamIdentity | null> =>
  withSystemDb("test", (tx) => readIdentity(tx))
const turn = (change: { register?: boolean; forwardBugReports?: boolean }) =>
  setSharing(change, { userId: null }, now)

async function heartbeat(dependsOn?: string): Promise<{ id: string; messageId: string }> {
  return withSystemDb("test", (tx) =>
    enqueue(tx, "heartbeat", heartbeatData(3), { now, ...(dependsOn ? { dependsOn } : {}) }),
  )
}

/** Turn registration on and deliver it: the identity, registered. */
async function registered(): Promise<LiaisonTeamIdentity> {
  await turn({ register: true })
  await drain()
  const id = await identity()
  if (id?.state !== "registered") throw new Error(`registration did not complete: ${id?.state}`)
  return id
}

/** Wait until another session of this database waits on a lock (at most 10 s). */
async function someoneWaitsOnALock(): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if ((r?.n ?? 0) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const corruptKey = () =>
  sql`UPDATE kernel.instance_settings
         SET value = jsonb_set(value, '{keyCiphertext}', '"not-a-ciphertext"')
       WHERE key = 'liaison_team.identity'`

const heartbeatAcks = () => fake.control.acks().filter((a) => a.type === "heartbeat")
const requestsFor = (messageId: string) =>
  fake.control.requests().filter((r) => (r.body as { messageId?: string })?.messageId === messageId)

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = savedEndpoint
  await releaseTestLock()
})

beforeEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  fake = await startFakeControlPlane(0)
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = fake.control.endpoint
  now = new Date(Math.floor(Date.now() / 1000) * 1000)
  fake.control.setClock(() => now)
})

afterEach(async () => {
  await fake.kill()
})

describe("liaison team registration", () => {
  // Discriminator: storing the plaintext key, or never storing it, fails.
  it("turning register on registers and stores an encrypted key", async () => {
    await turn({ register: true })
    const pending = await identity()
    expect(pending?.state).toBe("pending")
    expect((await rows()).map((r) => [r.type, r.status])).toEqual([["register", "pending"]])

    await drain()
    const id = await identity()
    expect(id?.state).toBe("registered")
    expect(id?.instanceId).toBe(pending?.instanceId as string)
    const expectedKey = deriveInstanceKey(fake.control.masterSecret, id?.instanceId as string)
    expect(id?.keyCiphertext).toBeTruthy()
    expect(id?.keyCiphertext).not.toContain(expectedKey)
    expect(decryptInstanceKey(id as LiaisonTeamIdentity)).toBe(expectedKey)
    expect((await rows())[0]?.status).toBe("delivered")
  })

  // Discriminator: any added field (a domain, an email) fails the exact key set.
  it("payload key set is exactly version, edition, activeUsers, nonce", async () => {
    await turn({ register: true })
    await drain()
    const [req] = fake.control.requests()
    const body = req?.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["data", "instanceId", "messageId", "ts", "type", "v"])
    expect(Object.keys(body.data as object).sort()).toEqual([
      "activeUsers",
      "edition",
      "nonce",
      "version",
    ])
    expect(req?.headers["x-liaison-signature"]).toBeUndefined()
    expect(req?.headers["x-liaison-instance"]).toBe(body.instanceId as string)
  })

  // Discriminator: dropping a row after a failed send, or sending twice, fails.
  it("fake down 3 cycles then up: each messageId acked once", async () => {
    await registered()
    const sent = [await heartbeat(), await heartbeat(), await heartbeat()]
    await fake.control.setMode("down")
    for (let i = 0; i < 3; i++) {
      advance(2 * HOUR)
      await drain()
    }
    for (const s of sent) {
      const r = await row(s.id)
      expect(r.status).toBe("pending")
      expect(r.attempts).toBe(3)
    }
    await fake.control.setMode("up")
    advance(2 * HOUR)
    await drain()
    advance(2 * HOUR)
    await drain()
    const acked = heartbeatAcks().map((a) => a.messageId)
    expect(acked.sort()).toEqual(sent.map((s) => s.messageId).sort())
    for (const s of sent) {
      const r = await row(s.id)
      expect(r.status).toBe("delivered")
      expect(r.attempts).toBe(4)
    }
  })

  // Discriminator: a claim without a lease (or a lease that never expires) fails.
  it("a claimed row whose drain died is reclaimed after lease_until, never sent twice concurrently", async () => {
    await registered()
    const h = await heartbeat()
    expect((await claimDue(now)).map((r) => r.id)).toEqual([h.id]) // a drain that dies here
    await drain()
    expect(requestsFor(h.messageId)).toHaveLength(0)
    expect((await row(h.id)).status).toBe("sending")
    advance(3 * MIN)
    await drain()
    expect(requestsFor(h.messageId)).toHaveLength(1)
    expect((await row(h.id)).status).toBe("delivered")

    const many = await Promise.all([1, 2, 3, 4, 5].map(() => heartbeat()))
    await Promise.all([drain(), drain(), drain()])
    for (const m of many) expect(requestsFor(m.messageId)).toHaveLength(1)
  })

  // Discriminator: sending inside the claim (or finish) transaction holds a slot.
  it("no DB transaction is open while the fetch runs", async () => {
    await registered()
    await heartbeat()
    await heartbeat()
    const heldDuringFetch: number[] = []
    await drain(now, {
      fetch: (url, init) => {
        heldDuringFetch.push(getPoolGauges().privileged.held)
        return fetch(url, init)
      },
    })
    expect(heldDuringFetch).toEqual([0, 0])
    expect(heartbeatAcks()).toHaveLength(2)
  })

  // Discriminator: treating any 200 as delivered, or ignoring retryAfterSeconds, fails.
  it("200 dropped and 200 retry_later are retried, retry_later honours retryAfterSeconds", async () => {
    await registered()
    const h = await heartbeat()
    fake.control.queueReplies([{ status: 200, body: { ok: true, dropped: "APP_DISABLED" } }])
    await drain()
    let r = await row(h.id)
    expect(r.status).toBe("pending")
    expect(r.attempts).toBe(1)
    expect(r.last_error).toContain("APP_DISABLED")

    advance(HOUR)
    await fake.control.setMode("retry_later", { retryAfterSeconds: 7200 })
    await drain()
    r = await row(h.id)
    expect(r.status).toBe("pending")
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThanOrEqual(at(7200 * 1000).getTime())

    await fake.control.setMode("up")
    await drain(at(HOUR))
    expect(heartbeatAcks()).toHaveLength(0)
    await drain(at(7200 * 1000 + 1000))
    expect(heartbeatAcks().map((a) => a.messageId)).toEqual([h.messageId])
  })

  // Discriminator: ignoring the reply's Date (or not applying the offset to ts) fails.
  it("401 with skewed Date sets the offset and succeeds", async () => {
    await registered()
    const h = await heartbeat()
    fake.control.queueReplies([
      {
        status: 401,
        body: { error: { message: "Invalid signature" } },
        headers: { date: at(10 * MIN).toUTCString() },
      },
    ])
    await drain()
    expect((await identity())?.clockOffsetMs).toBe(10 * MIN)
    expect((await row(h.id)).status).toBe("pending")
    await drain()
    const last = requestsFor(h.messageId).at(-1)
    const sentTs = (last?.body as { ts?: string } | undefined)?.ts ?? ""
    expect(Date.parse(sentTs)).toBe(at(10 * MIN).getTime())
    expect((await row(h.id)).status).toBe("delivered")
  })

  // Discriminator: re-registering on the first 401 (or never) fails.
  it("401s keep the identity for 23 h, re-register after 24 h and 5 attempts", async () => {
    const first = await registered()
    const h = await heartbeat()
    await fake.control.setMode("401")
    const t0 = now.getTime()
    await drain()
    expect((await identity())?.authFailingSince).toBe(now.toISOString())
    while (now.getTime() - t0 < 23 * HOUR) {
      advance(2 * HOUR)
      if (now.getTime() - t0 >= 24 * HOUR) break
      await drain()
      const id = await identity()
      expect(id?.instanceId).toBe(first.instanceId)
      expect(id?.state).toBe("registered")
    }
    now = new Date(t0 + 24 * HOUR + MIN)
    await drain()
    const second = await identity()
    expect(second?.instanceId).not.toBe(first.instanceId)
    expect(second?.state).toBe("pending")
    expect((await row(h.id)).attempts).toBeGreaterThanOrEqual(5)

    await fake.control.setMode("up")
    await drain()
    expect((await identity())?.state).toBe("registered")
    await drain()
    const ack = heartbeatAcks().find((a) => a.messageId === h.messageId)
    expect(ack?.instanceId).toBe(second?.instanceId as string)
  })

  // Discriminator: a drain that sends its whole batch against a slow control
  // plane (20 x 10 s, past its own 2-minute lease), or stamps every row with
  // the drain-start clock, fails.
  it("a slow control plane: one drain sends what fits in half the lease, gives the rest back, per-row clock", async () => {
    await registered()
    const sent = []
    for (let i = 0; i < 20; i++) sent.push(await heartbeat())
    let spent = 0
    const result = await drain(now, {
      elapsedMs: () => spent,
      fetch: async (url, init) => {
        const res = await fetch(url, init)
        spent += 10_000 // each send takes its whole 10 s timeout
        return res
      },
    })
    expect(result.claimed).toBe(20)
    expect(heartbeatAcks()).toHaveLength(6) // sent at 0, 10, ..., 50 s: done by 60 s
    const ts = heartbeatAcks().map((a) => {
      const req = requestsFor(a.messageId)[0]
      return Date.parse((req?.body as { ts?: string } | undefined)?.ts ?? "") - now.getTime()
    })
    expect(ts).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000])
    const rest = (await rows()).filter((r) => r.type === "heartbeat" && r.status !== "delivered")
    expect(rest).toHaveLength(14)
    for (const r of rest) {
      expect(r.status).toBe("pending")
      expect(r.attempts).toBe(0)
    }
    const [lease] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.control_plane_outbox WHERE lease_until IS NOT NULL`
    expect(lease?.n).toBe(0)
  })

  // Discriminator: a finish not fenced on its own lease overwrites the row a
  // later drain took over.
  it("a reply that comes back after another drain took the row over changes nothing", async () => {
    await registered()
    const h = await heartbeat()
    await drain(now, {
      fetch: async (url, init) => {
        // This send outlives its lease; another drain claims the row meanwhile.
        expect((await claimDue(at(3 * MIN))).map((r) => r.id)).toEqual([h.id])
        return fetch(url, init)
      },
    })
    const r = await row(h.id)
    expect(r.status).toBe("sending")
    expect(r.attempts).toBe(0)
  })

  // Discriminator: treating a verifier 503 as an auth failure fails.
  it("verifier 503 keeps the identity", async () => {
    const first = await registered()
    const h = await heartbeat()
    await fake.control.setMode("503", { retryAfterSeconds: 600 })
    await drain()
    const id = await identity()
    expect(id?.instanceId).toBe(first.instanceId)
    expect(id?.state).toBe("registered")
    expect(id?.authFailingSince).toBeNull()
    const r = await row(h.id)
    expect(r.status).toBe("pending")
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThanOrEqual(at(600 * 1000).getTime())
  })

  // Discriminator: refusing the row, or re-sending it under the old id, fails.
  it("403 unknown_instance re-registers and the pending row is then delivered under the new id", async () => {
    const first = await registered()
    const h = await heartbeat()
    fake.control.forget(first.instanceId)
    await drain()
    const second = await identity()
    expect(second?.state).toBe("pending")
    expect(second?.instanceId).not.toBe(first.instanceId)
    expect((await row(h.id)).status).toBe("pending")
    await drain()
    expect((await identity())?.state).toBe("registered")
    await drain()
    const ack = heartbeatAcks().find((a) => a.messageId === h.messageId)
    expect(ack?.instanceId).toBe(second?.instanceId as string)
  })

  // Discriminator: retrying under the same id loops on 409 for ever.
  it("409 already_registered mints a new identity", async () => {
    await turn({ register: true })
    const first = await identity()
    const [reg] = await rows()
    fake.control.queueReplies([{ status: 409, body: { error: { message: "already_registered" } } }])
    await drain()
    const second = await identity()
    expect(second?.state).toBe("pending")
    expect(second?.instanceId).not.toBe(first?.instanceId as string)
    expect((await row(reg?.id as string)).message_id).not.toBe(reg?.message_id as string)
    await drain()
    const done = await identity()
    expect(done?.state).toBe("registered")
    expect(done?.instanceId).toBe(second?.instanceId as string)
  })

  // Discriminator: taking a register ack with no key as delivered leaves the
  // identity pending for ever with nothing left to send.
  it("a register ack without a key is retried, not delivered", async () => {
    await turn({ register: true })
    const [reg] = await rows()
    fake.control.queueReplies([
      { status: 200, body: { data: { type: "ack", messageId: reg?.message_id } } },
    ])
    await drain()
    const r = await row(reg?.id as string)
    expect(r.status).toBe("pending")
    expect(r.last_error).toContain("without an instance key")
    expect((await identity())?.state).toBe("pending")
  })

  // Discriminator: taking a duplicate as delivered leaves the key never stored.
  it("duplicate reply on register retries with a new messageId", async () => {
    await turn({ register: true })
    const first = await identity()
    const [reg] = await rows()
    fake.control.queueReplies([
      { status: 200, body: { data: { received: true, duplicate: true } } },
    ])
    await drain()
    const r = await row(reg?.id as string)
    expect(r.status).toBe("pending")
    expect(r.message_id).not.toBe(reg?.message_id as string)
    expect((await identity())?.state).toBe("pending")
    await drain()
    const done = await identity()
    expect(done?.state).toBe("registered")
    expect(done?.instanceId).toBe(first?.instanceId as string)
  })
})

describe("liaison team switch transitions", () => {
  // Discriminator: sending queued rows after the switch-off, or keeping the identity, fails.
  it("off while registered cancels rows, sends deregister, deletes identity after ack", async () => {
    await registered()
    await turn({ forwardBugReports: true })
    const h = await heartbeat()
    const sharing = await turn({ register: false })
    expect(sharing.forwardBugReports).toBe(false)
    expect((await row(h.id)).status).toBe("cancelled")
    expect((await identity())?.state).toBe("retiring")
    expect((await rows()).filter((r) => r.type === "deregister").map((r) => r.status)).toEqual([
      "pending",
    ])
    await drain()
    expect(fake.control.acks().map((a) => a.type)).toEqual(["register", "deregister"])
    expect(await identity()).toBeNull()
    expect(requestsFor(h.messageId)).toHaveLength(0)
  })

  // Discriminator: a sender that sends any non-deregister row while the
  // identity is retiring sends a row that missed the switch-off's cancel.
  it("a row queued after the switch-off's cancel is cancelled while retiring, never sent", async () => {
    await registered()
    await turn({ register: false })
    // Queued as if by a transaction that read `registered` before the switch
    // went off. The deregister is held back for this drain so the heartbeat
    // meets the identity while it is still retiring.
    const h = await heartbeat()
    await sql`UPDATE kernel.control_plane_outbox
                 SET next_attempt_at = ${at(HOUR).toISOString()}::timestamptz
               WHERE type = 'deregister'`
    expect((await identity())?.state).toBe("retiring")
    await drain()
    const r = await row(h.id)
    expect([r.status, r.last_error]).toEqual(["cancelled", "retiring"])
    expect(requestsFor(h.messageId)).toHaveLength(0)
    expect(fake.control.acks().map((a) => a.type)).toEqual(["register"])
  })

  // Discriminator: queuing a deregister that cannot be signed fails.
  it("off while pending deletes identity, no deregister sent", async () => {
    await turn({ register: true })
    await turn({ register: false })
    expect(await identity()).toBeNull()
    const all = await rows()
    expect(all.map((r) => [r.type, r.status])).toEqual([["register", "cancelled"]])
    await drain()
    expect(fake.control.requests()).toHaveLength(0)
  })

  // Discriminator: minting a new id here loses the registration.
  it("on while retiring with a pending deregister restores registered with the same id", async () => {
    const first = await registered()
    await turn({ register: false })
    await turn({ register: true })
    const id = await identity()
    expect(id?.state).toBe("registered")
    expect(id?.instanceId).toBe(first.instanceId)
    expect((await rows()).find((r) => r.type === "deregister")?.status).toBe("cancelled")
    await drain()
    expect(fake.control.acks().map((a) => a.type)).toEqual(["register"])
  })

  // Discriminator: cancelling an in-flight deregister would race its ack.
  it("on while the deregister is sending -> 409 RETIRING", async () => {
    await registered()
    await turn({ register: false })
    expect((await claimDue(now)).map((r) => r.type)).toEqual(["deregister"])
    const err = await turn({ register: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LiaisonTeamError)
    expect((err as LiaisonTeamError).status).toBe(409)
    expect((err as LiaisonTeamError).code).toBe("RETIRING")
    expect((await withSystemDb("test", (tx) => readSharing(tx))).register).toBe(false)
  })

  // Discriminator: a register reply applied without the switches' lock writes
  // the identity back after an admin turned registration off.
  it("a register reply in flight during a switch-off never brings the identity back", async () => {
    await turn({ register: true })
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => {}
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve
    })
    // An admin's switch-off (off while pending deletes the identity), holding
    // the switches' lock until the drain's reply is being applied.
    const switchOff = sql.begin(async (t) => {
      await t`SELECT pg_advisory_xact_lock(hashtext('liaison:liaison_team'))`
      await t`DELETE FROM kernel.instance_settings WHERE key = 'liaison_team.identity'`
      locked()
      await released
    })
    await lockHeld
    const drained = drain()
    expect(await someoneWaitsOnALock()).toBe(true)
    release()
    await switchOff
    await drained
    expect(await identity()).toBeNull()
  })

  // Discriminator: a deregister put back in the queue after 403 unknown_instance
  // (or 409) waits, then deregisters the next identity.
  it("a deregister answered unknown_instance or 409 ends and never goes out under a new id", async () => {
    for (const reply of ["forget", "409"] as const) {
      const first = await registered()
      await turn({ register: false })
      if (reply === "forget") fake.control.forget(first.instanceId)
      else {
        fake.control.queueReplies([
          { status: 409, body: { error: { message: "already_registered" } } },
        ])
      }
      await drain()
      const dereg = (await rows()).filter((r) => r.type === "deregister").at(-1)
      expect(dereg?.status).toBe("delivered")
      expect(await identity()).toBeNull()

      advance(MIN)
      const second = await registered()
      await drain()
      await drain()
      const deregs = fake.control
        .requests()
        .filter((r) => (r.body as { type?: string })?.type === "deregister")
        .map((r) => (r.body as { instanceId?: string }).instanceId)
      expect(deregs).not.toContain(second.instanceId)
      expect((await identity())?.instanceId).toBe(second.instanceId)
      await turn({ register: false })
      await drain()
      advance(MIN)
    }
  })

  // Discriminator: an unreadable key while leaving that registers again sends
  // data after the admin opted out.
  it("an unreadable key while retiring forgets the identity and never registers again", async () => {
    await registered()
    await turn({ register: false })
    await corruptKey()
    await drain()
    await drain()
    expect(await identity()).toBeNull()
    const types = (await rows()).map((r) => [r.type, r.status]).sort()
    expect(types).toEqual([
      ["deregister", "cancelled"],
      ["register", "delivered"],
    ])
    expect(
      fake.control.requests().filter((r) => (r.body as { type?: string })?.type === "register"),
    ).toHaveLength(1)
  })

  // Discriminator: an expired registration shown as "Registering" for ever fails.
  it("an expired register -> state error, registration expired", async () => {
    await turn({ register: true })
    await fake.control.setMode("down")
    await drain()
    advance(7 * DAY + MIN)
    await drain()
    const status = await readStatus()
    expect(status.state).toBe("error")
    expect(status.lastError).toBe("registration expired")
  })

  // Discriminator: hiding a refused registration behind "Registering" fails.
  it("refused register -> state error with lastError", async () => {
    await turn({ register: true })
    const first = await identity()
    fake.control.queueReplies([{ status: 400, body: { error: { message: "invalid_message" } } }])
    await drain()
    const status = await readStatus()
    expect(status.state).toBe("error")
    expect(status.lastError).toContain("invalid_message")
    expect((await identity())?.state).toBe("pending")

    advance(MIN)
    await turn({ register: false })
    await turn({ register: true })
    const again = await readStatus()
    expect(again.state).toBe("pending")
    expect((await identity())?.instanceId).not.toBe(first?.instanceId as string)
  })

  it("forwarding needs registration", async () => {
    const err = await turn({ forwardBugReports: true }).catch((e: unknown) => e)
    expect((err as LiaisonTeamError).code).toBe("REGISTRATION_REQUIRED")
    expect((err as LiaisonTeamError).status).toBe(400)
  })

  it("an empty endpoint makes sharing unavailable", async () => {
    ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = LIAISON_TEAM_DISABLED
    const err = await turn({ register: true }).catch((e: unknown) => e)
    expect((err as LiaisonTeamError).code).toBe("LIAISON_TEAM_UNAVAILABLE")
    expect((await readStatus()).available).toBe(false)
  })
})

describe("liaison team outbox ordering and retention", () => {
  // Discriminator: sending a child before its parent, or after a refused parent, fails.
  it("a depends_on row waits for its parent and is cancelled when the parent is refused", async () => {
    await registered()
    const parent = await heartbeat()
    const child = await heartbeat(parent.id)
    fake.control.queueReplies([{ status: 503, body: { error: { message: "Webhook rejected" } } }])
    await drain()
    expect(requestsFor(child.messageId)).toHaveLength(0)
    expect((await row(child.id)).status).toBe("pending")
    advance(2 * HOUR)
    await drain()
    expect((await row(parent.id)).status).toBe("delivered")
    await drain()
    expect((await row(child.id)).status).toBe("delivered")

    const parent2 = await heartbeat()
    const child2 = await heartbeat(parent2.id)
    fake.control.queueReplies([{ status: 400, body: { error: { message: "invalid_message" } } }])
    await drain()
    expect((await row(parent2.id)).status).toBe("refused")
    await drain()
    const c2 = await row(child2.id)
    expect(c2.status).toBe("cancelled")
    expect(c2.last_error).toBe("parent_refused")
    expect(requestsFor(child2.messageId)).toHaveLength(0)
  })

  // Discriminator: retrying for ever fails.
  it("row older than 7 days becomes expired", async () => {
    await registered()
    const h = await heartbeat()
    await fake.control.setMode("down")
    await drain()
    advance(7 * DAY + MIN)
    await drain()
    expect((await row(h.id)).status).toBe("expired")
  })

  // Discriminator: keeping report data for ever (or deleting the counters early) fails.
  it("delivered row data is purged after 7 days", async () => {
    await registered()
    const h = await heartbeat()
    await drain()
    expect((await row(h.id)).status).toBe("delivered")
    advance(7 * DAY + HOUR)
    await drain()
    const r = await row(h.id)
    expect(r.status).toBe("delivered")
    expect(r.data).toEqual({})
    expect(r.purged_at).not.toBeNull()
    advance(90 * DAY)
    await drain()
    expect((await rows()).find((x) => x.id === h.id)).toBeUndefined()
  })
})
