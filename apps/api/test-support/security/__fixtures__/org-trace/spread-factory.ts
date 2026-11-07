// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture for the org-id caller trace (enumerate.test.ts): a factory whose options
// object is returned by a conditional, one branch spreading the shared options
// (built from a parameter), as the sandbox's session bridge does.
import { withPrivilegedDb } from "./db"

interface Ctx {
  get(key: "orgId"): string
}
declare const app: { get(path: string, handler: (c: Ctx) => unknown): void }

interface Options {
  actor: { orgId: string }
  serial?: boolean
}

async function spreadSite(options: Options) {
  await withPrivilegedDb(options.actor.orgId, "spread-site", async () => 1)
}

function sessionBridge(bridgeOptions: { actor: { orgId: string } }, serial: boolean) {
  const shared = { ...bridgeOptions }
  const callOptions = (): Options => (serial ? { ...shared, serial: true } : shared)
  return spreadSite(callOptions())
}

app.get("/spread", (c) => sessionBridge({ actor: { orgId: c.get("orgId") } }, true))
