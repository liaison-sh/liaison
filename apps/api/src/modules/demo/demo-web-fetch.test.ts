// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's `web_fetch` on a demo box.
//
// A demo org's fetch is a normal org's: its own lists decide, and the default
// (both empty) reads any public page. What bounds a visitor is the paid visitor
// budget and the web-read guardrails, not a demo allowlist. The SSRF guards
// (private, link-local and metadata addresses) still hold for a demo org.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  handleWebFetch,
  WebToolsTestAccess,
  webFetchPolicyRefusal,
} from "~/modules/agent/tools/web-tools"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function setOrgLists(orgId: string, allow: string[], block: string[] = []): Promise<void> {
  await withPrivilegedDb(orgId, "test-set-allowlist", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object(
          'webFetchAllowlist', ${JSON.stringify(allow)}::jsonb,
          'webFetchBlocklist', ${JSON.stringify(block)}::jsonb)
      WHERE id = ${orgId}::uuid`)
  })
}

// A public IP literal: no DNS lookup, so the test never depends on the network,
// and the fetch itself is answered by the stub below.
const PUBLIC_URL = "https://93.184.215.14/any-page"

describe("demo web_fetch policy", () => {
  let demoOrgId: string
  let fetched: string[]

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "fetch-demo", name: "Fetch Demo" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
  })

  afterAll(async () => {
    WebToolsTestAccess.setWebFetch(null)
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    WebToolsTestAccess.setWebFetch(null)
    invalidateDemoMarker()
  })

  function stubFetch(): void {
    fetched = []
    WebToolsTestAccess.setWebFetch((async (input: Request | string | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return new Response(
        "<html><head><title>Page</title></head><body><p>Hello</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      )
    }) as typeof fetch)
  }

  it("fetches an arbitrary public host for a demo org with the default empty allowlist", async () => {
    DemoModeTestAccess.set(true)
    await setOrgLists(demoOrgId, [])
    stubFetch()
    expect(await webFetchPolicyRefusal({ url: PUBLIC_URL }, { orgId: demoOrgId })).toBeNull()
    expect(
      await webFetchPolicyRefusal(
        { url: "https://single-market-economy.ec.europa.eu/battery?q=x" },
        { orgId: demoOrgId },
      ),
    ).toBeNull()
    const result = await handleWebFetch({ url: PUBLIC_URL }, { orgId: demoOrgId })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.content).toContain("Hello")
    expect(fetched.length).toBe(1)
  })

  it("still refuses private, loopback and metadata addresses for a demo org", async () => {
    DemoModeTestAccess.set(true)
    await setOrgLists(demoOrgId, [])
    stubFetch()
    for (const url of [
      "http://127.0.0.1/",
      "http://10.0.0.5/admin",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      const result = await handleWebFetch({ url }, { orgId: demoOrgId })
      expect("error" in result).toBe(true)
    }
    expect(fetched).toEqual([])
  })

  it("applies the demo org's own lists exactly as on a normal org", async () => {
    DemoModeTestAccess.set(true)
    await setOrgLists(demoOrgId, ["docs.example.com"])
    expect(
      await webFetchPolicyRefusal({ url: "https://other.example.com/" }, { orgId: demoOrgId }),
    ).toEqual({ error: "This domain is not on your organization's fetch allowlist" })
    expect(
      await webFetchPolicyRefusal({ url: "https://docs.example.com/x" }, { orgId: demoOrgId }),
    ).toBeNull()
    await setOrgLists(demoOrgId, [], ["blocked.example.com"])
    expect(
      await webFetchPolicyRefusal({ url: "https://blocked.example.com/" }, { orgId: demoOrgId }),
    ).not.toBeNull()
  })
})
