// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The code and proof budgets of the public client action page, against Redis:
// sends (first on demand, one a minute, 5 an hour, 10 a day), the code's life
// (10 minutes, one use, a new one replaces the old), wrong answers (5 per code
// then a 15-minute pause that refuses even the right code) and the proof (20
// minutes, this action and this browser only, once). The 20-in-total lock lives
// on the row and is pinned by the door tests (portal-doors/client-actions).
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import {
  CODE_TTL_SECONDS,
  checkCode,
  codeKeysOf,
  issueCode,
  issueProof,
  PAUSE_SECONDS,
  PROOF_TTL_SECONDS,
  pausedUntil,
  SEND_GAP_SECONDS,
  SENDS_PER_DAY,
  SENDS_PER_HOUR,
  spendProof,
  takeCodeSend,
  WRONG_PER_CODE,
  WRONG_TOTAL_LOCK,
} from "./codes"

const ids: string[] = []
function action(): string {
  const id = crypto.randomUUID()
  ids.push(id)
  return id
}

async function clearAll() {
  for (const id of ids.splice(0)) {
    await redis.del(
      ...codeKeysOf(id),
      `ca:code:gap:${id}`,
      `ca:code:hour:${id}`,
      `ca:code:day:${id}`,
    )
  }
}

/** Lets the next send through the one-a-minute gap, as a minute passing would. */
async function passGap(id: string) {
  await redis.del(`ca:code:gap:${id}`)
}

function wrongOf(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

afterEach(clearAll)
afterAll(clearAll)

describe("client action code budgets", () => {
  it("the budgets are the protocol's: 10 and 20 minutes, a minute, 5 and 10 sends, 5 wrong, 15 minutes, 20 in all", () => {
    expect({
      CODE_TTL_SECONDS,
      PROOF_TTL_SECONDS,
      SEND_GAP_SECONDS,
      SENDS_PER_HOUR,
      SENDS_PER_DAY,
      WRONG_PER_CODE,
      PAUSE_SECONDS,
      WRONG_TOTAL_LOCK,
    }).toEqual({
      CODE_TTL_SECONDS: 600,
      PROOF_TTL_SECONDS: 1200,
      SEND_GAP_SECONDS: 60,
      SENDS_PER_HOUR: 5,
      SENDS_PER_DAY: 10,
      WRONG_PER_CODE: 5,
      PAUSE_SECONDS: 900,
      WRONG_TOTAL_LOCK: 20,
    })
  })

  it("the first send goes on demand and the next one waits a minute", async () => {
    const id = action()
    expect(await takeCodeSend(id)).toEqual({ ok: true })
    const second = await takeCodeSend(id)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      const wait = (second.retryAt.getTime() - Date.now()) / 1000
      expect(wait).toBeGreaterThan(SEND_GAP_SECONDS - 5)
      expect(wait).toBeLessThanOrEqual(SEND_GAP_SECONDS + 1)
    }
  })

  it("five sends an hour go out and the sixth is refused with when to retry", async () => {
    const id = action()
    for (let i = 0; i < SENDS_PER_HOUR; i++) {
      expect(await takeCodeSend(id)).toEqual({ ok: true })
      await passGap(id)
    }
    const sixth = await takeCodeSend(id)
    expect(sixth.ok).toBe(false)
    if (!sixth.ok) expect(sixth.retryAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
  })

  it("ten sends a day go out and the eleventh is refused even in a new hour", async () => {
    const id = action()
    for (let i = 0; i < SENDS_PER_DAY; i++) {
      expect(await takeCodeSend(id)).toEqual({ ok: true })
      await passGap(id)
      // A new hour: the hour's count starts again, the day's does not.
      if (i === SENDS_PER_HOUR - 1) await redis.del(`ca:code:hour:${id}`)
    }
    await redis.del(`ca:code:hour:${id}`)
    expect((await takeCodeSend(id)).ok).toBe(false)
  })

  it("one action's budget is not another's", async () => {
    const a = action()
    const b = action()
    expect(await takeCodeSend(a)).toEqual({ ok: true })
    expect(await takeCodeSend(b)).toEqual({ ok: true })
  })
})

describe("client action codes", () => {
  it("a code is six digits, lives ten minutes and is stored only as a hash", async () => {
    const id = action()
    const code = await issueCode(id)
    expect(code).toMatch(/^\d{6}$/)
    const ttl = await redis.ttl(`ca:code:${id}`)
    expect(ttl).toBeGreaterThan(CODE_TTL_SECONDS - 5)
    expect(ttl).toBeLessThanOrEqual(CODE_TTL_SECONDS)
    const stored = await redis.get(`ca:code:${id}`)
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toContain(code)
  })

  it("the right code passes once; the second use finds no code", async () => {
    const id = action()
    const code = await issueCode(id)
    expect(await checkCode(id, code)).toEqual({ ok: true })
    expect(await checkCode(id, code)).toEqual({ ok: false, reason: "no_code" })
  })

  it("a new code replaces the old one", async () => {
    const id = action()
    const first = await issueCode(id)
    let second = await issueCode(id)
    while (second === first) second = await issueCode(id)
    const old = await checkCode(id, first)
    expect(old.ok).toBe(false)
    expect(await checkCode(id, second)).toEqual({ ok: true })
  })

  it("one action's code never opens another action, even sent to the same address", async () => {
    const a = action()
    const b = action()
    const codeA = await issueCode(a)
    await issueCode(b)
    const onB = await checkCode(b, codeA)
    // Two different codes may collide by chance once in a million: then B's code is A's too.
    if (!onB.ok) expect(onB.reason).toBe("wrong")
    expect(await checkCode(a, codeA)).toEqual({ ok: true })
  })

  it("four wrong answers leave the code alive; the fifth pauses fifteen minutes and spends it", async () => {
    const id = action()
    const code = await issueCode(id)
    for (let i = 1; i < WRONG_PER_CODE; i++) {
      const r = await checkCode(id, wrongOf(code))
      expect(r).toMatchObject({ ok: false, reason: "wrong", wrongForCode: i, pausedNow: false })
    }
    const fifth = await checkCode(id, wrongOf(code))
    expect(fifth).toMatchObject({ ok: false, reason: "wrong", pausedNow: true, pausesInARow: 1 })
    const until = await pausedUntil(id)
    expect(until).not.toBeNull()
    const left = ((until?.getTime() ?? 0) - Date.now()) / 1000
    expect(left).toBeGreaterThan(PAUSE_SECONDS - 5)
    // During the pause the right code is refused too, and after it that code is gone.
    expect(await checkCode(id, code)).toMatchObject({ ok: false, reason: "paused" })
    await redis.del(`ca:code:pause:${id}`)
    expect(await checkCode(id, code)).toEqual({ ok: false, reason: "no_code" })
  })

  it("a new code clears the wrong count of the one it replaces", async () => {
    const id = action()
    const first = await issueCode(id)
    for (let i = 1; i < WRONG_PER_CODE; i++) await checkCode(id, wrongOf(first))
    const second = await issueCode(id)
    const r = await checkCode(id, wrongOf(second))
    expect(r).toMatchObject({ ok: false, reason: "wrong", wrongForCode: 1, pausedNow: false })
  })

  it("pauses in a row are counted, and a right code ends the run", async () => {
    const id = action()
    for (let round = 1; round <= 2; round++) {
      const code = await issueCode(id)
      let last: Awaited<ReturnType<typeof checkCode>> = { ok: true }
      for (let i = 0; i < WRONG_PER_CODE; i++) last = await checkCode(id, wrongOf(code))
      expect(last).toMatchObject({ pausesInARow: round })
      await redis.del(`ca:code:pause:${id}`)
    }
    const code = await issueCode(id)
    expect(await checkCode(id, code)).toEqual({ ok: true })
    expect(await redis.get(`ca:code:pauses:${id}`)).toBeNull()
  })
})

describe("client action proofs", () => {
  it("a proof lives twenty minutes, is stored only as a hash and holds no code", async () => {
    const id = action()
    const proof = await issueProof(id, "browser-a", "Anne Martin", null)
    const key = `ca:proof:${hashToken(proof)}`
    const v = await redis.get(key)
    expect(v).toContain(id)
    expect(v).not.toContain(proof)
    expect(await redis.exists(`ca:proof:${proof}`)).toBe(0)
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(PROOF_TTL_SECONDS - 5)
    await redis.del(key)
  })

  it("a proof is spent once, by this action and the browser that verified only", async () => {
    const id = action()
    const other = action()
    const proof = await issueProof(id, "browser-a", "Anne Martin", "Director")
    expect(await spendProof(other, proof, "browser-a")).toEqual({ ok: false })
    expect(await spendProof(id, proof, "browser-b")).toEqual({ ok: false })
    expect(await spendProof(id, proof, "browser-a")).toEqual({
      ok: true,
      name: "Anne Martin",
      capacity: "Director",
    })
    expect(await spendProof(id, proof, "browser-a")).toEqual({ ok: false })
  })

  it("no proof, or an over-long one, is refused without a lookup", async () => {
    const id = action()
    expect(await spendProof(id, undefined, "browser-a")).toEqual({ ok: false })
    expect(await spendProof(id, "x".repeat(129), "browser-a")).toEqual({ ok: false })
  })
})
