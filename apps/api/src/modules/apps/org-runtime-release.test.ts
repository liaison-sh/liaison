// SPDX-License-Identifier: FSL-1.1-ALv2
// A peer's deletion reaches this process over Redis (`org-runtime:release`,
// S2.5 step 9): the subscriber releases the org's runtime here, as gone, so a
// later touch is a no-op. Real Redis pub/sub: the publish goes out on the
// publishing connection and comes back on the subscriber connection.
import { afterAll, describe, expect, it } from "bun:test"
import { publishRedis } from "~/lib/redis"
import {
  initializedOrgRuntimes,
  orgsKnownMissing,
  registeredApps,
} from "~/modules/apps/app-registries"
import {
  ORG_RUNTIME_RELEASE_CHANNEL,
  subscribeOrgRuntimeRelease,
} from "~/modules/apps/org-runtime-release"

const GONE = crypto.randomUUID()
const KEPT = crypto.randomUUID()

afterAll(() => {
  for (const orgId of [GONE, KEPT]) {
    initializedOrgRuntimes.delete(orgId)
    registeredApps.delete(`${orgId}:probe`)
    orgsKnownMissing.delete(orgId)
  }
})

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

describe("org-runtime:release subscriber", () => {
  it("releases a peer's deleted org in this process and leaves the others", async () => {
    await subscribeOrgRuntimeRelease()
    for (const orgId of [GONE, KEPT]) {
      initializedOrgRuntimes.add(orgId)
      registeredApps.add(`${orgId}:probe`)
    }
    await publishRedis(
      ORG_RUNTIME_RELEASE_CHANNEL,
      JSON.stringify({ orgIds: [GONE, "not-a-uuid"] }),
    )
    expect(await until(() => orgsKnownMissing.has(GONE))).toBe(true)
    expect(initializedOrgRuntimes.has(GONE)).toBe(false)
    expect(registeredApps.has(`${GONE}:probe`)).toBe(false)
    expect(initializedOrgRuntimes.has(KEPT)).toBe(true)
    expect(registeredApps.has(`${KEPT}:probe`)).toBe(true)
    expect(orgsKnownMissing.has(KEPT)).toBe(false)
  })
})
