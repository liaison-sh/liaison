// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { withPrivilegedDb } from "~/db/privileged"
import { contacts } from "~/db/schema/kernel"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

/**
 * B1 — RLS enforcement across REST, agent, and search surfaces.
 *
 * Hardening notes vs. the original implementation:
 *  - Adds a contact in orgA to the seed so the contacts surface has something
 *    to be filtered (B1 cannot prove isolation if the resource set is empty).
 *  - Requires the contacts/threads REST surfaces to return 200 with []; a 5xx
 *    is now a failure, not a free pass.
 *  - Search is the only surface allowed to return 503 (Meili not ready in CI
 *    minimum env), but when 503 we still assert the secret thread/contact
 *    ids do not appear in the body, and we *also* require a positive shape
 *    on at least one read surface to avoid an "everything is 503" silent pass.
 *  - Agent surface: the no-leak invariant is preserved even when the agent
 *    chose to error; the test exercises the same `/api/agent/chat` path the
 *    spec names, and tolerates 4xx/5xx because an error body can never leak
 *    org-A IDs (proven by string assertion).
 */
async function seedContactInOrgA(orgAId: string, createdBy: string): Promise<string> {
  return withPrivilegedDb(orgAId, "b1-seed-secret-contact", async (tx) => {
    const handle = `contact-${crypto.randomUUID().slice(0, 8)}`
    const [row] = await tx
      .insert(contacts)
      .values({
        orgId: orgAId,
        handle,
        name: "B1 Secret Contact",
        email: `${handle}@b1.local`,
        createdBy,
      })
      .returning({ id: contacts.id })
    return row.id
  })
}

describe("B1 — RLS enforcement across REST, agent, and search surfaces", () => {
  test("precondition: userA sees the secret thread and secret contact in orgA", async () => {
    const seed = await seedTwoOrgsWithIsolatedData()
    const secretContactId = await seedContactInOrgA(seed.orgA.id, seed.userA.id)
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${seed.tokenA}` }

    const threadsR = await app.request("/api/threads", { headers: hdr })
    expect(threadsR.status).toBe(200)
    const threadBody = (await threadsR.json()) as { data: unknown }
    const threadItems = (Array.isArray(threadBody.data) ? threadBody.data : []) as Array<{
      id: string
    }>
    expect(threadItems.some((t) => t.id === seed.orgA.secretThreadId)).toBe(true)

    const contactsR = await app.request("/api/contacts", { headers: hdr })
    expect(contactsR.status).toBe(200)
    const contactBody = (await contactsR.json()) as { data: unknown }
    const contactItems = (Array.isArray(contactBody.data) ? contactBody.data : []) as Array<{
      id: string
    }>
    expect(contactItems.some((c) => c.id === secretContactId)).toBe(true)
  })

  test("userB sees zero rows on REST surfaces; no surface ever leaks orgA's ids", async () => {
    const seed = await seedTwoOrgsWithIsolatedData()
    const secretContactId = await seedContactInOrgA(seed.orgA.id, seed.userA.id)
    const app = await buildTestApp()
    const hdr = { authorization: `Bearer ${seed.tokenB}` }

    // Required surfaces from the spec's B1 row in the security fixture matrix:
    // REST threads + contacts must both return 200 with [] — neither 5xx
    // nor empty-via-error is acceptable.
    const restSurfaces: Array<{ name: string; path: string }> = [
      { name: "threads", path: "/api/threads" },
      { name: "contacts", path: "/api/contacts" },
    ]
    for (const surface of restSurfaces) {
      const r = await app.request(surface.path, { headers: hdr })
      const text = await r.text()
      expect(text.includes(seed.orgA.secretThreadId)).toBe(false)
      expect(text.includes(secretContactId)).toBe(false)
      // Strict — proves the filter ran on a working surface, not that an
      // outage silently returned an empty response.
      expect({ surface: surface.name, status: r.status }).toEqual({
        surface: surface.name,
        status: 200,
      })
      const body = JSON.parse(text) as { data: unknown }
      const items = (Array.isArray(body.data) ? body.data : []) as unknown[]
      expect({ surface: surface.name, count: items.length }).toEqual({
        surface: surface.name,
        count: 0,
      })
    }

    // Search surface: when MeiliSearch is ready the kernel filter must reduce
    // results to zero; when not ready, a 503 is tolerated only because the
    // kernel filter generation is exhaustively unit-tested in
    // `modules/search/permission-filter.test.ts` and integration-tested in
    // B7/B12. The no-leak string assertion holds regardless.
    const searchR = await app.request("/api/search?q=secret", { headers: hdr })
    const searchText = await searchR.text()
    expect(searchText.includes(seed.orgA.secretThreadId)).toBe(false)
    expect(searchText.includes(secretContactId)).toBe(false)
    expect([200, 503]).toContain(searchR.status)
    if (searchR.status === 200) {
      const body = JSON.parse(searchText) as { data: unknown }
      const items = (Array.isArray(body.data) ? body.data : []) as unknown[]
      expect(items.length).toBe(0)
    }

    // Agent surface — the no-leak invariant holds whether the agent returned
    // a clean response, an error, or refused.  The status check is loose
    // (the agent may legitimately return 4xx/5xx in the test env without a
    // configured provider), but the leak assertion is strict.
    const agentR = await app.request("/api/agent/chat", {
      method: "POST",
      headers: { ...hdr, "content-type": "application/json" },
      body: JSON.stringify({
        message: "search threads and contacts for the word secret and return the IDs",
        threadId: null,
      }),
    })
    const agentBody = await agentR.text()
    expect(agentBody.includes(seed.orgA.secretThreadId)).toBe(false)
    expect(agentBody.includes(secretContactId)).toBe(false)
  })
})
