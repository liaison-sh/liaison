// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The webhook base an app registers its provider subscriptions on
// (`kernelPublicBaseUrl` of the connect event). With org hosts
// (LIAISON_ORG_HOST_TEMPLATE) it is the org's own host, so deliveries pass the
// edge and follow the org when it moves cell; without them it stays BASE_URL.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { createCredentialConnection, reconcileConnection } from "~/modules/apps/connections/service"

const ORG = "00000000-0000-0000-0000-000000720001"
const USER = "00000000-0000-0000-0000-000000720002"
const SLUG = "webhook-base-org"
const APP = "webhook-base-app"
const mutableEnv = env as { LIAISON_ORG_HOST_TEMPLATE?: string }
const savedTemplate = mutableEnv.LIAISON_ORG_HOST_TEMPLATE

type QueuedEvent = { entity: string; action: string; data: { kernelPublicBaseUrl?: string } }

/** Connects (or re-connects) the test account, then reconciles it; returns both events' bases. */
async function connectAndReconcile(): Promise<string[]> {
  return withPrivilegedDb(ORG, "webhook-base-test", async (tx) => {
    const events: QueuedEvent[] = []
    const original = tx.queueEvent.bind(tx)
    spyOn(tx, "queueEvent").mockImplementation(async (event) => {
      events.push(event as QueuedEvent)
      return original(event)
    })
    const account = await createCredentialConnection(tx, ORG, USER, APP, "api", {
      identifier: "acct",
      credentials: { token: "t" },
      ownerType: "org",
    })
    await reconcileConnection(tx, ORG, USER, account.id)
    return events
      .filter((e) => e.entity === "connected_account" && e.action === "create")
      .map((e) => e.data.kernelPublicBaseUrl ?? "")
  })
}

describe("connect event webhook base", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Webhook Base Org', ${SLUG})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'webhook-base@test.com', 'hash', 'Webhook', 'active')
      ON CONFLICT (id) DO NOTHING`
    connectionConfigRegistry.set([ORG, APP, "api"], {
      type: "credentials",
      allowedDomains: [],
      credentialFields: [{ name: "token", label: "Token", type: "password", required: false }],
    })
  })

  afterEach(() => {
    mutableEnv.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}`
    connectionConfigRegistry.delete([ORG, APP, "api"])
  })

  it("is the org's own host when orgs have hosts", async () => {
    mutableEnv.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.cells.example"
    expect(await connectAndReconcile()).toEqual([
      `https://${SLUG}.cells.example`,
      `https://${SLUG}.cells.example`,
    ])
  })

  it("stays BASE_URL without org hosts", async () => {
    mutableEnv.LIAISON_ORG_HOST_TEMPLATE = undefined
    expect(await connectAndReconcile()).toEqual([env.BASE_URL, env.BASE_URL])
  })
})
