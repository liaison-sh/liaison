// SPDX-License-Identifier: FSL-1.1-ALv2
// The public ticket-create route skips the generic /webhooks limiter and does
// its own. A flood of junk API keys must hit a per-source ceiling before it
// buys one privileged key lookup each: after 20 failed keys a source is cut
// off, whatever key it presents next.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000000aa"

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns(["tickets-public:authfail:*", "*webhook:tickets:*"])
})
afterAll(async () => {
  await clearRedisPatterns(["tickets-public:authfail:*", "*webhook:tickets:*"])
  await releaseTestLock()
})

describe("public ticket create: pre-auth throttle on failed keys", () => {
  it("cuts a source off after 20 failed API keys", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) {
      const res = await app.request(`/webhooks/${ORG}/tickets/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `ApiKey junk-${i}`,
          "x-bun-socket-ip": "203.0.113.77",
        },
        body: JSON.stringify({ subject: "s", fromEmail: "a@example.com", textBody: "x" }),
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
    expect(statuses[20]).toBe(429)
    expect(statuses[21]).toBe(429)
  }, 60_000)
})
