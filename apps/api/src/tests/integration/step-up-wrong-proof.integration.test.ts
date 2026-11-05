// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A wrong step-up proof is a 422, never a 401, on every route that asks for
// one: TOTP setup, TOTP disable, the mailbox reset (and account delete, pinned
// in account-delete.integration.test.ts). The web client reads any 401 as a
// dead session: it refreshes, resends the same wrong code (a second counted
// attempt) and then signs the user out mid dialog. A missing session is still
// a 401. After each refusal the same session keeps working.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import {
  STEP_UP_MAX_WRONG_CODES,
  STEP_UP_MAX_WRONG_PASSWORDS,
  type StepUpPurpose,
  stepUpCodeKey,
} from "~/modules/auth/step-up"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(releaseTestLock)

function headers(bearer?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  }
}

type Route = { name: string; method: string; path: string; purpose?: StepUpPurpose }

const ROUTES: Route[] = [
  { name: "TOTP setup", method: "POST", path: "/api/auth/totp/setup" },
  { name: "TOTP disable", method: "DELETE", path: "/api/auth/totp" },
  {
    name: "mailbox reset",
    method: "POST",
    path: "/api/mailbox-keys/reset",
    purpose: "mailbox_reset",
  },
]

async function call(route: Route, bearer: string | undefined, body: unknown): Promise<Response> {
  return app.request(route.path, {
    method: route.method,
    headers: headers(bearer),
    body: JSON.stringify(body),
  })
}

async function plantCode(userId: string, purpose?: StepUpPurpose): Promise<string> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(userId, purpose), hashToken(code), "EX", 600)
  return code
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

/** A member session; TOTP disable needs TOTP on, so it is switched on for it. */
async function sessionFor(route: Route): Promise<minimal.Session> {
  // The mailbox keyring is reached only with the mail read scope.
  const orgId = (await createTestOrg()).id
  const session = route.purpose ? await minimal.adminSession(orgId) : await minimal.session(orgId)
  if (route.path === "/api/auth/totp" && route.method === "DELETE") {
    await withSystemDb("step-up-test-enable-totp", (db) =>
      db.execute(
        drizzleSql`UPDATE kernel.users SET totp_enabled = true WHERE id = ${session.userId}::uuid`,
      ),
    )
  }
  return session
}

async function sessionStillWorks(bearer: string): Promise<void> {
  const res = await app.request("/api/auth/totp/status", { headers: headers(bearer) })
  expect(res.status).toBe(200)
}

describe("a wrong step-up proof", () => {
  for (const route of ROUTES) {
    test(`${route.name}: a wrong emailed code is 422 and the session still works`, async () => {
      const session = await sessionFor(route)
      const code = await plantCode(session.userId, route.purpose)
      const res = await call(route, session.bearer, { stepUpCode: wrongCode(code) })
      expect(res.status).toBe(422)
      expect(JSON.stringify(await res.json())).toMatch(/invalid or expired step-up code/i)
      await sessionStillWorks(session.bearer)
    })

    test(`${route.name}: a wrong password is 422 and the session still works`, async () => {
      const session = await sessionFor(route)
      const res = await call(route, session.bearer, { currentPassword: "not-the-password" })
      expect(res.status).toBe(422)
      await sessionStillWorks(session.bearer)
    })

    test(`${route.name}: the last allowed wrong code is 422 and burns the code`, async () => {
      const session = await sessionFor(route)
      const code = await plantCode(session.userId, route.purpose)
      let last: Response | undefined
      for (let i = 0; i < STEP_UP_MAX_WRONG_CODES; i++) {
        last = await call(route, session.bearer, { stepUpCode: wrongCode(code) })
        expect(last.status).toBe(422)
      }
      expect(JSON.stringify(await last?.json())).toMatch(/too many wrong codes/i)
      expect(await redis.get(stepUpCodeKey(session.userId, route.purpose))).toBeNull()
      await sessionStillWorks(session.bearer)
    })

    test(`${route.name}: wrong passwords are counted, and past the limit even the right one is refused`, async () => {
      const session = await sessionFor(route)
      for (let i = 0; i < STEP_UP_MAX_WRONG_PASSWORDS; i++) {
        const res = await call(route, session.bearer, { currentPassword: `wrong-${i}` })
        expect(res.status).toBe(422)
      }
      const right = await call(route, session.bearer, { currentPassword: "Passw0rd!" })
      expect(right.status).toBe(429)
      await sessionStillWorks(session.bearer)
    })

    test(`${route.name}: no session is still 401`, async () => {
      const res = await call(route, undefined, { stepUpCode: "000000" })
      expect(res.status).toBe(401)
    })
  }
})
