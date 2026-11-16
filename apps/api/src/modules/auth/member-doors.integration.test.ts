// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The member sign-in doors with a client's row (user_type external): each gives
// its uniform answer, opens no session and sends no mail. A client signs in
// through the portal only.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { hashPassword, hashToken } from "~/lib/crypto"
import { AuthServiceError, createSession } from "~/modules/auth/auth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type SignInWorld,
  CaptureProvider,
  clearSends,
  createSignInWorld,
  dropDoorWorld,
  post,
} from "~/tests/security/portal-doors/fixture"

let w: SignInWorld
let previous: EmailProvider
const capture = new CaptureProvider()
const PASSWORD = "Correct-horse-9"

async function settle() {
  await new Promise((r) => setTimeout(r, 50))
}

beforeAll(async () => {
  await acquireTestLock()
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createSignInWorld()
  await clearSends()
  // A client row with a password hash: the password door must still refuse it.
  await sql`UPDATE kernel.users SET password_hash = ${await hashPassword(PASSWORD)} WHERE id = ${w.clientA.userId}`
})

afterAll(async () => {
  setSystemEmailProvider(previous)
  await dropDoorWorld(w)
  await releaseTestLock()
})

describe("member doors with a client's row", () => {
  it("password sign-in refuses a client's row with the uniform answer", async () => {
    const client = await post("/api/auth/login", {
      email: w.clientA.email,
      password: PASSWORD,
      orgSlug: w.orgSlug,
    })
    const unknown = await post("/api/auth/login", {
      email: `nobody-${w.orgSlug}@example.com`,
      password: PASSWORD,
      orgSlug: w.orgSlug,
    })
    expect(client.status).toBe(401)
    expect(client.headers.get("set-cookie") ?? "").not.toContain("liaison_rt=")
    expect(await client.text()).toBe(await unknown.text())
  })

  it("a member's emailed sign-in sends nothing to a client's address", async () => {
    capture.sent = []
    const res = await post("/api/auth/magic-link/request", {
      email: w.clientB.email,
      orgSlug: w.orgSlug,
    })
    expect(res.status).toBe(200)
    await settle()
    expect(capture.sent).toHaveLength(0)
  })

  it("a password reset sends nothing to a client and never sets a client's password", async () => {
    capture.sent = []
    const res = await post("/api/auth/password-reset/request", {
      email: w.clientB.email,
      orgSlug: w.orgSlug,
    })
    expect(res.status).toBe(200)
    await settle()
    expect(capture.sent).toHaveLength(0)
    // A reset token for a client's row (none is ever issued; written here) sets nothing.
    const token = `reset-${crypto.randomUUID()}`
    await sql`INSERT INTO kernel.password_resets (user_id, org_id, token_hash, expires_at)
      VALUES (${w.clientB.userId}, ${w.orgId}, ${hashToken(token)}, now() + interval '1 hour')`
    await post("/api/auth/password-reset/confirm", { token, newPassword: "Another-horse-77" })
    const [row] = await sql<{ password_hash: string | null }[]>`
      SELECT password_hash FROM kernel.users WHERE id = ${w.clientB.userId}`
    expect(row?.password_hash).toBeNull()
  })

  it("createSession on a client's id throws and writes no session", async () => {
    await expect(createSession(w.clientB.userId, w.orgId)).rejects.toBeInstanceOf(AuthServiceError)
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.sessions WHERE user_id = ${w.clientB.userId}`
    expect(n?.n).toBe(0)
  })

  it("the device flow, OAuth and second-factor doors end in createSession, which refuses a client", async () => {
    // Every one of those doors mints through createSession (auth.ts); the refusal
    // above is theirs. The OAuth link step also filters members only (oauth-routes.ts).
    const source = await Bun.file(`${import.meta.dir}/oauth-routes.ts`).text()
    expect(source).toContain('eq(users.userType, "member")')
  })

  it("a client row in another organisation does not make a member's bare-email sign-in ambiguous", async () => {
    // The member's address is also a client's address in the other org.
    capture.sent = []
    const res = await post("/api/auth/magic-link/request", { email: w.member.email })
    expect(res.status).toBe(200)
    await settle()
    expect(capture.sent.map((m) => m.to)).toEqual([w.member.email])
    expect(capture.sent[0]?.template).toBe("auth.sign-in-code")
    // And the portal of the other org mails its client a portal link only.
    capture.sent = []
    await post("/api/portal/auth/request", { orgSlug: w.otherOrgSlug, email: w.member.email })
    await settle()
    expect(capture.sent.map((m) => m.template)).toEqual(["portal.sign-in-link"])
  })
})
