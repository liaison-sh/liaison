// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("GET /api/mcp/connect-info", () => {
  let session: minimal.Session
  let slug: string
  const saved = env.LIAISON_ORG_HOST_TEMPLATE

  beforeAll(async () => {
    await acquireTestLock()
    session = await minimal.adminSession((await createTestOrg()).id)
    const [org] = await sql<{ slug: string }[]>`
      SELECT slug FROM kernel.organizations WHERE id = ${session.orgId}`
    slug = org.slug
  })

  afterAll(async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = saved
    await releaseTestLock()
  })

  // With org hosts the call is made on the org's host (lib/org-host.ts).
  const baseUrl = async (host?: string) => {
    const res = await app.request(
      host ? `http://${host}/api/mcp/connect-info` : "/api/mcp/connect-info",
      {
        headers: {
          authorization: `Bearer ${session.bearer}`,
          ...(host ? { host } : {}),
        },
      },
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { baseUrl: string } }).data.baseUrl
  }

  it("is BASE_URL without org hosts", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = undefined
    expect(await baseUrl()).toBe(env.BASE_URL)
  })

  it("is the org's host with org hosts", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.example.com"
    expect(await baseUrl(`${slug}.example.com`)).toBe(`https://${slug}.example.com`)
  })
})
