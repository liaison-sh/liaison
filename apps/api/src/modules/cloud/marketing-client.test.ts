// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A managed server sets the instance Google Marketing client
// (GOOGLE_MARKETING_OAUTH_CLIENT_ID/SECRET): Google Ads, Merchant Center and the
// Social app's YouTube connection use it by default, and a workspace's own client
// still wins (the resolver's order, org then instance, is unchanged).
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db/connection"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import {
  resolveOAuthClient,
  resolveOAuthClientCredentials,
} from "~/modules/apps/connections/oauth-client"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { seedOrgRow } from "~/seed/factories/org/rows"

type MarketingVars = {
  GOOGLE_MARKETING_OAUTH_CLIENT_ID?: string
  GOOGLE_MARKETING_OAUTH_CLIENT_SECRET?: string
}
const mutableEnv = env as MarketingVars
const saved: MarketingVars = {
  GOOGLE_MARKETING_OAUTH_CLIENT_ID: mutableEnv.GOOGLE_MARKETING_OAUTH_CLIENT_ID,
  GOOGLE_MARKETING_OAUTH_CLIENT_SECRET: mutableEnv.GOOGLE_MARKETING_OAUTH_CLIENT_SECRET,
}
const MARKETING_ID = "marketing-client.apps.googleusercontent.com"
const MARKETING_SECRET = "marketing-secret"

let orgId: string

beforeEach(async () => {
  orgId = randomUUID()
  await seedOrgRow({ id: orgId, name: "Marketing client org", slug: `marketing-client-${orgId}` })
  _setEdition("managed")
  mutableEnv.GOOGLE_MARKETING_OAUTH_CLIENT_ID = MARKETING_ID
  mutableEnv.GOOGLE_MARKETING_OAUTH_CLIENT_SECRET = MARKETING_SECRET
})

afterEach(async () => {
  _setEdition(null)
  mutableEnv.GOOGLE_MARKETING_OAUTH_CLIENT_ID = saved.GOOGLE_MARKETING_OAUTH_CLIENT_ID
  mutableEnv.GOOGLE_MARKETING_OAUTH_CLIENT_SECRET = saved.GOOGLE_MARKETING_OAUTH_CLIENT_SECRET
  await sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
})

describe("Marketing client on a managed server (S32)", () => {
  for (const key of ["ads:google", "ads:merchant", "social:google"]) {
    it(`${key}: the instance Marketing client by default`, async () => {
      expect(await resolveOAuthClient(orgId, key)).toEqual({
        source: "instance",
        clientId: MARKETING_ID,
      })
      expect(await resolveOAuthClientCredentials(orgId, key)).toEqual({
        source: "instance",
        clientId: MARKETING_ID,
        clientSecret: MARKETING_SECRET,
      })
    })
  }

  it("ads:google: a workspace's own client still wins", async () => {
    await upsertConnectionOAuthClient({
      orgId,
      appName: "ads",
      connectionName: "google",
      clientId: "org-own-ads-client",
      clientSecret: "org-own-ads-secret",
    })
    expect(await resolveOAuthClient(orgId, "ads:google")).toEqual({
      source: "org",
      clientId: "org-own-ads-client",
    })
  })
})
