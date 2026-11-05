// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one route the desktop can call before anybody has logged in. It exists
// so a first launch can show the deployment's own name instead of a blank
// window, which means it is UNAUTHENTICATED, which means every field it
// carries is public. The key set is asserted exactly for that reason: a field
// added later without thinking is a field published to the internet.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("public branding route", () => {
  let orgName: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    const [row] = await sql<{ name: string }[]>`
      SELECT name FROM kernel.organizations WHERE id = ${org.id}`
    orgName = row.name
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("answers with the deployment's org name and no authorization header", async () => {
    const response = await app.request("/api/settings/branding")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { orgName: string; logoUrl: string | null; flags: unknown; byokModelIds: unknown }
    }
    expect(body.data.orgName).toBe(orgName)
    expect(body.data.logoUrl).toBeNull()
    expect(body.data.flags).toEqual({})
    expect(body.data.byokModelIds).toEqual([])
  })

  // The one thing a LOGGED OUT window has to learn from the server: is this the
  // public demo box? Without it the web client would need a build flag, and the
  // same bundle would offer the demo doors on every self-hosted install.
  it("raises the demo flag only on a demo deployment", async () => {
    const before = await app.request("/api/settings/branding")
    const beforeBody = (await before.json()) as { data: { flags: Record<string, boolean> } }
    expect(beforeBody.data.flags).toEqual({})

    DemoModeTestAccess.set(true)
    try {
      const response = await app.request("/api/settings/branding")
      const body = (await response.json()) as { data: { flags: Record<string, boolean> } }
      expect(body.data.flags).toEqual({ demo: true })
      // The flag rides inside `flags`; the demo door's public settings add
      // exactly one key, `demo`, on a demo deployment only.
      const data = (body as unknown as { data: Record<string, unknown> }).data
      expect(Object.keys(data).sort()).toEqual([
        "byokModelIds",
        "demo",
        "flags",
        "logoUrl",
        "orgName",
      ])
    } finally {
      DemoModeTestAccess.set(null)
    }
  })

  it("publishes the demo door's public settings only on a demo deployment", async () => {
    const keys = {
      site: env.TURNSTILE_SITE_KEY,
      secret: env.TURNSTILE_SECRET_KEY,
      booking: env.LIAISON_DEMO_BOOKING_URL,
      selfHost: env.LIAISON_DEMO_SELF_HOST_URL,
    }
    env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA"
    env.TURNSTILE_SECRET_KEY = "secret-never-published"
    env.LIAISON_DEMO_BOOKING_URL = undefined
    env.LIAISON_DEMO_SELF_HOST_URL = undefined
    DemoModeTestAccess.set(true)
    try {
      const read = async () =>
        (
          (await (await app.request("/api/settings/branding")).json()) as {
            data: {
              demo?: { turnstileSiteKey?: string; bookingUrl?: string; selfHostUrl?: string }
            }
          }
        ).data
      const unset = await read()
      expect(unset.demo?.turnstileSiteKey).toBe("1x00000000000000000000AA")
      // Unset links are absent, never a guessed default.
      expect(unset.demo && "selfHostUrl" in unset.demo).toBe(false)
      expect(unset.demo && "bookingUrl" in unset.demo).toBe(false)
      expect(JSON.stringify(unset)).not.toContain("secret-never-published")
      env.LIAISON_DEMO_BOOKING_URL = "https://booking.example/liaison"
      expect((await read()).demo?.bookingUrl).toBe("https://booking.example/liaison")
      env.LIAISON_DEMO_SELF_HOST_URL = "https://liaison.example/self-host"
      expect((await read()).demo?.selfHostUrl).toBe("https://liaison.example/self-host")
      DemoModeTestAccess.set(null)
      expect((await read()).demo).toBeUndefined()
    } finally {
      DemoModeTestAccess.set(null)
      env.TURNSTILE_SITE_KEY = keys.site
      env.TURNSTILE_SECRET_KEY = keys.secret
      env.LIAISON_DEMO_BOOKING_URL = keys.booking
      env.LIAISON_DEMO_SELF_HOST_URL = keys.selfHost
    }
  })

  it("carries exactly four fields, so nothing sensitive can ride along unnoticed", async () => {
    const response = await app.request("/api/settings/branding")
    const body = (await response.json()) as { data: Record<string, unknown> }
    expect(Object.keys(body.data).sort()).toEqual(["byokModelIds", "flags", "logoUrl", "orgName"])
    // Not a key set question: the serialized body must not carry an address,
    // an id or a secret anywhere inside it either.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("@")
    expect(raw).not.toContain("providerKeys")
    expect(raw).not.toContain("slug")
  })

  it("is cacheable by anyone on a single-org box, because there is one answer", async () => {
    const response = await app.request("/api/settings/branding")
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
    // Declared even here: a cache must not learn the route is host-independent
    // from the one deployment shape where it happens to be. (CORS adds Origin
    // to the same header, so this is a membership check, not equality.)
    expect(
      response.headers
        .get("vary")
        ?.split(",")
        .map((v) => v.trim()),
    ).toContain("Host")
  })

  it("is refused nothing when a bad token is offered, because it never reads one", async () => {
    const response = await app.request("/api/settings/branding", {
      headers: { Authorization: "Bearer not-a-token" },
    })
    expect(response.status).toBe(200)
  })
})

// The multi-tenant half of the contract. A box holding more than one org used
// to answer every anonymous caller with the FIRST org's name and invite a
// shared cache to keep it, so both halves are asserted here: the right tenant
// answers, and the answer is not offered to a shared cache.
describe("public branding route, multi-tenant", () => {
  const orgA = { name: "Alpha Industries", slug: "alpha" }
  const orgB = { name: "Beta Works", slug: "beta" }

  beforeAll(async () => {
    await acquireTestLock()
    // Org A is the OLDEST org, so it is also what the pre-existing fallback
    // would answer: the host-resolution tests below only pass if the Host
    // header actually selected org B.
    const created = await createTestOrg()
    await sql`UPDATE kernel.organizations
              SET slug = ${orgA.slug}, name = ${orgA.name} WHERE id = ${created.id}`
    await sql`INSERT INTO kernel.organizations (name, slug) VALUES (${orgB.name}, ${orgB.slug})`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("answers each tenant with its OWN name, resolved from the Host header", async () => {
    const a = await app.request("/api/settings/branding", {
      headers: { Host: "alpha.demo.liaison.sh" },
    })
    const b = await app.request("/api/settings/branding", {
      headers: { Host: "beta.demo.liaison.sh" },
    })
    expect(((await a.json()) as { data: { orgName: string } }).data.orgName).toBe(orgA.name)
    expect(((await b.json()) as { data: { orgName: string } }).data.orgName).toBe(orgB.name)
  })

  // The slug existence oracle, closed. `?org=<slug>` let any anonymous caller
  // walk a wordlist: a hit returned that tenant's real org name, a miss
  // returned the oldest org's, and the two are trivially told apart. The query
  // string is no longer read at all, so a hit and a miss are the SAME answer.
  it("ignores ?org=<slug> entirely, so it cannot confirm a slug exists", async () => {
    const hit = await app.request("/api/settings/branding?org=beta")
    const miss = await app.request("/api/settings/branding?org=nosuchtenant")
    const hitName = ((await hit.json()) as { data: { orgName: string } }).data.orgName
    const missName = ((await miss.json()) as { data: { orgName: string } }).data.orgName
    expect(hitName).toBe(missName)
    // And what both return is the fallback, never org B's name.
    expect(hitName).toBe(orgA.name)
    expect(hit.headers.get("cache-control")).toBe(miss.headers.get("cache-control"))
  })

  // An address is not a tenant name. `10.0.0.5` used to have its first octet
  // taken as a candidate slug and queried for an org called "10".
  it("never treats an IP host as a slug", async () => {
    // A tenant really called "10" exists, so a first octet taken as a slug
    // would select it. This is the whole bug: `10.0.0.5` queried for slug "10".
    await sql`INSERT INTO kernel.organizations (name, slug) VALUES ('Octet Tenant', '10')
              ON CONFLICT (slug) DO NOTHING`
    for (const host of ["10.0.0.5", "10.0.0.5:3000", "127.0.0.1", "[2001:db8::1]:3000"]) {
      const response = await app.request("/api/settings/branding", { headers: { Host: host } })
      expect(response.status).toBe(200)
      const name = ((await response.json()) as { data: { orgName: string } }).data.orgName
      expect(name).not.toBe("Octet Tenant")
      expect(name).toBe(orgA.name)
    }
  })

  it("never offers a tenant's branding to a shared cache", async () => {
    const response = await app.request("/api/settings/branding", {
      headers: { Host: "beta.demo.liaison.sh" },
    })
    expect(response.headers.get("cache-control")).toBe("private, max-age=60")
    expect(
      response.headers
        .get("vary")
        ?.split(",")
        .map((v) => v.trim()),
    ).toContain("Host")
  })

  it("refuses to call a multi-org answer public even on the fallback path", async () => {
    // No Host tenant, no ?org: the oldest org still answers (unchanged), but
    // there is more than one possible answer, so nothing in between may keep it.
    const response = await app.request("/api/settings/branding")
    expect(response.headers.get("cache-control")).toBe("private, max-age=60")
  })

  it("ignores a host label that matches no org", async () => {
    const response = await app.request("/api/settings/branding", {
      headers: { Host: "gamma.demo.liaison.sh" },
    })
    // Falls through to the oldest org rather than 404ing an anonymous caller.
    expect(((await response.json()) as { data: { orgName: string } }).data.orgName).toBe(orgA.name)
  })

  it("carries the same four fields for a tenant-resolved answer", async () => {
    const response = await app.request("/api/settings/branding", {
      headers: { Host: "beta.demo.liaison.sh" },
    })
    const body = (await response.json()) as { data: Record<string, unknown> }
    expect(Object.keys(body.data).sort()).toEqual(["byokModelIds", "flags", "logoUrl", "orgName"])
    expect(JSON.stringify(body)).not.toContain("slug")
  })
})
