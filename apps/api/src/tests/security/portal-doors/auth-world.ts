// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The people the portal sign-in tests need: two orgs; in the first, companies A
// and B open and C closed, a member, clients of A, B and C, a deactivated client
// of A and a client of A with a second factor; in the second, one client whose
// address is also a member's address in the first. Rows written as the test
// login (no product path creates a client yet).
import { app } from "~/app"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { generateTotpSecret } from "~/modules/auth/totp"
import { PORTAL_REFRESH_COOKIE } from "~/modules/portal/auth-routes"
import { insertSql } from "~/seed/factories/org/test-rows"
import { clearRedisPatterns } from "~/tests/route-test-setup"

/** A kernel table, schema resolved as every raw query must (schemaRef). */
const k = (table: string) => sql(`${schemaRef("kernel")}.${table}`)

export interface AuthWorld {
  org: { id: string; slug: string; name: string }
  otherOrg: { id: string; slug: string; name: string }
  companies: { a: string; b: string; closed: string; other: string }
  member: { id: string; email: string }
  clientA: { id: string; email: string }
  clientB: { id: string; email: string }
  clientClosed: { id: string; email: string }
  clientGone: { id: string; email: string }
  clientTotp: { id: string; email: string; secret: string }
  /** A client of the other org whose address is `member.email`. */
  twoOrgClient: { id: string; email: string }
}

export async function createAuthWorld(tag: string): Promise<AuthWorld> {
  const short = crypto.randomUUID().slice(0, 8)
  const org = { id: crypto.randomUUID(), slug: `pa-${tag}-${short}`, name: "Maison Portal" }
  const otherOrg = {
    id: crypto.randomUUID(),
    slug: `pb-${tag}-${short}`,
    name: "Maison Other",
  }
  for (const o of [org, otherOrg]) {
    await sql.unsafe(insertSql("kernel.organizations", { id: o.id, name: o.name, slug: o.slug }))
  }
  const companies = {
    a: crypto.randomUUID(),
    b: crypto.randomUUID(),
    closed: crypto.randomUUID(),
    other: crypto.randomUUID(),
  }
  await sql.unsafe(
    insertSql("kernel.companies", [
      { id: companies.a, org_id: org.id, handle: `a-${short}`, name: "Client A" },
      { id: companies.b, org_id: org.id, handle: `b-${short}`, name: "Client B" },
      { id: companies.closed, org_id: org.id, handle: `c-${short}`, name: "Client C" },
      { id: companies.other, org_id: otherOrg.id, handle: `d-${short}`, name: "Client D" },
    ]),
  )
  await sql`UPDATE ${k("companies")} SET closed_at = now() WHERE id = ${companies.closed}`

  const person = (name: string) => ({
    id: crypto.randomUUID(),
    email: `${name}-${short}@example.com`,
  })
  const member = person("member")
  const clientA = person("client-a")
  const clientB = person("client-b")
  const clientClosed = person("client-c")
  const clientGone = person("client-gone")
  const totp = person("client-totp")
  const secret = generateTotpSecret()
  const twoOrgClient = { id: crypto.randomUUID(), email: member.email }

  const external = (p: { id: string; email: string }, company: string, orgId = org.id) => ({
    id: p.id,
    org_id: orgId,
    email: p.email,
    name: "Client person",
    user_type: "external",
    company_id: company,
    status: "active",
  })
  await sql.unsafe(
    insertSql("kernel.users", [
      {
        id: member.id,
        org_id: org.id,
        email: member.email,
        name: "Member person",
        user_type: "member",
        company_id: null,
        status: "active",
      },
      external(clientA, companies.a),
      external(clientB, companies.b),
      external(clientClosed, companies.closed),
      { ...external(clientGone, companies.a), status: "deactivated" },
      external(totp, companies.a),
      external(twoOrgClient, companies.other, otherOrg.id),
    ]),
  )
  await sql`UPDATE ${k("users")} SET totp_enabled = true,
    totp_secret = ${encryptSecret(secret, encryptionKey, CryptoContext.totpSecret)}
    WHERE id = ${totp.id}`
  return {
    org,
    otherOrg,
    companies,
    member,
    clientA,
    clientB,
    clientClosed,
    clientGone,
    clientTotp: { ...totp, secret },
    twoOrgClient,
  }
}

export async function dropAuthWorld(w: AuthWorld): Promise<void> {
  const orgs = [w.org.id, w.otherOrg.id]
  await sql`DELETE FROM ${k("sessions")} WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM ${k("password_resets")} WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM ${k("users")} WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM ${k("companies")} WHERE org_id IN ${sql(orgs)}`
  await sql`DELETE FROM ${k("organizations")} WHERE id IN ${sql(orgs)}`
}

export class CaptureProvider implements EmailProvider {
  sent: EmailMessage[] = []
  constructor(private delayMs = 0) {}
  async send(message: EmailMessage): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    this.sent.push(message)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

export const ORIGIN = "http://localhost:5173"

export function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** The challenge id and token of a captured portal sign-in mail (its link's fragment). */
export function linkOf(mail: EmailMessage | undefined): { challengeId: string; token: string } {
  const m = (mail?.text ?? mail?.html ?? "").match(
    /#c=([A-Za-z0-9_-]+)&(?:amp;)?t=([A-Za-z0-9_-]+)/,
  )
  if (!m?.[1] || !m[2]) throw new Error("no portal sign-in link in the mail")
  return { challengeId: m[1], token: m[2] }
}

export function cookieOf(res: Response): string | null {
  const set = res.headers.get("set-cookie") ?? ""
  const m = set.match(new RegExp(`${PORTAL_REFRESH_COOKIE}=([^;]*)`))
  return m?.[1] ? m[1] : null
}

/** Forgets the sign-in send budgets (portal and member), so one run may ask for several links. */
export async function clearSends(): Promise<void> {
  await clearRedisPatterns([
    "portal:signin:*",
    "magic-rate:*",
    "magic:cooldown:*",
    "magic:email-hour:*",
    "magic:email-day:*",
    "reset-rate:*",
  ])
}
