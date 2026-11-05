// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Discovery: the connector tools are deferred, so an agent reaches them
// through tool_search. With the app's read scope, a search for a customer's
// orders finds connector_read and loads it for the next step; without it,
// connector_read is never loaded (at most listed as locked, naming the scope).
// The app is registered for a real org from its real manifest.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const USER = "00000000-0000-0000-0000-00000000c0d1"
let ORG = ""

function frame() {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
}

async function search(query: string, scopes: string[]) {
  const f = frame()
  const res = await runContextStore.run(f, () =>
    handleToolSearch({ query }, { orgId: ORG, userId: USER, scopes }),
  )
  const read = res.matches.find((m) => m.name.endsWith("connector_read"))
  return { res, read, discovered: [...f.discoveredTools] }
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await ensureOrg({ slug: `connector-discovery-${Date.now()}`, name: "Discovery" })).orgId
  await ensureAppsForOrg(ORG)
}, 120_000)

afterAll(async () => {
  resetAppRegistries()
  await releaseTestLock()
})

describe("tool_search finds the connector tools by scope", () => {
  const QUERY = "connector read customer orders"

  it("finds and loads connector_read for a member holding api-connector:read", async () => {
    const { read, discovered } = await search(QUERY, ["kernel:threads:read", "api-connector:read"])
    expect(read).toBeDefined()
    expect(read?.locked).toBeUndefined()
    expect(read?.appName).toBe("api-connector")
    expect(discovered).toContain(read?.name ?? "")
  })

  it("never loads connector_read for a member without the scope", async () => {
    const { read, discovered } = await search(QUERY, [
      "kernel:threads:read",
      "tickets:tickets:read",
    ])
    expect(discovered.some((n) => n.endsWith("connector_read"))).toBe(false)
    if (read) {
      expect(read.locked).toBe(true)
      expect(read.requiredScope).toBe("api-connector:read")
    }
  })

  it("loads it by exact name only for the scope holder", async () => {
    const holder = await search("select:api-connector:connector_read", ["api-connector:read"])
    expect(holder.discovered.some((n) => n.endsWith("connector_read"))).toBe(true)
    const other = await search("select:api-connector:connector_read", ["tickets:tickets:read"])
    expect(other.discovered.some((n) => n.endsWith("connector_read"))).toBe(false)
  })
})
